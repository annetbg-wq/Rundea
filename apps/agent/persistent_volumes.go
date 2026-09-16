package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const runtimeVolumeMetadataKey = "RUNDEA_INTERNAL_VOLUME_MOUNTS"

var runtimeVolumeIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var runtimeDockerVolumeNamePattern = regexp.MustCompile(`^rundea-vol-[a-f0-9]{32}$`)
var pendingRuntimeVolumes sync.Map

type runtimeVolumeSpec struct {
	VolumeID         string `json:"volumeId"`
	Name             string `json:"name"`
	DockerVolumeName string `json:"dockerVolumeName"`
	MountPath        string `json:"mountPath"`
}

func validateRuntimeVolumes(volumes []runtimeVolumeSpec) error {
	if len(volumes) > 16 {
		return errors.New("runtime supports at most 16 persistent volumes per service")
	}
	seenIDs := map[string]struct{}{}
	seenMounts := map[string]struct{}{}
	seenDockerNames := map[string]struct{}{}
	for _, volume := range volumes {
		if !runtimeVolumeIDPattern.MatchString(volume.VolumeID) {
			return errors.New("runtime volume contains invalid volume identity")
		}
		if !runtimeDockerVolumeNamePattern.MatchString(volume.DockerVolumeName) {
			return errors.New("runtime volume contains invalid Docker volume name")
		}
		if volume.Name == "" || len(volume.Name) > 63 {
			return errors.New("runtime volume contains invalid display name")
		}
		if !strings.HasPrefix(volume.MountPath, "/") || volume.MountPath == "/" || strings.ContainsAny(volume.MountPath, "\r\n\x00,") {
			return errors.New("runtime volume contains invalid mount path")
		}
		for _, part := range strings.Split(volume.MountPath, "/") {
			if part == "." || part == ".." {
				return errors.New("runtime volume mount path contains unsafe segment")
			}
		}
		if _, ok := seenIDs[volume.VolumeID]; ok {
			return errors.New("runtime volume identity is duplicated")
		}
		if _, ok := seenMounts[volume.MountPath]; ok {
			return errors.New("runtime volume mount path is duplicated")
		}
		if _, ok := seenDockerNames[volume.DockerVolumeName]; ok {
			return errors.New("runtime Docker volume name is duplicated")
		}
		seenIDs[volume.VolumeID] = struct{}{}
		seenMounts[volume.MountPath] = struct{}{}
		seenDockerNames[volume.DockerVolumeName] = struct{}{}
	}
	return nil
}

func splitRuntimeVolumeMetadata(deploymentID string, values map[string]string) (map[string]string, error) {
	clean := make(map[string]string, len(values))
	var volumes []runtimeVolumeSpec
	for key, value := range values {
		if key != runtimeVolumeMetadataKey {
			clean[key] = value
			continue
		}
		if err := json.Unmarshal([]byte(value), &volumes); err != nil {
			return nil, fmt.Errorf("decode persistent volume metadata: %w", err)
		}
	}
	if err := validateRuntimeVolumes(volumes); err != nil {
		return nil, err
	}
	if len(volumes) > 0 {
		pendingRuntimeVolumes.Store(deploymentID, append([]runtimeVolumeSpec(nil), volumes...))
	} else {
		pendingRuntimeVolumes.Delete(deploymentID)
	}
	return clean, nil
}

func runtimeVolumesForDeployment(deploymentID string) []runtimeVolumeSpec {
	value, ok := pendingRuntimeVolumes.Load(deploymentID)
	if !ok {
		return nil
	}
	volumes, ok := value.([]runtimeVolumeSpec)
	if !ok {
		return nil
	}
	return append([]runtimeVolumeSpec(nil), volumes...)
}

func clearRuntimeVolumes(deploymentID string) {
	pendingRuntimeVolumes.Delete(deploymentID)
}

func ensureOwnedRuntimeVolume(ctx context.Context, serviceName string, volume runtimeVolumeSpec) error {
	out, err := exec.CommandContext(
		ctx,
		"docker", "volume", "inspect", "--format",
		`{{ index .Labels "rundea.managed" }}|{{ index .Labels "rundea.volume" }}|{{ index .Labels "rundea.service" }}`,
		volume.DockerVolumeName,
	).CombinedOutput()
	if err == nil {
		parts := strings.Split(strings.TrimSpace(string(out)), "|")
		if len(parts) != 3 || parts[0] != "true" || !strings.EqualFold(parts[1], volume.VolumeID) || parts[2] != serviceName {
			return fmt.Errorf("refusing persistent volume %s because existing Docker volume ownership does not match Rundea state", volume.Name)
		}
		return nil
	}
	message := strings.TrimSpace(string(out))
	if !strings.Contains(strings.ToLower(message), "no such volume") {
		return fmt.Errorf("inspect persistent volume %s: %w: %s", volume.Name, err, message)
	}
	createOut, createErr := exec.CommandContext(
		ctx,
		"docker", "volume", "create",
		"--label", "rundea.managed=true",
		"--label", "rundea.volume="+strings.ToLower(volume.VolumeID),
		"--label", "rundea.service="+serviceName,
		volume.DockerVolumeName,
	).CombinedOutput()
	if createErr != nil {
		return fmt.Errorf("create persistent volume %s: %w: %s", volume.Name, createErr, strings.TrimSpace(string(createOut)))
	}
	return nil
}

func ensureRuntimeVolumes(ctx context.Context, serviceName string, volumes []runtimeVolumeSpec) error {
	if err := validateRuntimeVolumes(volumes); err != nil {
		return err
	}
	for _, volume := range volumes {
		if err := ensureOwnedRuntimeVolume(ctx, serviceName, volume); err != nil {
			return err
		}
	}
	return nil
}

func runtimeVolumeMountArgs(volumes []runtimeVolumeSpec) []string {
	ordered := append([]runtimeVolumeSpec(nil), volumes...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].MountPath < ordered[j].MountPath })
	args := make([]string, 0, len(ordered)*2)
	for _, volume := range ordered {
		args = append(args, "--mount", fmt.Sprintf("type=volume,src=%s,dst=%s", volume.DockerVolumeName, volume.MountPath))
	}
	return args
}
