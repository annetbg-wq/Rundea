package main

import (
	"os"
	"strings"
	"testing"
)

func testRuntimeRoute(service, deployment string, hostPort, backendPort int) runtimeRoute {
	return runtimeRoute{
		ServiceName:      service,
		DeploymentID:     deployment,
		BackendContainer: "rundea-" + service + "-rev-" + strings.ReplaceAll(deployment, "-", "")[:12],
		HostPort:         hostPort,
		BackendPort:      backendPort,
		HealthPath:       "/health",
	}
}

func TestRenderRuntimeRouterCaddyfileUsesStableListenerAndDeploymentMarker(t *testing.T) {
	route := testRuntimeRoute("api", "12345678-1234-4234-9234-123456789abc", 18081, 49152)
	config := renderRuntimeRouterCaddyfile(runtimeRouterState{Version: 1, Routes: []runtimeRoute{route}})
	for _, expected := range []string{
		"admin 127.0.0.1:2020",
		"http://127.0.0.1:18081",
		"reverse_proxy 127.0.0.1:49152",
		"header_down X-Rundea-Deployment 12345678-1234-4234-9234-123456789abc",
	} {
		if !strings.Contains(config, expected) {
			t.Fatalf("runtime router config missing %q:\n%s", expected, config)
		}
	}
}

func TestUpsertRuntimeRouteReplacesServiceWithoutDuplicatingStableListener(t *testing.T) {
	oldRoute := testRuntimeRoute("api", "12345678-1234-4234-9234-123456789abc", 18081, 49152)
	newRoute := testRuntimeRoute("api", "22345678-1234-4234-9234-123456789abc", 18081, 49153)
	state, err := upsertRuntimeRoute(runtimeRouterState{Version: 1, Routes: []runtimeRoute{oldRoute}}, newRoute)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Routes) != 1 || state.Routes[0].DeploymentID != newRoute.DeploymentID || state.Routes[0].BackendPort != 49153 {
		t.Fatalf("unexpected replaced state: %+v", state)
	}
}

func TestUpsertRuntimeRouteRejectsStablePortCollisionAcrossServices(t *testing.T) {
	oldRoute := testRuntimeRoute("api", "12345678-1234-4234-9234-123456789abc", 18081, 49152)
	other := testRuntimeRoute("worker", "22345678-1234-4234-9234-123456789abc", 18081, 49153)
	if _, err := upsertRuntimeRoute(runtimeRouterState{Version: 1, Routes: []runtimeRoute{oldRoute}}, other); err == nil {
		t.Fatal("expected stable port collision to be rejected")
	}
}

func TestRuntimeRouterStateIsPrivateAndRoundTrips(t *testing.T) {
	cfg := config{WorkDir: t.TempDir()}
	route := testRuntimeRoute("api", "12345678-1234-4234-9234-123456789abc", 18081, 49152)
	state := runtimeRouterState{Version: 1, Routes: []runtimeRoute{route}}
	if err := writeRuntimeRouterState(cfg, state); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(runtimeRouterStatePath(cfg))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("runtime route state permissions = %o, want 600", info.Mode().Perm())
	}
	loaded, err := loadRuntimeRouterState(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Routes) != 1 || loaded.Routes[0].DeploymentID != route.DeploymentID {
		t.Fatalf("unexpected loaded state: %+v", loaded)
	}
}

func TestRuntimeRouterRejectsReservedPorts(t *testing.T) {
	for _, port := range []int{80, 443, 2019, 2020} {
		route := testRuntimeRoute("api", "12345678-1234-4234-9234-123456789abc", port, 49152)
		if err := validateRuntimeRoute(route); err == nil {
			t.Fatalf("expected port %d to be reserved", port)
		}
	}
}
