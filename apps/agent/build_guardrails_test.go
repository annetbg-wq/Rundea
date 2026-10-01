package main

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunWithBuildTimeoutAllowsCompletedBuild(t *testing.T) {
	err := runWithBuildTimeout(context.Background(), time.Second, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("completed build rejected: %v", err)
	}
}

func TestRunWithBuildTimeoutStopsHungBuild(t *testing.T) {
	start := time.Now()
	err := runWithBuildTimeout(context.Background(), 20*time.Millisecond, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	if err == nil || !strings.Contains(err.Error(), "build exceeded maximum duration") {
		t.Fatalf("expected build timeout error, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("build timeout did not cancel promptly: %s", elapsed)
	}
}

func TestRunWithSafetyMonitorCancelsBuildWhenSafetyFloorIsCrossed(t *testing.T) {
	var checks atomic.Int32
	err := runWithSafetyMonitor(context.Background(), 5*time.Millisecond, func() error {
		if checks.Add(1) >= 2 {
			return errors.New("disk headroom is too low")
		}
		return nil
	}, func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	})
	if err == nil || !strings.Contains(err.Error(), "build stopped to preserve node safety") || !strings.Contains(err.Error(), "disk headroom") {
		t.Fatalf("expected safety cancellation, got %v", err)
	}
}

func TestApplyBuildMemoryLimitPreservesOtherGuardrails(t *testing.T) {
	mib := uint64(1024 * 1024)
	args := []string{
		"build",
		"--memory", "1024m",
		"--memory-swap", "1024m",
		"--cpu-period", "100000",
		"--cpu-quota", "100000",
		"--pull", ".",
	}
	got, err := applyBuildMemoryLimit(args, 1003*mib)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, " ")
	if !strings.Contains(joined, "--memory 1003m") || !strings.Contains(joined, "--memory-swap 1003m") {
		t.Fatalf("adaptive memory limit not applied: %s", joined)
	}
	if !strings.Contains(joined, "--cpu-period 100000 --cpu-quota 100000") {
		t.Fatalf("CPU guardrails changed unexpectedly: %s", joined)
	}
	if strings.Contains(strings.Join(args, " "), "1003m") {
		t.Fatal("applyBuildMemoryLimit mutated caller args")
	}
}

func TestApplyBuildMemoryLimitRejectsUnsafeOrMalformedArgs(t *testing.T) {
	mib := uint64(1024 * 1024)
	if _, err := applyBuildMemoryLimit([]string{"build", "--memory", "1024m"}, 768*mib); err == nil {
		t.Fatal("missing memory-swap guardrail must fail")
	}
	if _, err := applyBuildMemoryLimit([]string{"build", "--memory", "1024m", "--memory-swap", "1024m"}, 511*mib); err == nil {
		t.Fatal("sub-minimum adaptive limit must fail")
	}
}
