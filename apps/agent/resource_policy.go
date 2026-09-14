package main

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

const (
	runtimeCPUQuota             = "1.0"
	runtimeMemoryLimit          = "768m"
	runtimePidsLimit            = "256"
	runtimeLogMaxSize           = "10m"
	runtimeLogMaxFiles          = "3"
	buildMemoryLimit            = "1024m"
	buildCPUPeriod              = "100000"
	buildCPUQuota               = "100000"
	buildTimeout                = 15 * time.Minute
	minimumFreeDiskBytes uint64 = 2 * 1024 * 1024 * 1024
	minimumFreeDiskPercent      = 10
)

func runtimeResourceArgs() []string {
	return []string{
		"--cpus", runtimeCPUQuota,
		"--memory", runtimeMemoryLimit,
		"--memory-swap", runtimeMemoryLimit,
		"--pids-limit", runtimePidsLimit,
		"--log-driver", "json-file",
		"--log-opt", "max-size=" + runtimeLogMaxSize,
		"--log-opt", "max-file=" + runtimeLogMaxFiles,
	}
}

func buildResourceArgs() []string {
	return []string{
		"--memory", buildMemoryLimit,
		"--memory-swap", buildMemoryLimit,
		"--cpu-period", buildCPUPeriod,
		"--cpu-quota", buildCPUQuota,
	}
}

func validateDiskHeadroom(freeBytes, totalBytes uint64) error {
	if totalBytes == 0 {
		return errors.New("node disk capacity could not be determined")
	}
	if freeBytes < minimumFreeDiskBytes {
		return fmt.Errorf("node disk headroom is too low: %d MiB free, Rundea requires at least %d MiB", freeBytes/(1024*1024), minimumFreeDiskBytes/(1024*1024))
	}
	if freeBytes*100 < totalBytes*minimumFreeDiskPercent {
		return fmt.Errorf("node disk headroom is too low: %.1f%% free, Rundea requires at least %d%%", float64(freeBytes)*100/float64(totalBytes), minimumFreeDiskPercent)
	}
	return nil
}

func requireDiskHeadroom(path string) error {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return fmt.Errorf("inspect node disk headroom for %s: %w", path, err)
	}
	freeBytes := stat.Bavail * uint64(stat.Bsize)
	totalBytes := stat.Blocks * uint64(stat.Bsize)
	return validateDiskHeadroom(freeBytes, totalBytes)
}
