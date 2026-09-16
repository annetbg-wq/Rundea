package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestSplitRuntimeVolumeMetadataStripsInternalTransport(t *testing.T) {
	deploymentID := "11111111-1111-4111-8111-111111111111"
	values := map[string]string{
		"APP_MODE": "test",
		runtimeVolumeMetadataKey: `[{"volumeId":"22222222-2222-4222-8222-222222222222","name":"data","dockerVolumeName":"rundea-vol-22222222222242228222222222222222","mountPath":"/data"}]`,
	}
	clean, err := splitRuntimeVolumeMetadata(deploymentID, values)
	defer clearRuntimeVolumes(deploymentID)
	if err != nil {
		t.Fatalf("split metadata: %v", err)
	}
	if !reflect.DeepEqual(clean, map[string]string{"APP_MODE": "test"}) {
		t.Fatalf("internal transport leaked into runtime env: %#v", clean)
	}
	volumes := runtimeVolumesForDeployment(deploymentID)
	if len(volumes) != 1 || volumes[0].MountPath != "/data" || volumes[0].Name != "data" {
		t.Fatalf("unexpected runtime volumes: %#v", volumes)
	}
}

func TestValidateRuntimeVolumesRejectsAmbiguousMountPath(t *testing.T) {
	volume := runtimeVolumeSpec{
		VolumeID: "22222222-2222-4222-8222-222222222222",
		Name: "data",
		DockerVolumeName: "rundea-vol-22222222222242228222222222222222",
		MountPath: "/data,bad",
	}
	if err := validateRuntimeVolumes([]runtimeVolumeSpec{volume}); err == nil {
		t.Fatal("mount path containing comma must be rejected")
	}
}

func TestRuntimeVolumeMountArgsAreDeterministic(t *testing.T) {
	volumes := []runtimeVolumeSpec{
		{VolumeID: "33333333-3333-4333-8333-333333333333", Name: "z", DockerVolumeName: "rundea-vol-33333333333343338333333333333333", MountPath: "/z"},
		{VolumeID: "22222222-2222-4222-8222-222222222222", Name: "a", DockerVolumeName: "rundea-vol-22222222222242228222222222222222", MountPath: "/a"},
	}
	args := runtimeVolumeMountArgs(volumes)
	joined := strings.Join(args, " ")
	if joined != "--mount type=volume,src=rundea-vol-22222222222242228222222222222222,dst=/a --mount type=volume,src=rundea-vol-33333333333343338333333333333333,dst=/z" {
		t.Fatalf("unexpected mount args: %s", joined)
	}
}