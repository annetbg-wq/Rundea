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
	"strings"
	"time"
)

const (
	runtimeHealthFailureThreshold = 3
	runtimeHealthRestartCooldown  = 5 * time.Minute
)

type runtimeHealthTracker struct {
	State        string    `json:"state"`
	Failures     int       `json:"failures"`
	RestartAfter time.Time `json:"restartAfter,omitempty"`
}

type runtimeHealthState struct {
	Version  int                             `json:"version"`
	Trackers map[string]runtimeHealthTracker `json:"trackers"`
}

type runtimeHealthSample struct {
	State         string
	RestartDelta  uint64
	UptimeSeconds uint64
	Error         string
}

func runtimeHealthStatePath(cfg config) string {
	return filepath.Join(cfg.WorkDir, "runtime-health", "state.json")
}

func loadRuntimeHealthState(cfg config) (runtimeHealthState, error) {
	payload, err := os.ReadFile(runtimeHealthStatePath(cfg))
	if errors.Is(err, os.ErrNotExist) {
		return runtimeHealthState{Version: 1, Trackers: map[string]runtimeHealthTracker{}}, nil
	}
	if err != nil {
		return runtimeHealthState{}, err
	}
	var state runtimeHealthState
	if err := json.Unmarshal(payload, &state); err != nil {
		return runtimeHealthState{}, fmt.Errorf("decode runtime health state: %w", err)
	}
	if state.Version != 1 || state.Trackers == nil {
		return runtimeHealthState{}, errors.New("unsupported runtime health state")
	}
	for deploymentID, tracker := range state.Trackers {
		if !metricDeploymentIDPattern.MatchString(deploymentID) || tracker.Failures < 0 || !validRuntimeHealthState(tracker.State) {
			return runtimeHealthState{}, fmt.Errorf("invalid runtime health tracker for %s", deploymentID)
		}
	}
	return state, nil
}

func writeRuntimeHealthState(cfg config, state runtimeHealthState) error {
	if state.Version != 1 || state.Trackers == nil {
		return errors.New("invalid runtime health state")
	}
	if err := os.MkdirAll(filepath.Dir(runtimeHealthStatePath(cfg)), 0o700); err != nil {
		return err
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return writeAtomic(runtimeHealthStatePath(cfg), payload, 0o600)
}

func validRuntimeHealthState(value string) bool {
	return value == "" || value == "HEALTHY" || value == "DEGRADED" || value == "DOWN"
}

func advanceRuntimeHealth(previous runtimeHealthTracker, healthy bool) (runtimeHealthTracker, bool) {
	next := previous
	if healthy {
		next.State = "HEALTHY"
		next.Failures = 0
		return next, previous.State != next.State || previous.Failures != 0
	}
	next.Failures++
	if next.Failures >= runtimeHealthFailureThreshold {
		next.State = "DOWN"
	} else {
		next.State = "DEGRADED"
	}
	return next, previous.State != next.State
}

func sanitizeRuntimeHealthError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 500 {
		value = value[:500]
	}
	return value
}

func probeRuntimeRoute(ctx context.Context, route runtimeRoute) error {
	endpoint := fmt.Sprintf("http://127.0.0.1:%d%s", route.HostPort, route.HealthPath)
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
	if resp.Header.Get(runtimeRouterMarkerHeader) != route.DeploymentID {
		return errors.New("stable runtime route points to a different deployment")
	}
	return nil
}

func runtimeContainerUptimeSeconds(ctx context.Context, containerName string, now time.Time) (uint64, error) {
	out, err := exec.CommandContext(ctx, "docker", "inspect", "--format", `{{.State.Running}}|{{.State.StartedAt}}`, containerName).CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(out))
		if strings.Contains(message, "No such object") || strings.Contains(message, "No such container") {
			return 0, nil
		}
		return 0, fmt.Errorf("inspect runtime uptime: %w: %s", err, message)
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 2 || parts[0] != "true" {
		return 0, nil
	}
	startedAt, err := time.Parse(time.RFC3339Nano, parts[1])
	if err != nil || startedAt.After(now) {
		return 0, errors.New("runtime container returned invalid start time")
	}
	return uint64(now.Sub(startedAt) / time.Second), nil
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
		return errors.New("runtime route changed before automatic restart")
	}
	state, err := inspectContainerState(ctx, current.BackendContainer)
	if err != nil {
		return err
	}
	if !state.Exists || !state.Managed || state.DeploymentID != expected.DeploymentID {
		return errors.New("automatic restart target is not a Rundea-owned backend")
	}
	out, err := exec.CommandContext(ctx, "docker", "restart", current.BackendContainer).CombinedOutput()
	if err != nil {
		return fmt.Errorf("automatic docker restart failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if err := waitForRoutedHealth(ctx, *current, 45*time.Second); err != nil {
		return fmt.Errorf("automatic restart did not restore stable route: %w", err)
	}
	return nil
}

func collectRuntimeHealth(ctx context.Context, w *writer, cfg config) (map[string]runtimeHealthSample, error) {
	state, err := loadRuntimeHealthState(cfg)
	if err != nil {
		return nil, fmt.Errorf("load runtime health state: %w", err)
	}
	router, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return nil, fmt.Errorf("load runtime routes for health monitor: %w", err)
	}

	samples := make(map[string]runtimeHealthSample, len(router.Routes))
	active := make(map[string]struct{}, len(router.Routes))
	now := time.Now().UTC()
	for _, route := range router.Routes {
		active[route.DeploymentID] = struct{}{}
		previous := state.Trackers[route.DeploymentID]
		probeErr := probeRuntimeRoute(ctx, route)
		next, changed := advanceRuntimeHealth(previous, probeErr == nil)
		errorText := ""
		if probeErr != nil {
			errorText = sanitizeRuntimeHealthError(probeErr.Error())
		}
		restartDelta := uint64(0)

		if changed {
			message := fmt.Sprintf("runtime-health %s failures=%d", next.State, next.Failures)
			if errorText != "" {
				message += " error=" + errorText
			}
			w.log(route.DeploymentID, "system", message)
		}

		shouldRestart := next.State == "DOWN" && (next.RestartAfter.IsZero() || !now.Before(next.RestartAfter))
		if shouldRestart {
			next.RestartAfter = now.Add(runtimeHealthRestartCooldown)
			state.Trackers[route.DeploymentID] = next
			if err := writeRuntimeHealthState(cfg, state); err != nil {
				return nil, fmt.Errorf("persist automatic restart cooldown: %w", err)
			}
			restartDelta = 1
			w.log(route.DeploymentID, "system", "runtime-health DOWN automatic-restart=STARTED")
			restartCtx, cancel := context.WithTimeout(ctx, 75*time.Second)
			restartErr := restartUnhealthyRuntimeRoute(restartCtx, cfg, route)
			cancel()
			if restartErr != nil {
				errorText = sanitizeRuntimeHealthError(restartErr.Error())
				w.log(route.DeploymentID, "system", "runtime-health DOWN automatic-restart=FAILED error="+errorText)
			} else {
				// Keep this sample DOWN so the Control Plane records the outage and
				// restart attempt. The next independent successful probe promotes the
				// runtime back to HEALTHY while preserving the persisted cooldown.
				errorText = "automatic restart succeeded; awaiting independent health confirmation"
				w.log(route.DeploymentID, "system", "runtime-health DOWN automatic-restart=SUCCEEDED awaiting-next-probe")
			}
		}

		state.Trackers[route.DeploymentID] = next
		uptime, uptimeErr := runtimeContainerUptimeSeconds(ctx, route.BackendContainer, time.Now().UTC())
		if uptimeErr != nil && errorText == "" {
			errorText = sanitizeRuntimeHealthError(uptimeErr.Error())
		}
		samples[route.DeploymentID] = runtimeHealthSample{
			State: next.State, RestartDelta: restartDelta, UptimeSeconds: uptime, Error: errorText,
		}
	}

	for deploymentID := range state.Trackers {
		if _, ok := active[deploymentID]; !ok {
			delete(state.Trackers, deploymentID)
		}
	}
	if err := writeRuntimeHealthState(cfg, state); err != nil {
		return nil, fmt.Errorf("persist runtime health state: %w", err)
	}
	return samples, nil
}
