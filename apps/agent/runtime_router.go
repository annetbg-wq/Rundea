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

func validateRuntimeRouterConfig(routerDir string) error {
	mount := routerDir + ":/etc/caddy:ro"
	out, err := exec.Command("docker", "run", "--rm", "-v", mount, caddyImage, "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile").CombinedOutput()
	if err != nil {
		return fmt.Errorf("runtime router Caddy validation failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func ensureRuntimeRouter(routerDir, dataDir, configDir string) error {
	inspect, err := exec.Command("docker", "inspect", "-f", `{{.Config.Image}}|{{ index .Config.Labels "rundea.role" }}`, runtimeRouterContainer).CombinedOutput()
	if err == nil && strings.TrimSpace(string(inspect)) == caddyImage+"|runtime-router" {
		out, reloadErr := exec.Command(
			"docker", "exec", runtimeRouterContainer, "caddy", "reload",
			"--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile", "--address", runtimeRouterAdminAddress,
		).CombinedOutput()
		if reloadErr != nil {
			return fmt.Errorf("runtime router reload failed: %w: %s", reloadErr, strings.TrimSpace(string(out)))
		}
		return nil
	}

	_ = exec.Command("docker", "rm", "-f", runtimeRouterContainer).Run()
	args := []string{
		"run", "-d", "--name", runtimeRouterContainer, "--restart", "unless-stopped", "--network", "host",
		"--label", "rundea.managed=true", "--label", "rundea.role=runtime-router",
		"-v", routerDir + ":/etc/caddy:ro", "-v", dataDir + ":/data", "-v", configDir + ":/config",
		caddyImage, "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	}
	out, runErr := exec.Command("docker", args...).CombinedOutput()
	if runErr != nil {
		return fmt.Errorf("runtime router start failed: %w: %s", runErr, strings.TrimSpace(string(out)))
	}
	return nil
}

func applyRuntimeRouterState(cfg config, state runtimeRouterState) error {
	if err := validateRuntimeRouterState(state); err != nil {
		return err
	}
	routerDir := runtimeRouterDir(cfg)
	dataDir := filepath.Join(cfg.WorkDir, "runtime-router-data")
	configDir := filepath.Join(cfg.WorkDir, "runtime-router-config")
	for _, dir := range []string{routerDir, dataDir, configDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}
	if err := writeAtomic(filepath.Join(routerDir, "Caddyfile"), []byte(renderRuntimeRouterCaddyfile(state)), 0o600); err != nil {
		return err
	}
	if err := validateRuntimeRouterConfig(routerDir); err != nil {
		return err
	}
	if len(state.Routes) == 0 {
		out, err := exec.Command("docker", "rm", "-f", runtimeRouterContainer).CombinedOutput()
		if err != nil && !strings.Contains(string(out), "No such container") {
			return fmt.Errorf("remove empty runtime router: %w: %s", err, strings.TrimSpace(string(out)))
		}
		return nil
	}
	return ensureRuntimeRouter(routerDir, dataDir, configDir)
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
		restoreErr := applyRuntimeRouterState(cfg, state)
		if restoreErr == nil {
			_ = clearRuntimePromotionMarker(cfg, next.DeploymentID)
			return reason
		}
		return fmt.Errorf("%v; previous runtime route restore also failed: %w", reason, restoreErr)
	}

	if err := applyRuntimeRouterState(cfg, nextState); err != nil {
		return nil, restore(fmt.Errorf("apply runtime route: %w", err))
	}
	if err := waitForRoutedHealth(ctx, next, timeout); err != nil {
		return nil, restore(fmt.Errorf("verify stable runtime route: %w", err))
	}
	if err := writeRuntimeRouterState(cfg, nextState); err != nil {
		return nil, restore(fmt.Errorf("commit runtime route state: %w", err))
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
			if err := applyRuntimeRouterState(cfg, state); err != nil {
				runtimeRouterMu.Unlock()
				return fmt.Errorf("restore committed runtime router state: %w", err)
			}
			_ = removeManagedContainer(context.Background(), marker.Next.BackendContainer, marker.Next.DeploymentID, false)
			_ = w.status(marker.Next.DeploymentID, "FAILED", "agent recovered an interrupted runtime switch before commit; previous route retained", "")
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			runtimeRouterMu.Unlock()
			return err
		}
	}

	if err := applyRuntimeRouterState(cfg, state); err != nil {
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
		_ = w.send(map[string]any{
			"type": "runtimeRecovered",
			"deploymentId": route.DeploymentID,
			"containerId": containerID,
			"at": time.Now().UTC().Format(time.RFC3339Nano),
		})
	}
	return nil
}
