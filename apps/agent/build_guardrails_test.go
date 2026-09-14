package main

import (
	"context"
	"strings"
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
