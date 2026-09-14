package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const buildDiskMonitorInterval = 500 * time.Millisecond

func runWithBuildTimeout(ctx context.Context, timeout time.Duration, run func(context.Context) error) error {
	buildCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	err := run(buildCtx)
	if errors.Is(buildCtx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("build exceeded maximum duration %s", timeout)
	}
	return err
}

func runWithSafetyMonitor(ctx context.Context, interval time.Duration, check func() error, run func(context.Context) error) error {
	guardedCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	result := make(chan error, 1)
	go func() { result <- run(guardedCtx) }()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case err := <-result:
			return err
		case <-ticker.C:
			if err := check(); err != nil {
				cancel()
				<-result
				return fmt.Errorf("build stopped to preserve node safety: %w", err)
			}
		case <-ctx.Done():
			cancel()
			<-result
			return ctx.Err()
		}
	}
}

func runGuardedDockerBuild(ctx context.Context, sourceDir string, w *writer, deploymentID string, args []string) error {
	// Disk may have changed materially during source checkout or build-plan
	// preparation, so re-check immediately before Docker is allowed to build.
	if err := requireDiskHeadroom(sourceDir); err != nil {
		return fmt.Errorf("build admission: %w", err)
	}
	if err := requireNodeMemoryCapacity(ctx, buildMemoryLimitBytes, "build admission"); err != nil {
		return err
	}
	return runWithBuildTimeout(ctx, buildTimeout, func(buildCtx context.Context) error {
		return runWithSafetyMonitor(buildCtx, buildDiskMonitorInterval, func() error {
			return requireDiskHeadroom(sourceDir)
		}, func(safetyCtx context.Context) error {
			return runStreamingIn(safetyCtx, sourceDir, w, deploymentID, "build", "docker", args...)
		})
	})
}
