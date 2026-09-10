package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const runtimeRouterContainer = "rundea-runtime-router"
const runtimeRouterAdminAddress = "127.0.0.1:2020"
const runtimeRouterMarkerHeader = "X-Rundea-Deployment"
const runtimeRouterCommittedConfig = "Caddyfile"
const runtimeRouterCandidateConfig = "Caddyfile.next"

var runtimeRouterMu sync.Mutex

type runtimeRoute struct {
	ServiceName      string `json:"serviceName"`
	DeploymentID     string `json:"deploymentId"`
	BackendContainer string `json:"backendContainer"`
	HostPort         int    `json:"hostPort"`
	BackendPort      int    `json:"backendPort"`
	HealthPath       string `json:"healthPath"`
}

type runtimeRouterState struct {
	Version int            `json:"version"`
	Routes  []runtimeRoute `json:"routes"`
}

type runtimePromotionMarker struct {
	Previous *runtimeRoute `json:"previous,omitempty"`
	Next     runtimeRoute  `json:"next"`
}

func runtimeRouterDir(cfg config) string {
	return filepath.Join(cfg.WorkDir, "runtime-router")
}

func runtimeRouterStatePath(cfg config) string {
	return filepath.Join(runtimeRouterDir(cfg), "routes.json")
}

func runtimeRouterConfigPath(cfg config, name string) string {
	return filepath.Join(runtimeRouterDir(cfg), name)
}

func runtimePromotionDir(cfg config) string {
	return filepath.Join(runtimeRouterDir(cfg), "promotions")
}

func runtimePromotionPath(cfg config, deploymentID string) string {
	return filepath.Join(runtimePromotionDir(cfg), strings.ToLower(deploymentID)+".json")
}

func validateRuntimeRoute(route runtimeRoute) error {
	if strings.TrimSpace(route.ServiceName) == "" || strings.TrimSpace(route.BackendContainer) == "" {
		return errors.New("runtime route is missing service identity")
	}
	if !reconciliationIDPattern.MatchString(strings.ToLower(route.DeploymentID)) {
		return errors.New("runtime route has invalid deployment identity")
	}
	if route.HostPort < 1 || route.HostPort > 65535 || route.BackendPort < 1 || route.BackendPort > 65535 {
		return errors.New("runtime route contains an invalid port")
	}
	if route.HostPort == 80 || route.HostPort == 443 || route.HostPort == 2019 || route.HostPort == 2020 {
		return fmt.Errorf("host port %d is reserved by Rundea routing", route.HostPort)
	}
	if !strings.HasPrefix(route.HealthPath, "/") || len(route.HealthPath) > 512 || strings.ContainsAny(route.HealthPath, "\r\n") {
		return errors.New("runtime route contains an invalid healthcheck path")
	}
	return nil
}

func validateRuntimeRouterState(state runtimeRouterState) error {
	if state.Version != 1 {
		return fmt.Errorf("unsupported runtime router state version %d", state.Version)
	}
	services := map[string]struct{}{}
	ports := map[int]struct{}{}
	for _, route := range state.Routes {
		if err := validateRuntimeRoute(route); err != nil {
			return err
		}
		if _, exists := services[route.ServiceName]; exists {
			return fmt.Errorf("duplicate runtime route for service %s", route.ServiceName)
		}
		if _, exists := ports[route.HostPort]; exists {
			return fmt.Errorf("duplicate runtime listener port %d", route.HostPort)
		}
		services[route.ServiceName] = struct{}{}
		ports[route.HostPort] = struct{}{}
	}
	return nil
}

func loadRuntimeRouterState(cfg config) (runtimeRouterState, error) {
	payload, err := os.ReadFile(runtimeRouterStatePath(cfg))
	if errors.Is(err, os.ErrNotExist) {
		return runtimeRouterState{Version: 1, Routes: []runtimeRoute{}}, nil
	}
	if err != nil {
		return runtimeRouterState{}, err
	}
	var state runtimeRouterState
	if err := json.Unmarshal(payload, &state); err != nil {
		return runtimeRouterState{}, fmt.Errorf("decode runtime router state: %w", err)
	}
	if err := validateRuntimeRouterState(state); err != nil {
		return runtimeRouterState{}, err
	}
	return state, nil
}

func writeRuntimeRouterState(cfg config, state runtimeRouterState) error {
	if err := validateRuntimeRouterState(state); err != nil {
		return err
	}
	if err := os.MkdirAll(runtimeRouterDir(cfg), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return writeAtomic(runtimeRouterStatePath(cfg), payload, 0o600)
}

func routeForService(state runtimeRouterState, serviceName string) *runtimeRoute {
	for _, route := range state.Routes {
		if route.ServiceName == serviceName {
			copy := route
			return &copy
		}
	}
	return nil
}

func routeForDeployment(state runtimeRouterState, deploymentID string) *runtimeRoute {
	for _, route := range state.Routes {
		if route.DeploymentID == deploymentID {
			copy := route
			return &copy
		}
	}
	return nil
}

func upsertRuntimeRoute(state runtimeRouterState, next runtimeRoute) (runtimeRouterState, error) {
	if err := validateRuntimeRoute(next); err != nil {
		return runtimeRouterState{}, err
	}
	result := runtimeRouterState{Version: 1, Routes: make([]runtimeRoute, 0, len(state.Routes)+1)}
	for _, route := range state.Routes {
		if route.ServiceName == next.ServiceName {
			continue
		}
		if route.HostPort == next.HostPort {
			return runtimeRouterState{}, fmt.Errorf("stable port %d already belongs to service %s", next.HostPort, route.ServiceName)
		}
		result.Routes = append(result.Routes, route)
	}
	result.Routes = append(result.Routes, next)
	if err := validateRuntimeRouterState(result); err != nil {
		return runtimeRouterState{}, err
	}
	return result, nil
}

func renderRuntimeRouterCaddyfile(state runtimeRouterState) string {
	routes := append([]runtimeRoute(nil), state.Routes...)
	sort.Slice(routes, func(i, j int) bool { return routes[i].HostPort < routes[j].HostPort })
	var builder strings.Builder
	builder.WriteString("{\n\tadmin ")
	builder.WriteString(runtimeRouterAdminAddress)
	builder.WriteString("\n}\n\n")
	for _, route := range routes {
		builder.WriteString("http://127.0.0.1:")
		builder.WriteString(strconv.Itoa(route.HostPort))
		builder.WriteString(" {\n\treverse_proxy 127.0.0.1:")
		builder.WriteString(strconv.Itoa(route.BackendPort))
		builder.WriteString(" {\n\t\theader_down ")
		builder.WriteString(runtimeRouterMarkerHeader)
		builder.WriteByte(' ')
		builder.WriteString(route.DeploymentID)
		builder.WriteString("\n\t}\n}\n\n")
	}
	return builder.String()
}

func ensureRuntimeRouterDir(cfg config) (string, error) {
	routerDir := runtimeRouterDir(cfg)
	if err := os.MkdirAll(routerDir, 0o700); err != nil {
		return "", err
	}
	return routerDir, nil
}

func writeRuntimeRouterConfig(cfg config, state runtimeRouterState, name string) error {
	if err := validateRuntimeRouterState(state); err != nil {
		return err
	}
	if _, err := ensureRuntimeRouterDir(cfg); err != nil {
		return err
	}
	return writeAtomic(runtimeRouterConfigPath(cfg, name), []byte(renderRuntimeRouterCaddyfile(state)), 0o600)
}

func validateRuntimeRouterConfig(cfg config, name string) error {
	routerDir := runtimeRouterDir(cfg)
	mount := routerDir + ":/etc/caddy:ro"
	args := caddyDockerRunArgs(
		[]string{"--rm", "-v", mount},
		"validate", "--config", "/etc/caddy/"+name, "--adapter", "caddyfile",
	)
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("runtime router Caddy validation failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func runtimeRouterRunning() (bool, error) {
	inspect, err := exec.Command(
		"docker", "inspect", "-f",
		`{{.Config.Image}}|{{ index .Config.Labels "rundea.managed" }}|{{ index .Config.Labels "rundea.role" }}|{{ .State.Running }}`,
		runtimeRouterContainer,
	).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(inspect))
		if strings.Contains(message, "No such object") || strings.Contains(message, "No such container") {
			return false, nil
		}
		return false, fmt.Errorf("inspect runtime router: %w: %s", err, message)
	}
	parts := strings.Split(strings.TrimSpace(string(inspect)), "|")
	if len(parts) != 4 || parts[0] != caddyImage || parts[1] != "true" || parts[2] != "runtime-router" {
		return false, errors.New("runtime router container identity does not match Rundea ownership")
	}
	if parts[3] != "true" {
		out, startErr := exec.Command("docker", "start", runtimeRouterContainer).CombinedOutput()
		if startErr != nil {
			return false, fmt.Errorf("start runtime router: %w: %s", startErr, strings.TrimSpace(string(out)))
		}
	}
	return true, nil
}

func reloadRuntimeRouter(name string) error {
	out, err := exec.Command(
		"docker", "exec", runtimeRouterContainer, "caddy", "reload",
		"--config", "/etc/caddy/"+name, "--adapter", "caddyfile", "--address", runtimeRouterAdminAddress,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("runtime router reload failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func startRuntimeRouter(cfg config, configName string, restartPolicy string) error {
	routerDir, err := ensureRuntimeRouterDir(cfg)
	if err != nil {
		return err
	}
	_ = exec.Command("docker", "rm", "-f", runtimeRouterContainer).Run()
	args := caddyDockerRunArgs(
		[]string{
			"-d", "--name", runtimeRouterContainer, "--restart", restartPolicy, "--network", "host",
			"--label", "rundea.managed=true", "--label", "rundea.role=runtime-router",
			"-v", routerDir + ":/etc/caddy:ro",
		},
		"run", "--config", "/etc/caddy/"+configName, "--adapter", "caddyfile",
	)
	out, runErr := exec.Command("docker", args...).CombinedOutput()
	if runErr != nil {
		return fmt.Errorf("runtime router start failed: %w: %s", runErr, strings.TrimSpace(string(out)))
	}
	return nil
}

func removeRuntimeRouter() error {
	out, err := exec.Command("docker", "rm", "-f", runtimeRouterContainer).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "No such container") {
		return fmt.Errorf("remove empty runtime router: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func applyCommittedRuntimeRouterState(cfg config, state runtimeRouterState) error {
	if err := writeRuntimeRouterConfig(cfg, state, runtimeRouterCommittedConfig); err != nil {
		return err
	}
	if err := validateRuntimeRouterConfig(cfg, runtimeRouterCommittedConfig); err != nil {
		return err
	}
	if len(state.Routes) == 0 {
		return removeRuntimeRouter()
	}
	running, err := runtimeRouterRunning()
	if err != nil {
		return err
	}
	if running {
		return reloadRuntimeRouter(runtimeRouterCommittedConfig)
	}
	return startRuntimeRouter(cfg, runtimeRouterCommittedConfig, "unless-stopped")
}

func applyCandidateRuntimeRouterState(cfg config, state runtimeRouterState) (bool, error) {
	running, err := runtimeRouterRunning()
	if err != nil {
		return false, err
	}
	if running {
		if err := writeRuntimeRouterConfig(cfg, state, runtimeRouterCandidateConfig); err != nil {
			return false, err
		}
		if err := validateRuntimeRouterConfig(cfg, runtimeRouterCandidateConfig); err != nil {
			return false, err
		}
		return false, reloadRuntimeRouter(runtimeRouterCandidateConfig)
	}

	// There is no existing stable listener to preserve on the first service.
	// Use the durable filename but keep Docker restart disabled until the route
	// state commit succeeds. A host reboot before commit therefore cannot start
	// this uncommitted router; Agent recovery rewrites the committed file first.
	if err := writeRuntimeRouterConfig(cfg, state, runtimeRouterCommittedConfig); err != nil {
		return false, err
	}
	if err := validateRuntimeRouterConfig(cfg, runtimeRouterCommittedConfig); err != nil {
		return false, err
	}
	if err := startRuntimeRouter(cfg, runtimeRouterCommittedConfig, "no"); err != nil {
		return false, err
	}
	return true, nil
}

func promoteCandidateRuntimeRouterConfig(cfg config, firstRouter bool) error {
	if !firstRouter {
		candidate := runtimeRouterConfigPath(cfg, runtimeRouterCandidateConfig)
		committed := runtimeRouterConfigPath(cfg, runtimeRouterCommittedConfig)
		if err := os.Rename(candidate, committed); err != nil {
			return err
		}
	}
	out, err := exec.Command("docker", "update", "--restart", "unless-stopped", runtimeRouterContainer).CombinedOutput()
	if err != nil {
		return fmt.Errorf("make committed runtime router durable: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func discardCandidateRuntimeRouterConfig(cfg config) {
	_ = os.Remove(runtimeRouterConfigPath(cfg, runtimeRouterCandidateConfig))
}

func writeRuntimePromotionMarker(cfg config, marker runtimePromotionMarker) error {
	if err := validateRuntimeRoute(marker.Next); err != nil {
		return err
	}
	if marker.Previous != nil {
		if err := validateRuntimeRoute(*marker.Previous); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(runtimePromotionDir(cfg), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	return writeAtomic(runtimePromotionPath(cfg, marker.Next.DeploymentID), payload, 0o600)
}

func clearRuntimePromotionMarker(cfg config, deploymentID string) error {
	err := os.Remove(runtimePromotionPath(cfg, deploymentID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func waitForRoutedHealth(ctx context.Context, route runtimeRoute, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d%s", route.HostPort, route.HealthPath)
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 3 * time.Second}
	var lastErr error
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 400 && resp.Header.Get(runtimeRouterMarkerHeader) == route.DeploymentID {
				return nil
			}
			if resp.Header.Get(runtimeRouterMarkerHeader) != route.DeploymentID {
				lastErr = errors.New("stable runtime router still points to a different deployment")
			} else {
				lastErr = fmt.Errorf("stable runtime router returned %s", resp.Status)
			}
		} else {
			lastErr = err
		}
		time.Sleep(150 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = errors.New("stable runtime router verification timed out")
	}
	return lastErr
}

func switchRuntimeRoute(ctx context.Context, cfg config, w *writer, next runtimeRoute, timeout time.Duration) (*runtimeRoute, error) {
	runtimeRouterMu.Lock()
	defer runtimeRouterMu.Unlock()

	state, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return nil, err
	}
	previous := routeForService(state, next.ServiceName)
	nextState, err := upsertRuntimeRoute(state, next)
	if err != nil {
		return nil, err
	}
	marker := runtimePromotionMarker{Previous: previous, Next: next}
	if err := writeRuntimePromotionMarker(cfg, marker); err != nil {
		return nil, fmt.Errorf("persist runtime promotion marker: %w", err)
	}

	restore := func(reason error) error {
		discardCandidateRuntimeRouterConfig(cfg)
		restoreErr := applyCommittedRuntimeRouterState(cfg, state)
		if restoreErr == nil {
			_ = clearRuntimePromotionMarker(cfg, next.DeploymentID)
			return reason
		}
		return fmt.Errorf("%v; previous runtime route restore also failed: %w", reason, restoreErr)
	}

	firstRouter, err := applyCandidateRuntimeRouterState(cfg, nextState)
	if err != nil {
		return nil, restore(fmt.Errorf("apply candidate runtime route: %w", err))
	}
	if err := waitForRoutedHealth(ctx, next, timeout); err != nil {
		return nil, restore(fmt.Errorf("verify stable runtime route: %w", err))
	}
	if err := writeRuntimeRouterState(cfg, nextState); err != nil {
		return nil, restore(fmt.Errorf("commit runtime route state: %w", err))
	}
	if err := promoteCandidateRuntimeRouterConfig(cfg, firstRouter); err != nil {
		// routes.json is the commit point. Keep the live route and marker; startup
		// recovery regenerates the durable Caddyfile from state before any stopped
		// runtime-router container can be started.
		w.log(next.DeploymentID, "system", "runtime route committed but router durability update was deferred: "+err.Error())
		return previous, nil
	}
	if err := clearRuntimePromotionMarker(cfg, next.DeploymentID); err != nil {
		w.log(next.DeploymentID, "system", "runtime route committed but promotion marker cleanup was deferred: "+err.Error())
	}
	return previous, nil
}

func runtimeRouteForDeployment(cfg config, deploymentID string) (*runtimeRoute, error) {
	runtimeRouterMu.Lock()
	defer runtimeRouterMu.Unlock()
	state, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return nil, err
	}
	return routeForDeployment(state, deploymentID), nil
}

func inspectContainerID(ctx context.Context, name string) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "--format", "{{.Id}}", name).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("inspect container %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	id := strings.TrimSpace(string(out))
	if id == "" {
		return "", fmt.Errorf("container %s returned no identity", name)
	}
	return id, nil
}

func recoverRuntimeRouter(cfg config, w *writer) error {
	runtimeRouterMu.Lock()
	state, err := loadRuntimeRouterState(cfg)
	if err != nil {
		runtimeRouterMu.Unlock()
		return err
	}

	promotionDir := runtimePromotionDir(cfg)
	entries, readErr := os.ReadDir(promotionDir)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		runtimeRouterMu.Unlock()
		return readErr
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(promotionDir, entry.Name())
		payload, err := os.ReadFile(path)
		if err != nil {
			runtimeRouterMu.Unlock()
			return err
		}
		var marker runtimePromotionMarker
		if err := json.Unmarshal(payload, &marker); err != nil || validateRuntimeRoute(marker.Next) != nil {
			runtimeRouterMu.Unlock()
			return fmt.Errorf("invalid runtime promotion marker %s", entry.Name())
		}
		committed := routeForService(state, marker.Next.ServiceName)
		if committed == nil || committed.DeploymentID != marker.Next.DeploymentID {
			_ = removeManagedContainer(context.Background(), marker.Next.BackendContainer, marker.Next.DeploymentID, false)
			_ = w.status(marker.Next.DeploymentID, "FAILED", "agent recovered an interrupted runtime switch before commit; previous route retained", "")
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			runtimeRouterMu.Unlock()
			return err
		}
	}

	// routes.json is authoritative across reboot. Regenerate the startup config
	// before runtimeRouterRunning is allowed to start an existing stopped router.
	discardCandidateRuntimeRouterConfig(cfg)
	if err := applyCommittedRuntimeRouterState(cfg, state); err != nil {
		runtimeRouterMu.Unlock()
		return fmt.Errorf("reconcile committed runtime router state: %w", err)
	}
	routes := append([]runtimeRoute(nil), state.Routes...)
	runtimeRouterMu.Unlock()

	ctx := context.Background()
	for _, route := range routes {
		if err := waitForRoutedHealth(ctx, route, 12*time.Second); err != nil {
			w.log(route.DeploymentID, "system", "runtime route recovery verification failed: "+err.Error())
			continue
		}
		containerID, err := inspectContainerID(ctx, route.BackendContainer)
		if err != nil {
			w.log(route.DeploymentID, "system", "runtime route recovered but backend identity could not be read: "+err.Error())
			continue
		}
		if err := w.send(map[string]any{
			"type": "runtimeRecovered",
			"deploymentId": route.DeploymentID,
			"containerId": containerID,
			"at": time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			return fmt.Errorf("publish recovered runtime %s: %w", route.DeploymentID, err)
		}
	}
	return nil
}
