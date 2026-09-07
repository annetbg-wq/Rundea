package main

import "testing"

func TestWSURL(t *testing.T) {
	got, err := wsURL("https://rundea.example/api")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://rundea.example/api/v0/agent/ws" {
		t.Fatalf("unexpected URL %s", got)
	}
}

func TestValidateCommandRejectsPorts(t *testing.T) {
	var cmd deployCommand
	cmd.DeploymentID = "d1"
	cmd.Source.Repository = "https://example.test/repo.git"
	cmd.Source.Ref = "main"
	cmd.Source.Dockerfile = "Dockerfile"
	cmd.Runtime.ContainerName = "svc"
	cmd.Runtime.ContainerPort = 8080
	cmd.Runtime.HostPort = 70000
	if validateCommand(cmd) == nil {
		t.Fatal("expected invalid host port")
	}
}
