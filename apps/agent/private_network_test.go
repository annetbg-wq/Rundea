package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestSplitRuntimeProjectNetworkMetadataStripsInternalTransport(t *testing.T) {
	deploymentID := "11111111-1111-4111-8111-111111111111"
	values := map[string]string{
		"APP_MODE": "test",
		runtimeProjectNetworkMetadataKey: `{"projectId":"22222222-2222-4222-8222-222222222222","serviceAlias":"api"}`,
	}
	clean, err := splitRuntimeProjectNetworkMetadata(deploymentID, values)
	defer clearRuntimeProjectNetwork(deploymentID)
	if err != nil {
		t.Fatalf("split metadata: %v", err)
	}
	if !reflect.DeepEqual(clean, map[string]string{"APP_MODE": "test"}) {
		t.Fatalf("internal network transport leaked into runtime env: %#v", clean)
	}
	spec, ok := runtimeProjectNetworkForDeployment(deploymentID)
	if !ok || spec.ProjectID != "22222222-2222-4222-8222-222222222222" || spec.ServiceAlias != "api" {
		t.Fatalf("unexpected project network: %#v, ok=%v", spec, ok)
	}
}

func TestRuntimeProjectNetworkNameIsProjectScopedAndDeterministic(t *testing.T) {
	one := runtimeProjectNetworkName("22222222-2222-4222-8222-222222222222")
	two := runtimeProjectNetworkName("33333333-3333-4333-8333-333333333333")
	if one != "rundea-project-22222222222242228222222222222222" {
		t.Fatalf("unexpected project network name: %s", one)
	}
	if one == two {
		t.Fatal("different projects must not share a Docker network name")
	}
}

func TestRuntimeProjectNetworkArgsExposeOnlyPrivateNetworkAndAlias(t *testing.T) {
	spec := runtimeProjectNetworkSpec{
		ProjectID: "22222222-2222-4222-8222-222222222222",
		ServiceAlias: "api",
	}
	joined := strings.Join(runtimeProjectNetworkArgs(spec), " ")
	if joined != "--network rundea-project-22222222222242228222222222222222 --network-alias api" {
		t.Fatalf("unexpected project network args: %s", joined)
	}
}

func TestValidateRuntimeProjectNetworkRejectsUnsafeAlias(t *testing.T) {
	if err := validateRuntimeProjectNetwork(runtimeProjectNetworkSpec{
		ProjectID: "22222222-2222-4222-8222-222222222222",
		ServiceAlias: "API_bad",
	}); err == nil {
		t.Fatal("unsafe network alias must be rejected")
	}
}
