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

func applyBuildMemoryLimit(args []string, memoryBytes uint64) ([]string, error) {
	if memoryBytes < minimumBuildMemoryLimitBytes || memoryBytes > buildMemoryLimitBytes {
		return nil, fmt.Errorf("invalid adaptive build memory limit %d MiB", memoryBytes/(1024*1024))
	}
	memoryLimit := fmt.Sprintf("%dm", memoryBytes/(1024*1024))
	out := append([]string(nil), args...)
	memorySeen := false
	swapSeen := false
	for i := 0; i+1 < len(out); i++ {
		switch out[i] {
		case "--memory":
			out[i+1] = memoryLimit
			memorySeen = true
		case "--memory-swap":
			out[i+1] = memoryLimit
			swapSeen = true
		}
	}
	if !memorySeen || !swapSeen {
		return nil, errors.New("docker build args are missing Rundea memory guardrails")
	}
	return out, nil
}

func runGuardedDockerBuild(ctx context.Context, sourceDir string, w *writer, deploymentID string, args []string) error {
	// Disk may have changed materially during source checkout or build-plan
	// preparation, so re-check immediately before Docker is allowed to build.
	if err := requireDiskHeadroom(sourceDir); err != nil {
		return fmt.Errorf("build admission: %w", err)
	}
	memoryLimitBytes, err := nodeBuildMemoryLimitBytes(ctx)
	if err != nil {
		return err
	}
	guardedArgs, err := applyBuildMemoryLimit(args, memoryLimitBytes)
	if err != nil {
		return fmt.Errorf("build admission: %w", err)
	}
	if memoryLimitBytes < buildMemoryLimitBytes {
		w.log(deploymentID, "system", fmt.Sprintf(
			"constrained node: Docker build memory cap reduced from %d MiB to %d MiB while preserving Rundea system reserve",
			buildMemoryLimitBytes/(1024*1024), memoryLimitBytes/(1024*1024),
		))
	}
	return runWithBuildTimeout(ctx, buildTimeout, func(buildCtx context.Context) error {
		return runWithSafetyMonitor(buildCtx, buildDiskMonitorInterval, func() error {
			return requireDiskHeadroom(sourceDir)
		}, func(safetyCtx context.Context) error {
			return runStreamingIn(safetyCtx, sourceDir, w, deploymentID, "build", "docker", guardedArgs...)
		})
	})
}
