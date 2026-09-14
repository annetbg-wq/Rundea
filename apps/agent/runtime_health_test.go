package main

import (
	"testing"
	"time"
)

func TestAdvanceRuntimeHealthRequiresThreeConsecutiveFailures(t *testing.T) {
	tracker := runtimeHealthTracker{}
	var changed bool
	tracker, changed = advanceRuntimeHealth(tracker, false)
	if tracker.State != "DEGRADED" || tracker.Failures != 1 || !changed {
		t.Fatalf("first failure = %#v changed=%v", tracker, changed)
	}
	tracker, _ = advanceRuntimeHealth(tracker, false)
	if tracker.State != "DEGRADED" || tracker.Failures != 2 {
		t.Fatalf("second failure = %#v", tracker)
	}
	tracker, changed = advanceRuntimeHealth(tracker, false)
	if tracker.State != "DOWN" || tracker.Failures != 3 || !changed {
		t.Fatalf("third failure = %#v changed=%v", tracker, changed)
	}
	cooldown := time.Now().Add(5 * time.Minute).UTC().Truncate(time.Second)
	tracker.RestartAfter = cooldown
	tracker, changed = advanceRuntimeHealth(tracker, true)
	if tracker.State != "HEALTHY" || tracker.Failures != 0 || !tracker.RestartAfter.Equal(cooldown) || !changed {
		t.Fatalf("recovery did not preserve cooldown: %#v changed=%v", tracker, changed)
	}
}

func TestRuntimeHealthStatePersistsRestartCooldown(t *testing.T) {
	cfg := config{WorkDir: t.TempDir()}
	deploymentID := "123e4567-e89b-42d3-a456-426614174000"
	deadline := time.Now().UTC().Add(5 * time.Minute).Truncate(time.Second)
	state := runtimeHealthState{Version: 1, Trackers: map[string]runtimeHealthTracker{
		deploymentID: {State: "DOWN", Failures: 3, RestartAfter: deadline},
	}}
	if err := writeRuntimeHealthState(cfg, state); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadRuntimeHealthState(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.Trackers[deploymentID].RestartAfter.Equal(deadline) {
		t.Fatalf("restart cooldown was not persisted: %#v", loaded.Trackers[deploymentID])
	}
}

func TestSanitizeRuntimeHealthError(t *testing.T) {
	got := sanitizeRuntimeHealthError("line one\nline two\tsecret-free")
	if got != "line one line two secret-free" {
		t.Fatalf("unexpected sanitization %q", got)
	}
}
