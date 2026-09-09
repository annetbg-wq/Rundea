package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCandidateContainerNameIsDeploymentScoped(t *testing.T) {
	got := candidateContainerName("rundea-api", "12345678-1234-1234-9234-123456789abc")
	if got != "rundea-api-candidate-123456781234" {
		t.Fatalf("unexpected candidate name %q", got)
	}
}

func TestContainerRunArgsKeepCandidateOnDynamicLoopbackPort(t *testing.T) {
	spec := safeRuntimeSpec{
		DeploymentID:  "12345678-1234-1234-9234-123456789abc",
		ContainerPort: 8080,
		EnvFile:       "/tmp/runtime.env",
		ImageTag:      "rundea/test:build",
		Labels:        map[string]string{"rundea.rollback_target": "old"},
	}
	args := containerRunArgs(spec, "rundea-api-candidate", 0, true)
	joined := strings.Join(args, " ")
	for _, required := range []string{
		"--restart no",
		"rundea.candidate=true",
		"rundea.deployment=12345678-1234-1234-9234-123456789abc",
		"rundea.managed=true",
		"rundea.rollback_target=old",
		"-p 127.0.0.1::8080",
		"--env-file /tmp/runtime.env rundea/test:build",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("candidate args missing %q: %s", required, joined)
		}
	}
}

func TestContainerRunArgsUseStablePortOnlyForPromotedRuntime(t *testing.T) {
	spec := safeRuntimeSpec{
		DeploymentID:  "12345678-1234-1234-9234-123456789abc",
		ContainerPort: 3000,
		EnvFile:       "/tmp/runtime.env",
		ImageTag:      "rundea/test:build",
	}
	args := containerRunArgs(spec, "rundea-api", 18080, false)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--restart unless-stopped") || !strings.Contains(joined, "-p 127.0.0.1:18080:3000") {
		t.Fatalf("stable runtime args are wrong: %s", joined)
	}
	if strings.Contains(joined, "rundea.candidate=true") {
		t.Fatalf("promoted runtime must not retain candidate label: %s", joined)
	}
}

func TestPromotionMarkerIsPrivateAndRoundTrips(t *testing.T) {
	workDir := t.TempDir()
	marker := promotionMarker{
		ContainerName:        "rundea-api",
		BackupName:           "rundea-api" + promotionBackupSuffix,
		PreviousDeploymentID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		NewDeploymentID:      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	}
	if err := writePromotionMarker(workDir, marker); err != nil {
		t.Fatal(err)
	}
	path := promotionMarkerPath(workDir, marker.ContainerName)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("marker permissions = %o, want 600", info.Mode().Perm())
	}
	if filepath.Dir(path) != filepath.Join(workDir, "promotions") {
		t.Fatalf("marker escaped promotion directory: %s", path)
	}
	if err := clearPromotionMarker(workDir, marker.ContainerName); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("marker was not removed, stat err=%v", err)
	}
}
