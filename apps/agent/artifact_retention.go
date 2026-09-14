package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const retainedArtifactRevisions = 4

var artifactRetentionMu sync.Mutex

type artifactRetentionState struct {
	Version  int                 `json:"version"`
	Services map[string][]string `json:"services"`
}

func artifactRetentionPath(cfg config) string {
	return filepath.Join(cfg.WorkDir, "artifact-retention.json")
}

func loadArtifactRetentionState(cfg config) (artifactRetentionState, error) {
	payload, err := os.ReadFile(artifactRetentionPath(cfg))
	if errors.Is(err, os.ErrNotExist) {
		return artifactRetentionState{Version: 1, Services: map[string][]string{}}, nil
	}
	if err != nil {
		return artifactRetentionState{}, err
	}
	var state artifactRetentionState
	if err := json.Unmarshal(payload, &state); err != nil {
		return artifactRetentionState{}, fmt.Errorf("decode artifact retention state: %w", err)
	}
	if state.Version != 1 {
		return artifactRetentionState{}, fmt.Errorf("unsupported artifact retention state version %d", state.Version)
	}
	if state.Services == nil {
		state.Services = map[string][]string{}
	}
	return state, nil
}

func nextRetainedArtifacts(existing []string, current string, previous string) (retained []string, evicted []string) {
	ordered := make([]string, 0, len(existing)+2)
	seen := map[string]struct{}{}
	appendUnique := func(id string) {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		ordered = append(ordered, id)
	}
	appendUnique(current)
	appendUnique(previous)
	for _, id := range existing {
		appendUnique(id)
	}
	if len(ordered) <= retainedArtifactRevisions {
		return ordered, nil
	}
	return ordered[:retainedArtifactRevisions], append([]string(nil), ordered[retainedArtifactRevisions:]...)
}

func recordRetainedArtifacts(cfg config, serviceName, current, previous string) ([]string, error) {
	artifactRetentionMu.Lock()
	defer artifactRetentionMu.Unlock()

	state, err := loadArtifactRetentionState(cfg)
	if err != nil {
		return nil, err
	}
	retained, evicted := nextRetainedArtifacts(state.Services[serviceName], current, previous)
	state.Services[serviceName] = retained
	payload, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	if err := writeAtomic(artifactRetentionPath(cfg), payload, 0o600); err != nil {
		return nil, fmt.Errorf("persist artifact retention state: %w", err)
	}
	return evicted, nil
}

func retainedArtifactContains(cfg config, deploymentID string) (bool, error) {
	artifactRetentionMu.Lock()
	defer artifactRetentionMu.Unlock()
	state, err := loadArtifactRetentionState(cfg)
	if err != nil {
		return false, err
	}
	deploymentID = strings.ToLower(deploymentID)
	for _, ids := range state.Services {
		for _, id := range ids {
			if strings.EqualFold(id, deploymentID) {
				return true, nil
			}
		}
	}
	return false, nil
}

func cleanupRetiredArtifact(ctx context.Context, cfg config, deploymentID string) error {
	retained, err := retainedArtifactContains(cfg, deploymentID)
	if err != nil {
		return err
	}
	if retained {
		return fmt.Errorf("refusing to remove retained artifact %s", deploymentID)
	}
	router, err := loadRuntimeRouterState(cfg)
	if err != nil {
		return err
	}
	if routeForDeployment(router, deploymentID) != nil {
		return fmt.Errorf("refusing to remove active runtime artifact %s", deploymentID)
	}

	imageTag := "rundea/" + strings.ToLower(deploymentID) + ":build"
	out, imageErr := exec.CommandContext(ctx, "docker", "image", "rm", imageTag).CombinedOutput()
	if imageErr != nil {
		message := strings.TrimSpace(string(out))
		if !strings.Contains(message, "No such image") && !strings.Contains(message, "does not exist") {
			return fmt.Errorf("remove retired image %s: %w: %s", imageTag, imageErr, message)
		}
	}
	if err := os.RemoveAll(filepath.Join(cfg.WorkDir, "deployments", strings.ToLower(deploymentID))); err != nil {
		return fmt.Errorf("remove retired deployment workdir %s: %w", deploymentID, err)
	}
	return nil
}

func cleanupRetiredArtifacts(cfg config, w *writer, ownerDeploymentID string, deploymentIDs []string) {
	for _, deploymentID := range deploymentIDs {
		if err := cleanupRetiredArtifact(context.Background(), cfg, deploymentID); err != nil {
			w.log(ownerDeploymentID, "system", "retired artifact cleanup deferred: "+err.Error())
			continue
		}
		w.log(ownerDeploymentID, "system", "retired deployment artifact removed: "+deploymentID)
	}
}

func scheduleRetiredArtifactCleanup(cfg config, w *writer, ownerDeploymentID string, deploymentIDs []string) {
	if len(deploymentIDs) == 0 {
		return
	}
	ids := append([]string(nil), deploymentIDs...)
	go func() {
		time.Sleep(runtimeBackendDrain + 5*time.Second)
		cleanupRetiredArtifacts(cfg, w, ownerDeploymentID, ids)
	}()
}
