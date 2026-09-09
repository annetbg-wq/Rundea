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
	spec := safeRuntimeSpec{
		DeploymentID:  "12345678-1234-1234-9234-123456789abc",
		ServiceName:   "api",
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
		"rundea.backend=true",
		"rundea.deployment=12345678-1234-1234-9234-123456789abc",
		"rundea.managed=true",
		"rundea.service=api",
		"rundea.rollback_target=old",
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
