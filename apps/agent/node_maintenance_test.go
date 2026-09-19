package main

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidAgentVersion(t *testing.T) {
	for _, value := range []string{"0.1.14", "1.0.0", "12.345.6789"} {
		if !validAgentVersion(value) {
			t.Fatalf("expected valid version %q", value)
		}
	}
	for _, value := range []string{"", "1", "1.2", "1.2.3-beta", "v1.2.3", "1..3"} {
		if validAgentVersion(value) {
			t.Fatalf("expected invalid version %q", value)
		}
	}
}

func TestRemovableManagedContainer(t *testing.T) {
	cases := []struct {
		name string
		in managedContainerIdentity
		want bool
	}{
		{"backend", managedContainerIdentity{Backend: true}, true},
		{"router", managedContainerIdentity{Role: "runtime-router"}, true},
		{"redis", managedContainerIdentity{Kind: "managed-redis"}, true},
		{"ingress", managedContainerIdentity{Role: "ingress", Backend: true}, false},
		{"unknown", managedContainerIdentity{Role: "other"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := removableManagedContainer(tc.in); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestInstallAgentUpdateUsesAuthenticatedPinnedRelease(t *testing.T) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("maintenance update only supports published Linux architectures")
	}
	current, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(binary))
	nodeID := "22222222-2222-4222-8222-222222222222"
	token := "maintenance-test-token"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("missing node Authorization header")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Header.Get("X-Rundea-Node-Id") != nodeID {
			t.Errorf("missing node id header")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		base := "/v0/agent/releases/" + runtime.GOARCH
		switch r.URL.Path {
		case base + "/sha256":
			_, _ = fmt.Fprintln(w, digest)
		case base:
			_, _ = w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "rundea-agent")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := installAgentUpdate(config{
		ControlPlane: server.URL,
		NodeID: nodeID,
		Token: token,
	}, target)
	if err != nil {
		t.Fatalf("install Agent update: %v", err)
	}
	if result.AgentVersion != currentAgentIdentity().AgentVersion {
		t.Fatalf("unexpected installed version %q", result.AgentVersion)
	}
	installed, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(installed)); got != digest {
		t.Fatalf("installed Agent digest %s want %s", got, digest)
	}
}

func TestInstallAgentUpdateRejectsChecksumMismatch(t *testing.T) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		t.Skip("maintenance update only supports published Linux architectures")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/sha256") {
			_, _ = fmt.Fprintln(w, strings.Repeat("a", 64))
			return
		}
		_, _ = w.Write([]byte("not-the-declared-release"))
	}))
	defer server.Close()

	target := filepath.Join(t.TempDir(), "rundea-agent")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := installAgentUpdate(config{
		ControlPlane: server.URL,
		NodeID: "22222222-2222-4222-8222-222222222222",
		Token: "token",
	}, target)
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
}
