package main

import (
	"strings"
	"testing"
)

func TestSplitRuntimeManagedRedisMetadataInjectsOnlyPrivateURL(t *testing.T) {
	deploymentID := "11111111-1111-4111-8111-111111111111"
	values := map[string]string{
		"APP_MODE": "test",
		runtimeManagedRedisMetadataKey: `{"addonId":"22222222-2222-4222-8222-222222222222","projectId":"33333333-3333-4333-8333-333333333333","alias":"redis","dockerVolumeName":"rundea-redis-22222222222242228222222222222222","password":"abcdefghijklmnopqrstuvwxyzABCDEFGH123456789"}`,
	}
	clean, err := splitRuntimeManagedRedisMetadata(deploymentID, values)
	defer clearManagedRedis(deploymentID)
	if err != nil {
		t.Fatalf("split managed Redis metadata: %v", err)
	}
	if clean["APP_MODE"] != "test" {
		t.Fatalf("application environment was changed: %#v", clean)
	}
	if _, ok := clean[runtimeManagedRedisMetadataKey]; ok {
		t.Fatal("internal managed Redis transport leaked into application environment")
	}
	if !strings.HasPrefix(clean["REDIS_URL"], "redis://:") || !strings.HasSuffix(clean["REDIS_URL"], "@redis:6379/0") {
		t.Fatalf("unexpected private Redis URL: %q", clean["REDIS_URL"])
	}
	spec, ok := managedRedisForDeployment(deploymentID)
	if !ok || spec.ProjectID != "33333333-3333-4333-8333-333333333333" || spec.Alias != "redis" {
		t.Fatalf("unexpected managed Redis spec: %#v, ok=%v", spec, ok)
	}
}

func TestManagedRedisRejectsPublicOrUnsafeConfiguration(t *testing.T) {
	for _, spec := range []managedRedisSpec{
		{AddonID: "bad", ProjectID: "33333333-3333-4333-8333-333333333333", Alias: "redis", DockerVolumeName: "rundea-redis-22222222222242228222222222222222", Password: strings.Repeat("a", 43)},
		{AddonID: "22222222-2222-4222-8222-222222222222", ProjectID: "33333333-3333-4333-8333-333333333333", Alias: "redis:6379", DockerVolumeName: "rundea-redis-22222222222242228222222222222222", Password: strings.Repeat("a", 43)},
		{AddonID: "22222222-2222-4222-8222-222222222222", ProjectID: "33333333-3333-4333-8333-333333333333", Alias: "redis", DockerVolumeName: "foreign-volume", Password: strings.Repeat("a", 43)},
	} {
		if err := validateManagedRedisSpec(spec); err == nil {
			t.Fatalf("unsafe managed Redis spec was accepted: %#v", spec)
		}
	}
}

func TestManagedRedisContainerNameIsDeterministic(t *testing.T) {
	name := managedRedisContainerName("22222222-2222-4222-8222-222222222222")
	if name != "rundea-redis-22222222222242228222222222222222" {
		t.Fatalf("unexpected container name: %s", name)
	}
}
