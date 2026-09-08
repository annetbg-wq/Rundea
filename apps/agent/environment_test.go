package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testWorkspace(t *testing.T, id string) (string, string) {
	t.Helper()
	workDir := t.TempDir()
	workspace := filepath.Join(workDir, "deployments", id)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	return workDir, workspace
}

func TestWriteRuntimeEnvFileAddsPlatformBindingAndSecrets(t *testing.T) {
	_, workspace := testWorkspace(t, "current")
	path, err := writeRuntimeEnvFile(workspace, map[string]string{
		"APP_TOKEN":    "super-secret",
		"DATABASE_URL": "postgres://db/app",
	}, 3001)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600, got %o", info.Mode().Perm())
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, expected := range []string{"APP_TOKEN=super-secret", "DATABASE_URL=postgres://db/app", "HOST=0.0.0.0", "PORT=3001"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("env file missing %q: %s", expected, text)
		}
	}
}

func TestWriteRuntimeEnvFileRejectsReservedAndMultilineValues(t *testing.T) {
	_, workspace := testWorkspace(t, "current")
	if _, err := writeRuntimeEnvFile(workspace, map[string]string{"PORT": "9999"}, 3001); err == nil {
		t.Fatal("expected reserved PORT to fail")
	}
	if _, err := writeRuntimeEnvFile(workspace, map[string]string{"SECRET": "line1\nline2"}, 3001); err == nil {
		t.Fatal("expected multiline value to fail")
	}
}

func TestWriteRuntimeEnvFileRemovesStaleSecretTransport(t *testing.T) {
	workDir, workspace := testWorkspace(t, "current")
	staleDir := filepath.Join(workDir, "deployments", "interrupted")
	if err := os.MkdirAll(staleDir, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(staleDir, "runtime.env")
	if err := os.WriteFile(stale, []byte("SECRET=stale\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := writeRuntimeEnvFile(workspace, map[string]string{"APP_TOKEN": "fresh"}, 3001); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("expected stale runtime.env to be removed, stat err=%v", err)
	}
}
