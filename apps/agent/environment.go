package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var environmentKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func writeRuntimeEnvFile(workspace string, values map[string]string, containerPort int) (string, error) {
	// Deployments are serialized per node in v0, so it is safe to remove any
	// secret transport file left behind by a previous interrupted deployment.
	workDir := filepath.Dir(filepath.Dir(workspace))
	if err := cleanupStaleRuntimeEnvFiles(workDir); err != nil {
		return "", fmt.Errorf("clean stale runtime env files: %w", err)
	}

	deploymentID := filepath.Base(workspace)
	withoutNetworkMetadata, err := splitRuntimeProjectNetworkMetadata(deploymentID, values)
	if err != nil {
		return "", err
	}
	cleanValues, err := splitRuntimeVolumeMetadata(deploymentID, withoutNetworkMetadata)
	if err != nil {
		clearRuntimeProjectNetwork(deploymentID)
		return "", err
	}

	merged := make(map[string]string, len(cleanValues)+2)
	for key, value := range cleanValues {
		if !environmentKeyPattern.MatchString(key) {
			return "", fmt.Errorf("invalid environment variable name %q", key)
		}
		if strings.ContainsRune(value, '\x00') || strings.ContainsAny(value, "\r\n") {
			return "", fmt.Errorf("environment variable %s contains unsupported control characters", key)
		}
		if key == "HOST" || key == "PORT" || strings.HasPrefix(key, "RUNDEA_") {
			return "", fmt.Errorf("environment variable %s is reserved by Rundea", key)
		}
		merged[key] = value
	}
	merged["HOST"] = "0.0.0.0"
	merged["PORT"] = fmt.Sprintf("%d", containerPort)

	keys := make([]string, 0, len(merged))
	for key := range merged {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var builder strings.Builder
	for _, key := range keys {
		builder.WriteString(key)
		builder.WriteByte('=')
		builder.WriteString(merged[key])
		builder.WriteByte('\n')
	}
	path := filepath.Join(workspace, "runtime.env")
	if err := os.WriteFile(path, []byte(builder.String()), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func cleanupStaleRuntimeEnvFiles(workDir string) error {
	deploymentsDir := filepath.Join(workDir, "deployments")
	return filepath.WalkDir(deploymentsDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() || entry.Name() != "runtime.env" {
			return nil
		}
		return os.Remove(path)
	})
}
