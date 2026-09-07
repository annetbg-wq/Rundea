package main

import (
	"os"
	"strings"
	"testing"
)

func TestWriteRuntimeEnvFileAddsPlatformBindingAndSecrets(t *testing.T) {
	path, err := writeRuntimeEnvFile(t.TempDir(), map[string]string{
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
	if _, err := writeRuntimeEnvFile(t.TempDir(), map[string]string{"PORT": "9999"}, 3001); err == nil {
		t.Fatal("expected reserved PORT to fail")
	}
	if _, err := writeRuntimeEnvFile(t.TempDir(), map[string]string{"SECRET": "line1\nline2"}, 3001); err == nil {
		t.Fatal("expected multiline value to fail")
	}
}
