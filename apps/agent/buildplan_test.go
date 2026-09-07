package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareDockerfilePrefersExistingDockerfile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, plan, err := prepareDockerfile(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if path != "Dockerfile" || plan != "dockerfile:auto" {
		t.Fatalf("unexpected plan %q %q", path, plan)
	}
}

func TestPrepareDockerfileGeneratesNode24Plan(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"scripts":{"build":"vite build","start":"tsx server/index.ts"},"engines":{"node":">=24"}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "package-lock.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, plan, err := prepareDockerfile(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if plan != "nodejs-24:auto" {
		t.Fatalf("unexpected plan %q", plan)
	}
	contents, err := os.ReadFile(filepath.Join(dir, path))
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, expected := range []string{"FROM node:24-bookworm-slim", "npm ci --no-audit --no-fund", "RUN npm run build", `CMD ["npm","start"]`} {
		if !strings.Contains(text, expected) {
			t.Fatalf("generated Dockerfile missing %q:\n%s", expected, text)
		}
	}
}

func TestPrepareDockerfileRequiresStartScript(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"scripts":{"build":"npm run compile"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepareDockerfile(dir, ""); err == nil {
		t.Fatal("expected missing start script to fail")
	}
}
