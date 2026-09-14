package main

import (
	"strings"
	"testing"
)

func TestRuntimeResourceArgs(t *testing.T) {
	joined := strings.Join(runtimeResourceArgs(), " ")
	for _, required := range []string{
		"--cpus 1.0",
		"--memory 768m",
		"--memory-swap 768m",
		"--pids-limit 256",
		"--log-driver json-file",
		"--log-opt max-size=10m",
		"--log-opt max-file=3",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("resource args missing %q: %s", required, joined)
		}
	}
}

func TestValidateDiskHeadroom(t *testing.T) {
	gib := uint64(1024 * 1024 * 1024)
	if err := validateDiskHeadroom(5*gib, 20*gib); err != nil {
		t.Fatalf("healthy disk rejected: %v", err)
	}
	if err := validateDiskHeadroom(1*gib, 5*gib); err == nil || !strings.Contains(err.Error(), "at least 2048 MiB") {
		t.Fatalf("absolute disk floor was not enforced: %v", err)
	}
	if err := validateDiskHeadroom(3*gib, 40*gib); err == nil || !strings.Contains(err.Error(), "at least 10%") {
		t.Fatalf("percentage disk floor was not enforced: %v", err)
	}
	if err := validateDiskHeadroom(3*gib, 0); err == nil {
		t.Fatal("zero disk capacity must be rejected")
	}
}
