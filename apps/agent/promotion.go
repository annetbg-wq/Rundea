package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const promotionBackupSuffix = "-promotion-backup"

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
	ContainerName string
	ImageTag      string
	EnvFile       string
	ContainerPort int
	HostPort      int
	HealthPath    string
	HealthTimeout time.Duration
	Labels        map[string]string
}

type promotionMarker struct {
	ContainerName        string `json:"containerName"`
	BackupName           string `json:"backupName"`
	PreviousDeploymentID string `json:"previousDeploymentId"`
	NewDeploymentID      string `json:"newDeploymentId"`
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

func candidateContainerName(containerName, deploymentID string) string {
	short := strings.ToLower(strings.ReplaceAll(deploymentID, "-", ""))
	if len(short) > 12 {
		short = short[:12]
	}
	return containerName + "-candidate-" + short
}

func containerRunArgs(spec safeRuntimeSpec, name string, hostPort int, candidate bool) []string {
	restartPolicy := "unless-stopped"
	if candidate {
		restartPolicy = "no"
	}
	args := []string{"run", "-d", "--restart", restartPolicy}
	labels := map[string]string{
		"rundea.managed":    "true",
		"rundea.deployment": spec.DeploymentID,
	}
	for key, value := range spec.Labels {
		labels[key] = value
	}
	if candidate {
		labels["rundea.candidate"] = "true"
	}
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		args = append(args, "--label", key+"="+labels[key])
	}
	args = append(args, "--name", name)
	if hostPort == 0 {
		args = append(args, "-p", fmt.Sprintf("127.0.0.1::%d", spec.ContainerPort))
	} else {
		args = append(args, "-p", fmt.Sprintf("127.0.0.1:%d:%d", hostPort, spec.ContainerPort))
	}
	args = append(args, "--env-file", spec.EnvFile, spec.ImageTag)
	return args
}

func startRuntimeContainer(ctx context.Context, spec safeRuntimeSpec, name string, hostPort int, candidate bool) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", containerRunArgs(spec, name, hostPort, candidate)...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker run %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	id := strings.TrimSpace(string(out))
	if id == "" {
		return "", fmt.Errorf("docker run %s returned no container identity", name)
	}
	return id, nil
}

func publishedLoopbackPort(ctx context.Context, containerName string, containerPort int) (int, error) {
	out, err := exec.CommandContext(ctx, "docker", "port", containerName, fmt.Sprintf("%d/tcp", containerPort)).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("resolve candidate port: %w: %s", err, strings.TrimSpace(string(out)))
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
	return 0, fmt.Errorf("candidate container %s did not publish a loopback port", containerName)
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

func promotionMarkerPath(workDir, containerName string) string {
	return filepath.Join(workDir, "promotions", containerName+".json")
}

func writePromotionMarker(workDir string, marker promotionMarker) error {
	dir := filepath.Join(workDir, "promotions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	path := promotionMarkerPath(workDir, marker.ContainerName)
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func clearPromotionMarker(workDir, containerName string) error {
	err := os.Remove(promotionMarkerPath(workDir, containerName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func recoverInterruptedPromotions(ctx context.Context, workDir string, w *writer) error {
	dir := filepath.Join(workDir, "promotions")
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		payload, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		var marker promotionMarker
		if json.Unmarshal(payload, &marker) != nil || marker.ContainerName == "" || marker.BackupName == "" || marker.PreviousDeploymentID == "" || marker.NewDeploymentID == "" {
			return fmt.Errorf("invalid promotion recovery marker %s", entry.Name())
		}
		backup, inspectErr := inspectContainerState(ctx, marker.BackupName)
		if inspectErr != nil {
			return inspectErr
		}
		current, inspectErr := inspectContainerState(ctx, marker.ContainerName)
		if inspectErr != nil {
			return inspectErr
		}
		if backup.Exists {
			if !backup.Managed || backup.Candidate || backup.DeploymentID != marker.PreviousDeploymentID {
				return fmt.Errorf("promotion recovery backup %s failed ownership validation", marker.BackupName)
			}
			if current.Exists {
				if !current.Managed || current.Candidate || current.DeploymentID != marker.NewDeploymentID {
					return fmt.Errorf("promotion recovery current container %s is ambiguous", marker.ContainerName)
				}
				if err := removeManagedContainer(ctx, marker.ContainerName, marker.NewDeploymentID, false); err != nil {
					return err
				}
			}
			if out, renameErr := exec.CommandContext(ctx, "docker", "rename", marker.BackupName, marker.ContainerName).CombinedOutput(); renameErr != nil {
				return fmt.Errorf("recover interrupted promotion name: %w: %s", renameErr, strings.TrimSpace(string(out)))
			}
			if !backup.Running {
				if out, startErr := exec.CommandContext(ctx, "docker", "start", marker.ContainerName).CombinedOutput(); startErr != nil {
					return fmt.Errorf("recover interrupted promotion runtime: %w: %s", startErr, strings.TrimSpace(string(out)))
				}
			}
			w.log(marker.NewDeploymentID, "system", "recovered previous revision after interrupted promotion")
			go streamRuntimeLogs(context.Background(), w, marker.PreviousDeploymentID, marker.ContainerName)
		} else if current.Exists {
			if !current.Managed || current.Candidate || current.DeploymentID != marker.NewDeploymentID {
				return fmt.Errorf("promotion marker %s has no valid backup and an ambiguous current container", entry.Name())
			}
			w.log(marker.NewDeploymentID, "system", "promotion marker survived without its fallback; keeping the running managed revision")
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func reconcilePromotionBaseline(ctx context.Context, w *writer, spec safeRuntimeSpec) (containerRuntimeState, error) {
	current, err := inspectContainerState(ctx, spec.ContainerName)
	if err != nil {
		return containerRuntimeState{}, err
	}
	backupName := spec.ContainerName + promotionBackupSuffix
	backup, err := inspectContainerState(ctx, backupName)
	if err != nil {
		return containerRuntimeState{}, err
	}

	if current.Exists {
		if !current.Managed || current.Candidate || current.DeploymentID == "" {
			return containerRuntimeState{}, errors.New("service runtime slot is occupied by a container Rundea cannot safely promote")
		}
		if !current.Running {
			if out, startErr := exec.CommandContext(ctx, "docker", "start", spec.ContainerName).CombinedOutput(); startErr != nil {
				return containerRuntimeState{}, fmt.Errorf("restart current managed revision before promotion: %w: %s", startErr, strings.TrimSpace(string(out)))
			}
			current.Running = true
			w.log(spec.DeploymentID, "system", "restarted current managed revision before candidate validation")
		}
		if backup.Exists {
			if !backup.Managed || backup.Candidate || backup.DeploymentID == "" {
				return containerRuntimeState{}, errors.New("stale promotion backup failed Rundea ownership validation")
			}
			if err := removeManagedContainer(ctx, backupName, backup.DeploymentID, false); err != nil {
				return containerRuntimeState{}, err
			}
			w.log(spec.DeploymentID, "system", "removed stale promotion backup after a previously healthy cutover")
		}
		return current, nil
	}

	if backup.Exists {
		if !backup.Managed || backup.Candidate || backup.DeploymentID == "" {
			return containerRuntimeState{}, errors.New("orphaned promotion backup failed Rundea ownership validation")
		}
		if out, renameErr := exec.CommandContext(ctx, "docker", "rename", backupName, spec.ContainerName).CombinedOutput(); renameErr != nil {
			return containerRuntimeState{}, fmt.Errorf("restore orphaned promotion backup: %w: %s", renameErr, strings.TrimSpace(string(out)))
		}
		if !backup.Running {
			if out, startErr := exec.CommandContext(ctx, "docker", "start", spec.ContainerName).CombinedOutput(); startErr != nil {
				return containerRuntimeState{}, fmt.Errorf("restart orphaned promotion backup: %w: %s", startErr, strings.TrimSpace(string(out)))
			}
		}
		w.log(spec.DeploymentID, "system", "restored orphaned previous revision before candidate validation")
		return containerRuntimeState{Exists: true, Managed: true, Running: true, DeploymentID: backup.DeploymentID}, nil
	}

	return containerRuntimeState{}, nil
}

func runSafeRuntime(ctx context.Context, w *writer, spec safeRuntimeSpec) (string, error) {
	if spec.HealthTimeout <= 0 {
		spec.HealthTimeout = 60 * time.Second
	}
	if err := recoverInterruptedPromotions(ctx, spec.WorkDir, w); err != nil {
		return "", fmt.Errorf("recover interrupted promotion: %w", err)
	}
	current, err := reconcilePromotionBaseline(ctx, w, spec)
	if err != nil {
		return "", err
	}

	if current.Exists {
		candidateName := candidateContainerName(spec.ContainerName, spec.DeploymentID)
		candidateState, err := inspectContainerState(ctx, candidateName)
		if err != nil {
			return "", err
		}
		if candidateState.Exists {
			if err := removeManagedContainer(ctx, candidateName, spec.DeploymentID, true); err != nil {
				return "", err
			}
		}
		candidateID, err := startRuntimeContainer(ctx, spec, candidateName, 0, true)
		if err != nil {
			return "", err
		}
		candidatePort, err := publishedLoopbackPort(ctx, candidateName, spec.ContainerPort)
		if err != nil {
			_ = removeManagedContainer(ctx, candidateName, spec.DeploymentID, true)
			return "", err
		}
		if err := w.status(spec.DeploymentID, "HEALTHCHECK", "validating candidate while previous READY revision stays live", candidateID); err != nil {
			_ = removeManagedContainer(ctx, candidateName, spec.DeploymentID, true)
			return "", err
		}
		if err := waitForHealth(ctx, candidatePort, spec.HealthPath, spec.HealthTimeout); err != nil {
			logContainerTail(ctx, w, spec.DeploymentID, candidateName)
			_ = removeManagedContainer(ctx, candidateName, spec.DeploymentID, true)
			return "", fmt.Errorf("candidate healthcheck failed while previous READY revision remained live: %w", err)
		}
		if err := removeManagedContainer(ctx, candidateName, spec.DeploymentID, true); err != nil {
			return "", err
		}
		w.log(spec.DeploymentID, "system", "candidate healthcheck passed; starting short stable-port cutover")
	}

	backupName := spec.ContainerName + promotionBackupSuffix
	backupExists := false
	previousDeploymentID := ""
	if current.Exists {
		previousDeploymentID = current.DeploymentID
		marker := promotionMarker{
			ContainerName:        spec.ContainerName,
			BackupName:           backupName,
			PreviousDeploymentID: previousDeploymentID,
			NewDeploymentID:      spec.DeploymentID,
		}
		if err := writePromotionMarker(spec.WorkDir, marker); err != nil {
			return "", fmt.Errorf("persist promotion recovery marker: %w", err)
		}
		out, err := exec.CommandContext(ctx, "docker", "rename", spec.ContainerName, backupName).CombinedOutput()
		if err != nil {
			_ = clearPromotionMarker(spec.WorkDir, spec.ContainerName)
			return "", fmt.Errorf("preserve previous READY revision: %w: %s", err, strings.TrimSpace(string(out)))
		}
		backupExists = true
		if out, err := exec.CommandContext(ctx, "docker", "stop", backupName).CombinedOutput(); err != nil {
			_ = exec.CommandContext(ctx, "docker", "rename", backupName, spec.ContainerName).Run()
			_ = clearPromotionMarker(spec.WorkDir, spec.ContainerName)
			return "", fmt.Errorf("stop previous READY revision for stable-port cutover: %w: %s", err, strings.TrimSpace(string(out)))
		}
	}

	restore := func() error {
		_ = removeManagedContainer(ctx, spec.ContainerName, spec.DeploymentID, false)
		if !backupExists {
			return nil
		}
		out, renameErr := exec.CommandContext(ctx, "docker", "rename", backupName, spec.ContainerName).CombinedOutput()
		if renameErr != nil {
			return fmt.Errorf("restore previous container name: %w: %s", renameErr, strings.TrimSpace(string(out)))
		}
		out, startErr := exec.CommandContext(ctx, "docker", "start", spec.ContainerName).CombinedOutput()
		if startErr != nil {
			return fmt.Errorf("restart previous READY revision: %w: %s", startErr, strings.TrimSpace(string(out)))
		}
		backupExists = false
		if err := clearPromotionMarker(spec.WorkDir, spec.ContainerName); err != nil {
			return fmt.Errorf("clear promotion marker after restore: %w", err)
		}
		go streamRuntimeLogs(context.Background(), w, previousDeploymentID, spec.ContainerName)
		return nil
	}

	containerID, err := startRuntimeContainer(ctx, spec, spec.ContainerName, spec.HostPort, false)
	if err != nil {
		restoreErr := restore()
		if restoreErr != nil {
			return "", fmt.Errorf("stable-port start failed: %w; previous READY revision restore also failed: %v", err, restoreErr)
		}
		if current.Exists {
			return "", fmt.Errorf("stable-port start failed: %w; previous READY revision restored", err)
		}
		return "", err
	}
	if err := w.status(spec.DeploymentID, "HEALTHCHECK", "validating revision on the stable service port", containerID); err != nil {
		_ = restore()
		return "", err
	}
	if err := waitForHealth(ctx, spec.HostPort, spec.HealthPath, spec.HealthTimeout); err != nil {
		logContainerTail(ctx, w, spec.DeploymentID, spec.ContainerName)
		restoreErr := restore()
		if restoreErr != nil {
			return "", fmt.Errorf("promoted revision healthcheck failed: %w; previous READY revision restore also failed: %v", err, restoreErr)
		}
		if current.Exists {
			return "", fmt.Errorf("promoted revision healthcheck failed: %w; previous READY revision restored", err)
		}
		return "", err
	}

	if backupExists {
		if err := clearPromotionMarker(spec.WorkDir, spec.ContainerName); err != nil {
			restoreErr := restore()
			if restoreErr != nil {
				return "", fmt.Errorf("healthy cutover could not clear recovery marker: %w; previous revision restore also failed: %v", err, restoreErr)
			}
			return "", fmt.Errorf("healthy cutover could not clear recovery marker: %w; previous READY revision restored", err)
		}
		if err := removeManagedContainer(ctx, backupName, previousDeploymentID, false); err != nil {
			w.log(spec.DeploymentID, "system", "healthy cutover completed but stale fallback cleanup was deferred: "+err.Error())
		}
	}
	return containerID, nil
}
