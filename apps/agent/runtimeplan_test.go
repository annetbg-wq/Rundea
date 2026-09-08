package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveHealthcheckPathFromRailwayMetadata(t *testing.T) {
	dir := t.TempDir()
	contents := `{"deploy":{"healthcheckPath":"/api/health","healthcheckTimeout":60}}`
	if err := os.WriteFile(filepath.Join(dir, "railway.json"), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := resolveHealthcheckPath(dir, ""); got != "/api/health" {
		t.Fatalf("expected /api/health, got %q", got)
	}
}

func TestResolveHealthcheckPathExplicitValueWins(t *testing.T) {
	dir := t.TempDir()
	if got := resolveHealthcheckPath(dir, "status"); got != "/status" {
		t.Fatalf("expected /status, got %q", got)
	}
}

func TestResolveHealthcheckPathFallsBack(t *testing.T) {
	if got := resolveHealthcheckPath(t.TempDir(), ""); got != "/health" {
		t.Fatalf("expected /health, got %q", got)
	}
}
