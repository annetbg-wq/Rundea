package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

func runWithBuildTimeout(ctx context.Context, timeout time.Duration, run func(context.Context) error) error {
	buildCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	err := run(buildCtx)
	if errors.Is(buildCtx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("build exceeded maximum duration %s", timeout)
	}
	return err
}

func runGuardedDockerBuild(ctx context.Context, sourceDir string, w *writer, deploymentID string, args []string) error {
	// Disk may have changed materially during source checkout or build-plan
	// preparation, so re-check immediately before Docker is allowed to build.
	if err := requireDiskHeadroom(sourceDir); err != nil {
		return fmt.Errorf("build admission: %w", err)
	}
	return runWithBuildTimeout(ctx, buildTimeout, func(buildCtx context.Context) error {
		return runStreamingIn(buildCtx, sourceDir, w, deploymentID, "build", "docker", args...)
	})
}
