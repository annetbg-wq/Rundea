package main

import "testing"

func validRollbackFixture() rollbackCommand {
	cmd := rollbackCommand{}
	cmd.DeploymentID = "11111111-1111-4111-8111-111111111111"
	cmd.TargetDeploymentID = "22222222-2222-4222-8222-222222222222"
	cmd.ExpectedImageID = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cmd.ServiceName = "sendina"
	cmd.Runtime.ContainerName = "rundea-sendina"
	cmd.Runtime.ContainerPort = 8080
	cmd.Runtime.HostPort = 18080
	cmd.Runtime.Healthcheck.Path = "/api/health"
	cmd.Runtime.Healthcheck.TimeoutSeconds = 60
	return cmd
}

func TestValidateRollbackCommandAcceptsImmutableArtifact(t *testing.T) {
	cmd := validRollbackFixture()
	if err := validateRollbackCommand(cmd); err != nil {
		t.Fatalf("expected rollback command to be valid: %v", err)
	}
}

func TestValidateRollbackCommandRejectsMutableOrInvalidArtifactIdentity(t *testing.T) {
	for _, imageID := range []string{"", "latest", "sha256:abc", "sha256:ZZZZaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"} {
		cmd := validRollbackFixture()
		cmd.ExpectedImageID = imageID
		if err := validateRollbackCommand(cmd); err == nil {
			t.Fatalf("expected image identity %q to be rejected", imageID)
		}
	}
}

func TestValidateRollbackCommandRejectsInvalidPorts(t *testing.T) {
	cmd := validRollbackFixture()
	cmd.Runtime.HostPort = 70000
	if err := validateRollbackCommand(cmd); err == nil {
		t.Fatal("expected invalid host port to be rejected")
	}

	cmd = validRollbackFixture()
	cmd.Runtime.ContainerPort = 0
	if err := validateRollbackCommand(cmd); err == nil {
		t.Fatal("expected invalid container port to be rejected")
	}
}

func TestDockerImageIDPatternRequiresContentAddress(t *testing.T) {
	if !dockerImageIDPattern.MatchString("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef") {
		t.Fatal("expected valid Docker content address")
	}
	if dockerImageIDPattern.MatchString("rundea/sendina:build") {
		t.Fatal("mutable image tag must not be accepted as artifact identity")
	}
}

func TestValidateRollbackCommandAcceptsRegistryFallback(t *testing.T) {
	cmd := validRollbackFixture()
	cmd.Artifact = &struct {
		ImageRef           string `json:"imageRef"`
		SourceCommitSHA    string `json:"sourceCommitSha"`
		RegistryAuthTicket string `json:"registryAuthTicket,omitempty"`
	}{
		ImageRef:        "registry.example.test/acme/sendina@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		SourceCommitSHA: "cccccccccccccccccccccccccccccccccccccccc",
	}
	if err := validateRollbackCommand(cmd); err != nil {
		t.Fatalf("expected registry-backed rollback command to be valid: %v", err)
	}
}

func TestValidateRollbackCommandRejectsMutableRegistryFallback(t *testing.T) {
	cmd := validRollbackFixture()
	cmd.Artifact = &struct {
		ImageRef           string `json:"imageRef"`
		SourceCommitSHA    string `json:"sourceCommitSha"`
		RegistryAuthTicket string `json:"registryAuthTicket,omitempty"`
	}{
		ImageRef:        "registry.example.test/acme/sendina:latest",
		SourceCommitSHA: "cccccccccccccccccccccccccccccccccccccccc",
	}
	if err := validateRollbackCommand(cmd); err == nil {
		t.Fatal("expected mutable registry rollback artifact to be rejected")
	}
}
