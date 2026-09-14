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
