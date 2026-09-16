package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
)

const runtimeProjectNetworkMetadataKey = "RUNDEA_INTERNAL_PROJECT_NETWORK"

var runtimeProjectIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var runtimeServiceAliasPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)
var pendingRuntimeProjectNetworks sync.Map

type runtimeProjectNetworkSpec struct {
	ProjectID    string `json:"projectId"`
	ServiceAlias string `json:"serviceAlias"`
}

func validateRuntimeProjectNetwork(spec runtimeProjectNetworkSpec) error {
	if !runtimeProjectIDPattern.MatchString(spec.ProjectID) {
		return errors.New("runtime project network contains invalid project identity")
	}
	if !runtimeServiceAliasPattern.MatchString(spec.ServiceAlias) {
		return errors.New("runtime project network contains invalid service alias")
	}
	return nil
}

func splitRuntimeProjectNetworkMetadata(deploymentID string, values map[string]string) (map[string]string, error) {
	clean := make(map[string]string, len(values))
	var spec runtimeProjectNetworkSpec
	found := false
	for key, value := range values {
		if key != runtimeProjectNetworkMetadataKey {
			clean[key] = value
			continue
		}
		if found {
			return nil, errors.New("runtime project network metadata is duplicated")
		}
		if err := json.Unmarshal([]byte(value), &spec); err != nil {
			return nil, fmt.Errorf("decode private project network metadata: %w", err)
		}
		found = true
	}
	if !found {
		pendingRuntimeProjectNetworks.Delete(deploymentID)
		return clean, nil
	}
	if err := validateRuntimeProjectNetwork(spec); err != nil {
		return nil, err
	}
	spec.ProjectID = strings.ToLower(spec.ProjectID)
	pendingRuntimeProjectNetworks.Store(deploymentID, spec)
	return clean, nil
}

func runtimeProjectNetworkForDeployment(deploymentID string) (runtimeProjectNetworkSpec, bool) {
	value, ok := pendingRuntimeProjectNetworks.Load(deploymentID)
	if !ok {
		return runtimeProjectNetworkSpec{}, false
	}
	spec, ok := value.(runtimeProjectNetworkSpec)
	return spec, ok
}

func clearRuntimeProjectNetwork(deploymentID string) {
	pendingRuntimeProjectNetworks.Delete(deploymentID)
}

func runtimeProjectNetworkName(projectID string) string {
	return "rundea-project-" + strings.ToLower(strings.ReplaceAll(projectID, "-", ""))
}

func ensureOwnedRuntimeProjectNetwork(ctx context.Context, spec runtimeProjectNetworkSpec) (string, error) {
	if err := validateRuntimeProjectNetwork(spec); err != nil {
		return "", err
	}
	projectID := strings.ToLower(spec.ProjectID)
	name := runtimeProjectNetworkName(projectID)
	out, err := exec.CommandContext(
		ctx,
		"docker", "network", "inspect", "--format",
		`{{ index .Labels "rundea.managed" }}|{{ index .Labels "rundea.kind" }}|{{ index .Labels "rundea.project" }}`,
		name,
	).CombinedOutput()
	if err == nil {
		parts := strings.Split(strings.TrimSpace(string(out)), "|")
		if len(parts) != 3 || parts[0] != "true" || parts[1] != "project-network" || !strings.EqualFold(parts[2], projectID) {
			return "", fmt.Errorf("refusing project network %s because existing Docker network ownership does not match Rundea state", name)
		}
		return name, nil
	}
	message := strings.TrimSpace(string(out))
	if !strings.Contains(strings.ToLower(message), "no such network") && !strings.Contains(strings.ToLower(message), "not found") {
		return "", fmt.Errorf("inspect project network %s: %w: %s", name, err, message)
	}
	createOut, createErr := exec.CommandContext(
		ctx,
		"docker", "network", "create",
		"--driver", "bridge",
		"--label", "rundea.managed=true",
		"--label", "rundea.kind=project-network",
		"--label", "rundea.project="+projectID,
		name,
	).CombinedOutput()
	if createErr != nil {
		return "", fmt.Errorf("create project network %s: %w: %s", name, createErr, strings.TrimSpace(string(createOut)))
	}
	return name, nil
}

func runtimeProjectNetworkArgs(spec runtimeProjectNetworkSpec) []string {
	return []string{
		"--network", runtimeProjectNetworkName(spec.ProjectID),
		"--network-alias", spec.ServiceAlias,
	}
}
