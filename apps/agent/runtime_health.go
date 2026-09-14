package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	runtimeHealthFailureThreshold = 3
	runtimeHealthRestartCooldown  = 5 * time.Minute
)

type runtimeHealthTracker struct {
	State        string
	Failures     int
	RestartAfter time.Time
}

var runtimeHealthMu sync.Mutex
var runtimeHealthTrackers = map[string]runtimeHealthTracker{}

func advanceRuntimeHealth(previous runtimeHealthTracker, healthy bool) (runtimeHealthTracker, bool) {
	if healthy {
		next := runtimeHealthTracker{State: "HEALTHY"}
		return next, previous.State != next.State || previous.Failures != 0
	}
	next := previous
	next.Failures++
	if next.Failures >= runtimeHealthFailureThreshold {
		next.State = "DOWN"
	} else {
		next.State = "DEGRADED"
	}
	return next, previous.State != next.State
}

func probeRuntimeRoute(ctx context.Context, route runtimeRoute) error {
	path := route.HealthPath
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d%s", route.HostPort, path)
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return fmt.Errorf("stable route returned HTTP %d", resp.StatusCode)
	}
	return nil
}

func publishedLoopbackPortAny(ctx context.Context, containerName string) (int, error) {
	out, err := exec.CommandContext(ctx, "docker", "port", containerName).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("resolve restarted backend port: %w: %s", err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "->", 2)
		if len(parts) != 2 {
			continue
		}
		host, portText, splitErr := net.SplitHostPort(strings.TrimSpace(parts[1]))
		if splitErr != nil || host != "127.0.0.1" {
			continue
		}
		port, parseErr := strconv.Atoi(portText)
		if parseErr == nil && port >= 1 && port <= 65535 {
			return port, nil
		}
	}
	return 0, fmt.Errorf("restarted backend %s did not publish a loopback port", containerName)
}

func restartUnhealthyRuntimeRoute(ctx context.Context, cfg config, expected runtimeRoute) error {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()

	router, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return err
	}
	current := routeForDeployment(router, expected.DeploymentID)
	if current == nil || current.ServiceName != expected.ServiceName || current.BackendContainer != expected.BackendContainer || current.HostPort != expected.HostPort {
		return fmt.Errorf("runtime route changed before automatic restart")
	}
	state, err := inspectContainerState(ctx, current.BackendContainer)
	if err != nil {
		return err
	}
	if !state.Exists || !state.Managed || state.DeploymentID != expected.DeploymentID {
		return fmt.Errorf("automatic restart target is not a Rundea-owned backend")
	}
	out, err := exec.CommandContext(ctx, "docker", "restart", current.BackendContainer).CombinedOutput()
	if err != nil {
		return fmt.Errorf("automatic docker restart failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	backendPort, err := publishedLoopbackPortAny(ctx, current.BackendContainer)
	if err != nil {
		return err
	}
	next := *current
	next.BackendPort = backendPort
	if err := commitRestartRuntimeRoute(ctx, cfg, next, 45*time.Second); err != nil {
		return fmt.Errorf("commit automatic restart route: %w", err)
	}
	return nil
}

func collectRuntimeHealth(ctx context.Context, w *writer, cfg config) error {
	router, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return fmt.Errorf("load runtime routes for health monitor: %w", err)
	}
	active := make(map[string]struct{}, len(router.Routes))
	now := time.Now()
	for _, route := range router.Routes {
		active[route.DeploymentID] = struct{}{}
		probeErr := probeRuntimeRoute(ctx, route)

		runtimeHealthMu.Lock()
		previous := runtimeHealthTrackers[route.DeploymentID]
		next, changed := advanceRuntimeHealth(previous, probeErr == nil)
		if probeErr == nil {
			next.RestartAfter = time.Time{}
		} else {
			next.RestartAfter = previous.RestartAfter
		}
		runtimeHealthTrackers[route.DeploymentID] = next
		shouldRestart := next.State == "DOWN" && (next.RestartAfter.IsZero() || !now.Before(next.RestartAfter))
		if shouldRestart {
			next.RestartAfter = now.Add(runtimeHealthRestartCooldown)
			runtimeHealthTrackers[route.DeploymentID] = next
		}
		runtimeHealthMu.Unlock()

		if changed {
			if probeErr == nil {
				w.log(route.DeploymentID, "system", "runtime-health HEALTHY failures=0")
			} else {
				w.log(route.DeploymentID, "system", fmt.Sprintf("runtime-health %s failures=%d error=%s", next.State, next.Failures, sanitizeProbeError(probeErr.Error())))
			}
		}
		if !shouldRestart {
			continue
		}

		w.log(route.DeploymentID, "system", "runtime-health DOWN automatic-restart=STARTED")
		restartCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
		restartErr := restartUnhealthyRuntimeRoute(restartCtx, cfg, route)
		cancel()
		if restartErr != nil {
			w.log(route.DeploymentID, "system", "runtime-health DOWN automatic-restart=FAILED error="+sanitizeProbeError(restartErr.Error()))
			continue
		}
		if probeErr := probeRuntimeRoute(ctx, route); probeErr != nil {
			w.log(route.DeploymentID, "system", "runtime-health DOWN automatic-restart=COMPLETED health=FAILED error="+sanitizeProbeError(probeErr.Error()))
			continue
		}
		runtimeHealthMu.Lock()
		runtimeHealthTrackers[route.DeploymentID] = runtimeHealthTracker{State: "HEALTHY"}
		runtimeHealthMu.Unlock()
		w.log(route.DeploymentID, "system", "runtime-health HEALTHY failures=0 automatic-restart=SUCCEEDED")
	}

	runtimeHealthMu.Lock()
	for deploymentID := range runtimeHealthTrackers {
		if _, ok := active[deploymentID]; !ok {
			delete(runtimeHealthTrackers, deploymentID)
		}
	}
	runtimeHealthMu.Unlock()
	return nil
}
