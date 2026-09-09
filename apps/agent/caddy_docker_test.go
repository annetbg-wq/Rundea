package main

import (
	"slices"
	"testing"
)

func TestCaddyDockerRunArgsPinsEntrypointBeforeImage(t *testing.T) {
	args := caddyDockerRunArgs(
		[]string{"--rm", "-v", "/tmp/caddy:/etc/caddy:ro"},
		"validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	)
	wantPrefix := []string{"run", "--rm", "-v", "/tmp/caddy:/etc/caddy:ro", "--entrypoint", "caddy", caddyImage, "validate"}
	if len(args) < len(wantPrefix) || !slices.Equal(args[:len(wantPrefix)], wantPrefix) {
		t.Fatalf("unexpected Caddy docker args: %v", args)
	}
}

func TestCaddyDockerRunArgsKeepsRuntimeOptionsBeforeImage(t *testing.T) {
	args := caddyDockerRunArgs(
		[]string{"-d", "--name", runtimeRouterContainer, "--restart", "no", "--network", "host"},
		"run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	)
	imageIndex := slices.Index(args, caddyImage)
	entrypointIndex := slices.Index(args, "--entrypoint")
	if imageIndex < 0 || entrypointIndex < 0 || entrypointIndex > imageIndex {
		t.Fatalf("entrypoint must be an explicit Docker option before image: %v", args)
	}
	if imageIndex+1 >= len(args) || args[imageIndex+1] != "run" {
		t.Fatalf("Caddy subcommand must follow image: %v", args)
	}
}
