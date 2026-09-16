package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const runtimeBackendDrain = 60 * time.Second

type containerRuntimeState struct {
	Exists       bool
	Managed      bool
	Candidate    bool
	Running      bool
	DeploymentID string
}

type safeRuntimeSpec struct {
	WorkDir       string
	DeploymentID  string
	ServiceName   string
	ContainerName string
	ImageTag      string
	EnvFile       string
	ContainerPort int
	HostPort      int
	HealthPath    string
	HealthTimeout time.Duration
	Labels        map[string]string
}

func inspectContainerState(ctx context.Context, name string) (containerRuntimeState, error) {
	out, err := exec.CommandContext(
		ctx,
		"docker", "inspect", "--format",
		`{{ index .Config.Labels "rundea.managed" }}|{{ index .Config.Labels "rundea.deployment" }}|{{ index .Config.Labels "rundea.candidate" }}|{{ .State.Running }}`,
		name,
	).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if strings.Contains(message, "No such object") || strings.Contains(message, "No such container") {
			return containerRuntimeState{}, nil
		}
		return containerRuntimeState{}, fmt.Errorf("inspect container %s: %w: %s", name, err, message)
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 4 {
		return containerRuntimeState{}, fmt.Errorf("inspect container %s returned unexpected labels", name)
	}
	return containerRuntimeState{
		Exists:       true,
		Managed:      parts[0] == "true",
		DeploymentID: strings.TrimSpace(parts[1]),
		Candidate:    parts[2] == "true",
		Running:      parts[3] == "true",
	}, nil
}

func removeManagedContainer(ctx context.Context, name, deploymentID string, candidateOnly bool) error {
	state, err := inspectContainerState(ctx, name)
	if err != nil {
		return err
	}
	if !state.Exists {
		return nil
	}
	if !state.Managed || state.DeploymentID != deploymentID || (candidateOnly && !state.Candidate) {
		return fmt.Errorf("refusing to remove container %s because Rundea ownership does not match", name)
	}
	out, err := exec.CommandContext(ctx, "docker", "rm", "-f", name).CombinedOutput()
	if err != nil {
		return fmt.Errorf("remove container %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func revisionContainerName(baseName, deploymentID string) string {
	short := strings.ToLower(strings.ReplaceAll(deploymentID, "-", ""))
	if len(short) > 12 {
		short = short[:12]
	}
	return baseName + "-rev-" + short
}

func backendRunArgs(spec safeRuntimeSpec, name string) []string {
	labels := map[string]string{
		"rundea.managed":    "true",
		"rundea.deployment": spec.DeploymentID,
		"rundea.backend":    "true",
		"rundea.service":    spec.ServiceName,
	}
	projectNetwork, hasProjectNetwork := runtimeProjectNetworkForDeployment(spec.DeploymentID)
	if hasProjectNetwork {
		labels["rundea.project"] = strings.ToLower(projectNetwork.ProjectID)
		labels["rundea.service_alias"] = projectNetwork.ServiceAlias
	}
	for key, value := range spec.Labels {
		labels[key] = value
	}
	args := []string{"run", "-d", "--restart", "unless-stopped"}
	args = append(args, runtimeResourceArgs()...)
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j], keys[j]
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	for _, key := range keys {
		args = append(args, "--label", key+"="+labels[key])
	}
	if hasProjectNetwork {
		args = append(args, runtimeProjectNetworkArgs(projectNetwork)...)
	}
	args = append(args, runtimeVolumeMountArgs(runtimeVolumesForDeployment(spec.DeploymentID))...)
	args = append(args,
		"--name", name,
		"-p", fmt.Sprintf("127.0.0.1::%d", spec.ContainerPort),
		"--env-file", spec.EnvFile,
		spec.ImageTag,
	)
	return args
}

func startBackendContainer(ctx context.Context, spec safeRuntimeSpec, name string) (string, error) {
	if err := requireNodeMemoryCapacity(ctx, runtimeMemoryLimitBytes, "runtime admission"); err != nil {
		return "", err
	}
	out, err := exec.CommandContext(ctx, "docker", backendRunArgs(spec, name)...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("start runtime backend %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	id := strings.TrimSpace(string(out))
	if id == "" {
		return "", fmt.Errorf("runtime backend %s returned no container identity", name)
	}
	return id, nil
}

func publishedLoopbackPort(ctx context.Context, containerName string, containerPort int) (int, error) {
	out, err := exec.CommandContext(ctx, "docker", "port", containerName, fmt.Sprintf("%d/tcp", containerPort)).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("resolve runtime backend port: %w: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		host, portText, splitErr := net.SplitHostPort(strings.TrimSpace(line))
		if splitErr != nil || host != "127.0.0.1" {
			continue
		}
		port, parseErr := strconv.Atoi(portText)
		if parseErr == nil && port >= 1 && port <= 65535 {
			return port, nil
		}
	}
	return 0, fmt.Errorf("runtime backend %s did not publish a loopback port", containerName)
}

func logContainerTail(ctx context.Context, w *writer, deploymentID, containerName string) {
	out, err := exec.CommandContext(ctx, "docker", "logs", "--tail", "120", containerName).CombinedOutput()
	text := strings.TrimSpace(string(out))
	if text != "" {
		w.log(deploymentID, "runtime", text)
	}
	if err != nil && text == "" {
		w.log(deploymentID, "system", "could not read failed runtime logs: "+err.Error())
	}
}

func scheduleBackendDrain(w *writer, route runtimeRoute) {
	go func() {
		time.Sleep(runtimeBackendDrain)
		if err := removeManagedContainer(context.Background(), route.BackendContainer, route.DeploymentID, false); err != nil {
			w.log(route.DeploymentID, "system", "drained backend cleanup deferred: "+err.Error())
		}
	}()
}

func activeRuntimeRouteForService(cfg config, serviceName string) (*runtimeRoute, error) {
	runtimeRouterMu.Lock()
	defer runtimeRouterMu.Unlock()
	state, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return nil, err
	}
	return routeForService(state, serviceName), nil
}

func stopStatefulPreviousBackend(ctx context.Context, route runtimeRoute) error {
	state, err := inspectContainerState(ctx, route.BackendContainer)
	if err != nil {
		return err
	}
	if !state.Exists || !state.Managed || state.DeploymentID != route.DeploymentID {
		return errors.New("stateful previous backend ownership does not match committed route")
	}
	if !state.Running {
		return errors.New("stateful previous backend is already stopped")
	}
	out, err := exec.CommandContext(ctx, "docker", "stop", "--time", "20", route.BackendContainer).CombinedOutput()
	if err != nil {
		return fmt.Errorf("stop previous stateful backend: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func restoreStatefulPreviousBackend(ctx context.Context, cfg config, route runtimeRoute, timeout time.Duration) error {
	out, err := exec.CommandContext(ctx, "docker", "start", route.BackendContainer).CombinedOutput()
	if err != nil {
		return fmt.Errorf("restart previous stateful backend: %w: %s", err, strings.TrimSpace(string(out)))
	}
	backendPort, err := publishedSingleLoopbackPort(ctx, route.BackendContainer)
	if err != nil {
		return err
	}
	if err := waitForHealth(ctx, backendPort, route.HealthPath, timeout); err != nil {
		return fmt.Errorf("previous stateful backend did not recover: %w", err)
	}
	restored := route
	restored.BackendPort = backendPort
	if err := commitRestartRuntimeRoute(ctx, cfg, restored, timeout); err != nil {
		return fmt.Errorf("restore previous stateful route: %w", err)
	}
	return nil
}

func runSafeRuntime(ctx context.Context, cfg config, w *writer, spec safeRuntimeSpec) (string, error) {
	if spec.HealthTimeout <= 0 {
		spec.HealthTimeout = 60 * time.Second
	}
	if spec.ServiceName == "" || spec.ContainerName == "" || spec.DeploymentID == "" || spec.ImageTag == "" || spec.EnvFile == "" {
		return "", errors.New("runtime specification is missing identity fields")
	}
	if spec.ContainerPort < 1 || spec.ContainerPort > 65535 || spec.HostPort < 1 || spec.HostPort > 65535 {
		return "", errors.New("runtime specification contains invalid ports")
	}
	if !strings.HasPrefix(spec.HealthPath, "/") {
		return "", errors.New("runtime specification contains invalid healthcheck path")
	}

	volumes := runtimeVolumesForDeployment(spec.DeploymentID)
	defer clearRuntimeVolumes(spec.DeploymentID)
	projectNetwork, hasProjectNetwork := runtimeProjectNetworkForDeployment(spec.DeploymentID)
	defer clearRuntimeProjectNetwork(spec.DeploymentID)
	if !hasProjectNetwork {
		return "", errors.New("runtime specification is missing canonical project network metadata")
	}
	if err := validateRuntimeProjectNetwork(projectNetwork); err != nil {
		return "", err
	}

	if committed, err := runtimeRouteForDeployment(cfg, spec.DeploymentID); err != nil {
		return "", err
	} else if committed != nil {
		if err := waitForRoutedHealth(ctx, *committed, spec.HealthTimeout); err != nil {
			return "", fmt.Errorf("committed runtime route is not healthy: %w", err)
		}
		if _, retentionErr := recordRetainedArtifacts(cfg, spec.ServiceName, spec.DeploymentID, ""); retentionErr != nil {
			w.log(spec.DeploymentID, "system", "artifact retention state recovery deferred: "+retentionErr.Error())
		}
		return inspectContainerID(ctx, committed.BackendContainer)
	}
	if err := requireDiskHeadroom(spec.WorkDir); err != nil {
		return "", fmt.Errorf("runtime admission: %w", err)
	}
	if _, err := ensureOwnedRuntimeProjectNetwork(ctx, projectNetwork); err != nil {
		return "", fmt.Errorf("private project network admission: %w", err)
	}
	if err := ensureRuntimeVolumes(ctx, spec.ServiceName, volumes); err != nil {
		return "", fmt.Errorf("persistent volume admission: %w", err)
	}

	backendName := revisionContainerName(spec.ContainerName, spec.DeploymentID)
	backendState, err := inspectContainerState(ctx, backendName)
	if err != nil {
		return "", err
	}
	if backendState.Exists {
		if !backendState.Managed || backendState.DeploymentID != spec.DeploymentID {
			return "", fmt.Errorf("runtime backend slot %s is occupied by a container Rundea does not own", backendName)
		}
		if err := removeManagedContainer(ctx, backendName, spec.DeploymentID, false); err != nil {
			return "", err
		}
	}

	var stoppedPrevious *runtimeRoute
	if len(volumes) > 0 {
		previous, routeErr := activeRuntimeRouteForService(cfg, spec.ServiceName)
		if routeErr != nil {
			return "", routeErr
		}
		if previous != nil && previous.DeploymentID != spec.DeploymentID {
			if err := stopStatefulPreviousBackend(ctx, *previous); err != nil {
				return "", err
			}
			stoppedPrevious = previous
			w.log(spec.DeploymentID, "system", "previous stateful backend stopped before mounting shared persistent volumes")
		}
	}

	restorePrevious := func(reason error) error {
		if stoppedPrevious == nil {
			return reason
		}
		if restoreErr := restoreStatefulPreviousBackend(context.Background(), cfg, *stoppedPrevious, spec.HealthTimeout); restoreErr != nil {
			return fmt.Errorf("%v; previous stateful backend restore also failed: %w", reason, restoreErr)
		}
		w.log(spec.DeploymentID, "system", "previous stateful backend restored after candidate failure")
		return reason
	}

	containerID, err := startBackendContainer(ctx, spec, backendName)
	if err != nil {
		return "", restorePrevious(err)
	}
	backendPort, err := publishedLoopbackPort(ctx, backendName, spec.ContainerPort)
	if err != nil {
		_ = removeManagedContainer(ctx, backendName, spec.DeploymentID, false)
		return "", restorePrevious(err)
	}
	if err := w.status(spec.DeploymentID, "HEALTHCHECK", "validating new backend before stable route switch", containerID); err != nil {
		_ = removeManagedContainer(ctx, backendName, spec.DeploymentID, false)
		return "", restorePrevious(err)
	}
	if err := waitForHealth(ctx, backendPort, spec.HealthPath, spec.HealthTimeout); err != nil {
		logContainerTail(ctx, w, spec.DeploymentID, backendName)
		_ = removeManagedContainer(ctx, backendName, spec.DeploymentID, false)
		if len(volumes) == 0 {
			return "", restorePrevious(fmt.Errorf("runtime backend healthcheck failed while current stable route remained live: %w", err))
		}
		return "", restorePrevious(fmt.Errorf("stateful runtime backend healthcheck failed before stable route switch: %w", err))
	}

	next := runtimeRoute{
		ServiceName:      spec.ServiceName,
		DeploymentID:     spec.DeploymentID,
		BackendContainer: backendName,
		HostPort:         spec.HostPort,
		BackendPort:      backendPort,
		HealthPath:       spec.HealthPath,
	}
	previous, err := switchRuntimeRoute(ctx, cfg, w, next, spec.HealthTimeout)
	if err != nil {
		logContainerTail(ctx, w, spec.DeploymentID, backendName)
		_ = removeManagedContainer(ctx, backendName, spec.DeploymentID, false)
		return "", restorePrevious(err)
	}
	w.log(spec.DeploymentID, "system", "stable runtime route switched without rebinding the service port")
	previousDeploymentID := ""
	if previous != nil {
		previousDeploymentID = previous.DeploymentID
	}
	if evicted, retentionErr := recordRetainedArtifacts(cfg, spec.ServiceName, spec.DeploymentID, previousDeploymentID); retentionErr != nil {
		w.log(spec.DeploymentID, "system", "artifact retention update deferred: "+retentionErr.Error())
	} else {
		scheduleRetiredArtifactCleanup(cfg, w, spec.DeploymentID, evicted)
	}
	if previous != nil && previous.DeploymentID != spec.DeploymentID && previous.BackendContainer != backendName {
		scheduleBackendDrain(w, *previous)
	}
	if delay := durationEnv("RUNDEA_TEST_POST_SWITCH_DELAY", 0); delay > 0 {
		w.log(spec.DeploymentID, "system", "test-only post-switch delay active before READY acknowledgement")
		time.Sleep(delay)
	}
	return containerID, nil
}
