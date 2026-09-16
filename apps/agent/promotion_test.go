package main

import (
	"strings"
	"testing"
)

func TestRevisionContainerNameIsDeploymentScoped(t *testing.T) {
	got := revisionContainerName("rundea-api", "12345678-1234-1234-9234-123456789abc")
	if got != "rundea-api-rev-123456781234" {
		t.Fatalf("unexpected revision name %q", got)
	}
}

func TestBackendRunArgsNeverBindStablePort(t *testing.T) {
	deploymentID := "12345678-1234-4234-9234-123456789abc"
	pendingRuntimeProjectNetworks.Store(deploymentID, runtimeProjectNetworkSpec{
		ProjectID: "22222222-2222-4222-8222-222222222222",
		ServiceAlias: "api",
	})
	defer clearRuntimeProjectNetwork(deploymentID)

	spec := safeRuntimeSpec{
		DeploymentID:  deploymentID,
		ServiceName:   "api-1234567812",
		ContainerPort: 8080,
		HostPort:      18080,
		EnvFile:       "/tmp/runtime.env",
		ImageTag:      "rundea/test:build",
		Labels:        map[string]string{"rundea.rollback_target": "old"},
	}
	args := backendRunArgs(spec, "rundea-api-rev-123456781234")
	joined := strings.Join(args, " ")
	for _, required := range []string{
		"--restart unless-stopped",
		"--cpus 1.0",
		"--memory 768m",
		"--memory-swap 768m",
		"--pids-limit 256",
		"--log-driver json-file",
		"--log-opt max-size=10m",
		"--log-opt max-file=3",
		"rundea.backend=true",
		"rundea.deployment=" + deploymentID,
		"rundea.managed=true",
		"rundea.service=api-1234567812",
		"rundea.project=22222222-2222-4222-8222-222222222222",
		"rundea.service_alias=api",
		"rundea.rollback_target=old",
		"--network rundea-project-22222222222242228222222222222222",
		"--network-alias api",
		"-p 127.0.0.1::8080",
		"--env-file /tmp/runtime.env rundea/test:build",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("backend args missing %q: %s", required, joined)
		}
	}
	if strings.Contains(joined, "127.0.0.1:18080:8080") {
		t.Fatalf("revision backend must never bind the stable service port: %s", joined)
	}
}
