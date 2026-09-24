package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegistryHostFromImageRef(t *testing.T) {
	digest := "sha256:" + repeatHexForPrebuiltTest("a", 64)
	host, err := registryHostFromImageRef("localhost:5000/acme/app@" + digest)
	if err != nil {
		t.Fatal(err)
	}
	if host != "localhost:5000" {
		t.Fatalf("unexpected host %q", host)
	}
	if _, err := registryHostFromImageRef("app@" + digest); err == nil {
		t.Fatal("expected implicit registry host to be rejected")
	}
}

func TestFetchRegistryPullCredentialsValidatesBoundRegistryHost(t *testing.T) {
	digest := "sha256:" + repeatHexForPrebuiltTest("b", 64)
	imageRef := "registry.example.test/acme/app@" + digest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ticket" {
			t.Fatalf("unexpected authorization header %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Rundea-Node-Id") != "node-1" {
			t.Fatalf("unexpected node header %q", r.Header.Get("X-Rundea-Node-Id"))
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"server": "registry.example.test",
			"username": "pull-only",
			"password": "secret",
		})
	}))
	defer server.Close()

	credentials, err := fetchRegistryPullCredentials(context.Background(), config{
		ControlPlane: server.URL,
		NodeID: "node-1",
	}, "deployment-1", "ticket", imageRef)
	if err != nil {
		t.Fatal(err)
	}
	if credentials == nil || credentials.Server != "registry.example.test" || credentials.Username != "pull-only" || credentials.Password != "secret" {
		t.Fatalf("unexpected credentials %#v", credentials)
	}
}

func TestFetchRegistryPullCredentialsRejectsWrongRegistryHost(t *testing.T) {
	digest := "sha256:" + repeatHexForPrebuiltTest("c", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"server": "wrong.example.test",
			"username": "pull-only",
			"password": "secret",
		})
	}))
	defer server.Close()

	if _, err := fetchRegistryPullCredentials(context.Background(), config{
		ControlPlane: server.URL,
		NodeID: "node-1",
	}, "deployment-1", "ticket", "registry.example.test/acme/app@"+digest); err == nil {
		t.Fatal("expected registry host mismatch to be rejected")
	}
}
