package main

import "testing"

func validCommand() deployCommand {
	var cmd deployCommand
	cmd.DeploymentID = "d1"
	cmd.Source.Repository = "https://github.com/example/repo.git"
	cmd.Source.Ref = "main"
	cmd.Source.Dockerfile = "Dockerfile"
	cmd.Runtime.ContainerName = "svc"
	cmd.Runtime.ContainerPort = 8080
	cmd.Runtime.HostPort = 18080
	return cmd
}

func TestWSURL(t *testing.T) {
	got, err := wsURL("https://rundea.example/api")
	if err != nil {
		t.Fatal(err)
	}
	if got != "wss://rundea.example/api/v0/agent/ws" {
		t.Fatalf("unexpected URL %s", got)
	}
}

func TestValidateCommandAcceptsGitHubHTTPS(t *testing.T) {
	cmd := validCommand()
	if err := validateCommand(cmd); err != nil {
		t.Fatalf("expected valid command: %v", err)
	}
}

func TestValidateCommandRejectsNonGitHubSource(t *testing.T) {
	cmd := validCommand()
	cmd.Source.Repository = "https://example.test/repo.git"
	if validateCommand(cmd) == nil {
		t.Fatal("expected non-GitHub source to be rejected")
	}
}

func TestValidateCommandRejectsPorts(t *testing.T) {
	cmd := validCommand()
	cmd.Runtime.HostPort = 70000
	if validateCommand(cmd) == nil {
		t.Fatal("expected invalid host port")
	}
}
