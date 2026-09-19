package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const (
	minimumSystemReserveBytes uint64 = 768 * 1024 * 1024
	runtimeMemoryLimitBytes   uint64 = 768 * 1024 * 1024
	buildMemoryLimitBytes     uint64 = 1024 * 1024 * 1024
)

func systemReserveBytes(totalBytes uint64) uint64 {
	percentage := totalBytes / 5
	if percentage < minimumSystemReserveBytes {
		return minimumSystemReserveBytes
	}
	return percentage
}

func validateNodeMemoryCapacity(totalBytes, committedBytes, incomingBytes uint64) error {
	if totalBytes == 0 {
		return errors.New("node memory capacity could not be determined")
	}
	reserveBytes := systemReserveBytes(totalBytes)
	if committedBytes > totalBytes || incomingBytes > totalBytes || committedBytes > ^uint64(0)-incomingBytes {
		return errors.New("node memory commitments exceed addressable capacity")
	}
	workloadBytes := committedBytes + incomingBytes
	if workloadBytes > totalBytes || reserveBytes > totalBytes-workloadBytes {
		return fmt.Errorf(
			"node memory capacity is exhausted: %d MiB committed + %d MiB incoming + %d MiB Rundea reserve exceeds %d MiB total",
			committedBytes/(1024*1024), incomingBytes/(1024*1024), reserveBytes/(1024*1024), totalBytes/(1024*1024),
		)
	}
	return nil
}

func parseMemTotalBytes(reader io.Reader) (uint64, error) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 3 || fields[0] != "MemTotal:" || fields[2] != "kB" {
			continue
		}
		kilobytes, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || kilobytes == 0 || kilobytes > ^uint64(0)/1024 {
			return 0, errors.New("node memory capacity is invalid")
		}
		return kilobytes * 1024, nil
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("read node memory capacity: %w", err)
	}
	return 0, errors.New("node memory capacity is missing MemTotal")
}

func nodeTotalMemoryBytes() (uint64, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, fmt.Errorf("open node memory information: %w", err)
	}
	defer file.Close()
	return parseMemTotalBytes(file)
}

func runningManagedBackendMemoryBytes(ctx context.Context) (uint64, error) {
	out, err := exec.CommandContext(
		ctx,
		"docker", "ps", "-q",
		"--filter", "label=rundea.managed=true",
	).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("list Rundea managed workloads: %w: %s", err, strings.TrimSpace(string(out)))
	}

	var total uint64
	for _, id := range strings.Fields(string(out)) {
		inspect, inspectErr := exec.CommandContext(
			ctx,
			"docker", "inspect", "--format",
			`{{.HostConfig.Memory}}|{{.State.Running}}|{{ index .Config.Labels "rundea.managed" }}|{{ index .Config.Labels "rundea.backend" }}|{{ index .Config.Labels "rundea.kind" }}`,
			id,
		).CombinedOutput()
		if inspectErr != nil {
			return 0, fmt.Errorf("inspect Rundea managed workload %s: %w: %s", id, inspectErr, strings.TrimSpace(string(inspect)))
		}
		parts := strings.Split(strings.TrimSpace(string(inspect)), "|")
		if len(parts) != 5 {
			return 0, fmt.Errorf("inspect Rundea managed workload %s returned unexpected capacity fields", id)
		}
		if parts[1] != "true" {
			continue
		}
		if parts[2] != "true" {
			return 0, fmt.Errorf("container %s matched Rundea discovery without Rundea ownership label", id)
		}
		isRuntimeBackend := parts[3] == "true"
		isManagedRedis := parts[4] == "managed-redis"
		if !isRuntimeBackend && !isManagedRedis {
			continue
		}
		memory, parseErr := strconv.ParseUint(parts[0], 10, 64)
		if parseErr != nil || memory == 0 {
			return 0, fmt.Errorf("Rundea managed workload %s has no enforceable hard memory limit", id)
		}
		if total > ^uint64(0)-memory {
			return 0, errors.New("Rundea managed workload memory commitments overflow capacity accounting")
		}
		total += memory
	}
	return total, nil
}

func requireNodeMemoryCapacity(ctx context.Context, incomingBytes uint64, operation string) error {
	totalBytes, err := nodeTotalMemoryBytes()
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	committedBytes, err := runningManagedBackendMemoryBytes(ctx)
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	if err := validateNodeMemoryCapacity(totalBytes, committedBytes, incomingBytes); err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	return nil
}
