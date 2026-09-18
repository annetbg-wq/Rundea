package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	runtimeManagedRedisMetadataKey = "RUNDEA_INTERNAL_MANAGED_REDIS"
	managedRedisImage              = "redis:7.4-alpine"
	managedRedisMemoryLimit        = "512m"
)

var managedRedisUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var managedRedisAliasPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
var managedRedisVolumePattern = regexp.MustCompile(`^rundea-redis-[a-f0-9]{32}$`)
var managedRedisPasswordPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
var pendingManagedRedis sync.Map

type managedRedisSpec struct {
	AddonID          string `json:"addonId"`
	ProjectID        string `json:"projectId"`
	Alias            string `json:"alias"`
	DockerVolumeName string `json:"dockerVolumeName"`
	Password         string `json:"password"`
}

func validateManagedRedisSpec(spec managedRedisSpec) error {
	if !managedRedisUUIDPattern.MatchString(spec.AddonID) {
		return errors.New("managed Redis contains invalid addon identity")
	}
	if !managedRedisUUIDPattern.MatchString(spec.ProjectID) {
		return errors.New("managed Redis contains invalid project identity")
	}
	if !managedRedisAliasPattern.MatchString(spec.Alias) {
		return errors.New("managed Redis contains invalid private DNS alias")
	}
	if !managedRedisVolumePattern.MatchString(spec.DockerVolumeName) {
		return errors.New("managed Redis contains invalid durable volume identity")
	}
	if !managedRedisPasswordPattern.MatchString(spec.Password) {
		return errors.New("managed Redis contains invalid credential")
	}
	return nil
}

func managedRedisURL(spec managedRedisSpec) string {
	credential := url.UserPassword("", spec.Password).String()
	return "redis://" + credential + "@" + spec.Alias + ":6379/0"
}

func splitRuntimeManagedRedisMetadata(deploymentID string, values map[string]string) (map[string]string, error) {
	clean := make(map[string]string, len(values))
	var spec managedRedisSpec
	found := false
	for key, value := range values {
		if key != runtimeManagedRedisMetadataKey {
			clean[key] = value
			continue
		}
		if found {
			return nil, errors.New("managed Redis metadata is duplicated")
		}
		if err := json.Unmarshal([]byte(value), &spec); err != nil {
			return nil, fmt.Errorf("decode managed Redis metadata: %w", err)
		}
		found = true
	}
	if !found {
		pendingManagedRedis.Delete(deploymentID)
		return clean, nil
	}
	if _, exists := clean["REDIS_URL"]; exists {
		return nil, errors.New("REDIS_URL conflicts with Rundea managed Redis")
	}
	if err := validateManagedRedisSpec(spec); err != nil {
		return nil, err
	}
	spec.AddonID = strings.ToLower(spec.AddonID)
	spec.ProjectID = strings.ToLower(spec.ProjectID)
	clean["REDIS_URL"] = managedRedisURL(spec)
	pendingManagedRedis.Store(deploymentID, spec)
	return clean, nil
}

func managedRedisForDeployment(deploymentID string) (managedRedisSpec, bool) {
	value, ok := pendingManagedRedis.Load(deploymentID)
	if !ok {
		return managedRedisSpec{}, false
	}
	spec, ok := value.(managedRedisSpec)
	return spec, ok
}

func clearManagedRedis(deploymentID string) {
	pendingManagedRedis.Delete(deploymentID)
}

func managedRedisContainerName(addonID string) string {
	return "rundea-redis-addon-" + strings.ReplaceAll(strings.ToLower(addonID), "-", "")
}

func managedRedisConfigPath(workDir, addonID string) string {
	return filepath.Join(workDir, "addons", "redis", strings.ToLower(addonID), "redis.conf")
}

func writeManagedRedisConfig(workDir string, spec managedRedisSpec) (string, error) {
	path := managedRedisConfigPath(workDir, spec.AddonID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("create managed Redis config directory: %w", err)
	}
	content := "bind 0.0.0.0\nprotected-mode yes\nport 6379\nappendonly yes\nappendfsync everysec\nrequirepass " + spec.Password + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", fmt.Errorf("write managed Redis config: %w", err)
	}
	// The parent directory remains 0700 on the host. The bind-mounted file itself\n\t// must be readable by the non-root redis user inside the container.\n\tif err := os.Chmod(path, 0o644); err != nil {
		return "", fmt.Errorf("protect managed Redis config: %w", err)
	}
	return path, nil
}

func ensureManagedRedisVolume(ctx context.Context, spec managedRedisSpec) error {
	out, err := exec.CommandContext(
		ctx, "docker", "volume", "inspect", "--format",
		`{{ index .Labels "rundea.managed" }}|{{ index .Labels "rundea.kind" }}|{{ index .Labels "rundea.project" }}|{{ index .Labels "rundea.addon" }}`,
		spec.DockerVolumeName,
	).CombinedOutput()
	if err == nil {
		parts := strings.Split(strings.TrimSpace(string(out)), "|")
		if len(parts) != 4 || parts[0] != "true" || parts[1] != "managed-redis-data" || !strings.EqualFold(parts[2], spec.ProjectID) || !strings.EqualFold(parts[3], spec.AddonID) {
			return fmt.Errorf("refusing managed Redis volume %s because Docker volume ownership does not match Rundea state", spec.DockerVolumeName)
		}
		return nil
	}
	message := strings.TrimSpace(string(out))
	if !strings.Contains(strings.ToLower(message), "no such volume") && !strings.Contains(strings.ToLower(message), "not found") {
		return fmt.Errorf("inspect managed Redis volume %s: %w: %s", spec.DockerVolumeName, err, message)
	}
	createOut, createErr := exec.CommandContext(
		ctx, "docker", "volume", "create",
		"--label", "rundea.managed=true",
		"--label", "rundea.kind=managed-redis-data",
		"--label", "rundea.project="+spec.ProjectID,
		"--label", "rundea.addon="+spec.AddonID,
		spec.DockerVolumeName,
	).CombinedOutput()
	if createErr != nil {
		return fmt.Errorf("create managed Redis volume: %w: %s", createErr, strings.TrimSpace(string(createOut)))
	}
	return nil
}

func inspectManagedRedisContainer(ctx context.Context, spec managedRedisSpec) (exists, running bool, err error) {
	name := managedRedisContainerName(spec.AddonID)
	out, inspectErr := exec.CommandContext(
		ctx, "docker", "inspect", "--format",
		`{{ index .Config.Labels "rundea.managed" }}|{{ index .Config.Labels "rundea.kind" }}|{{ index .Config.Labels "rundea.project" }}|{{ index .Config.Labels "rundea.addon" }}|{{ .State.Running }}|{{ .HostConfig.NetworkMode }}`,
		name,
	).CombinedOutput()
	if inspectErr != nil {
		message := strings.TrimSpace(string(out))
		if strings.Contains(strings.ToLower(message), "no such object") || strings.Contains(strings.ToLower(message), "no such container") {
			return false, false, nil
		}
		return false, false, fmt.Errorf("inspect managed Redis container: %w: %s", inspectErr, message)
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 6 || parts[0] != "true" || parts[1] != "managed-redis" || !strings.EqualFold(parts[2], spec.ProjectID) || !strings.EqualFold(parts[3], spec.AddonID) {
		return true, false, errors.New("managed Redis container slot is occupied by a container Rundea does not own")
	}
	if parts[5] != runtimeProjectNetworkName(spec.ProjectID) {
		return true, false, errors.New("managed Redis container is attached to the wrong project network")
	}
	return true, parts[4] == "true", nil
}

func waitForManagedRedis(ctx context.Context, spec managedRedisSpec) error {
	name := managedRedisContainerName(spec.AddonID)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		cmd := exec.CommandContext(ctx, "docker", "exec", "-e", "REDISCLI_AUTH="+spec.Password, name, "redis-cli", "ping")
		out, err := cmd.CombinedOutput()
		if err == nil && strings.TrimSpace(string(out)) == "PONG" {
			return nil
		}
		time.Sleep(time.Second)
	}
	return errors.New("managed Redis did not become healthy within 30 seconds")
}

func ensureManagedRedis(ctx context.Context, workDir string, spec managedRedisSpec) error {
	if err := validateManagedRedisSpec(spec); err != nil {
		return err
	}
	if _, err := ensureOwnedRuntimeProjectNetwork(ctx, runtimeProjectNetworkSpec{ProjectID: spec.ProjectID, ServiceAlias: spec.Alias}); err != nil {
		return fmt.Errorf("managed Redis project network: %w", err)
	}
	if err := ensureManagedRedisVolume(ctx, spec); err != nil {
		return err
	}
	configPath, err := writeManagedRedisConfig(workDir, spec)
	if err != nil {
		return err
	}
	exists, running, err := inspectManagedRedisContainer(ctx, spec)
	if err != nil {
		return err
	}
	name := managedRedisContainerName(spec.AddonID)
	if exists {
		if !running {
			out, startErr := exec.CommandContext(ctx, "docker", "start", name).CombinedOutput()
			if startErr != nil {
				return fmt.Errorf("start managed Redis: %w: %s", startErr, strings.TrimSpace(string(out)))
			}
		}
		return waitForManagedRedis(ctx, spec)
	}
	if err := requireNodeMemoryCapacity(ctx, 512*1024*1024, "managed Redis admission"); err != nil {
		return err
	}
	args := []string{
		"run", "-d", "--name", name, "--restart", "unless-stopped",
		"--network", runtimeProjectNetworkName(spec.ProjectID), "--network-alias", spec.Alias,
		"--memory", managedRedisMemoryLimit, "--memory-swap", managedRedisMemoryLimit,
		"--cpus", "0.50", "--pids-limit", "128",
		"--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
		"--label", "rundea.managed=true",
		"--label", "rundea.kind=managed-redis",
		"--label", "rundea.project="+spec.ProjectID,
		"--label", "rundea.addon="+spec.AddonID,
		"-v", spec.DockerVolumeName+":/data",
		"-v", configPath+":/usr/local/etc/redis/redis.conf:ro",
		managedRedisImage, "redis-server", "/usr/local/etc/redis/redis.conf",
	}
	out, runErr := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if runErr != nil {
		return fmt.Errorf("start managed Redis container: %w: %s", runErr, strings.TrimSpace(string(out)))
	}
	return waitForManagedRedis(ctx, spec)
}

func reportManagedRedisResult(w *writer, spec managedRedisSpec, ok bool, err error) {
	event := map[string]any{
		"type": "managedRedis",
		"addonId": spec.AddonID,
		"projectId": spec.ProjectID,
		"ok": ok,
		"completedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}
	if err != nil {
		event["error"] = err.Error()
	}
	_ = w.send(event)
}
