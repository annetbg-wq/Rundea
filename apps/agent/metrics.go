package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var metricDeploymentIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var dockerSizePattern = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)$`)

const defaultMetricsInterval = 15 * time.Second
const maxSafeMetricCounter uint64 = 9007199254740991

func durationEnv(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func parseDockerPercent(value string) (float64, error) {
	clean := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(value), "%"))
	parsed, err := strconv.ParseFloat(clean, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 || parsed > 100000 {
		return 0, fmt.Errorf("invalid Docker CPU percentage %q", value)
	}
	return parsed, nil
}

func parseDockerBytes(value string) (uint64, error) {
	clean := strings.ToLower(strings.TrimSpace(value))
	match := dockerSizePattern.FindStringSubmatch(clean)
	if match == nil {
		return 0, fmt.Errorf("invalid Docker byte value %q", value)
	}
	number, err := strconv.ParseFloat(match[1], 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0, fmt.Errorf("invalid Docker byte value %q", value)
	}
	multipliers := map[string]float64{
		"b": 1,
		"kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12, "pb": 1e15, "eb": 1e18,
		"kib": 1 << 10, "mib": 1 << 20, "gib": 1 << 30, "tib": 1 << 40, "pib": 1 << 50, "eib": 1 << 60,
	}
	multiplier, ok := multipliers[match[2]]
	if !ok {
		return 0, fmt.Errorf("unsupported Docker byte unit %q", match[2])
	}
	bytes := number * multiplier
	if bytes > float64(^uint64(0)) || math.IsInf(bytes, 0) {
		return 0, fmt.Errorf("Docker byte value overflows uint64")
	}
	return uint64(math.Round(bytes)), nil
}

func parseDockerPair(value string) (uint64, uint64, error) {
	parts := strings.Split(value, "/")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid Docker metric pair %q", value)
	}
	left, err := parseDockerBytes(parts[0])
	if err != nil {
		return 0, 0, err
	}
	right, err := parseDockerBytes(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return left, right, nil
}

type managedContainer struct {
	ID           string
	DeploymentID string
}

type dockerMetricSample struct {
	CPUPercent       float64
	MemoryUsageBytes uint64
	MemoryLimitBytes uint64
	NetworkRxBytes   uint64
	NetworkTxBytes   uint64
}

func (sample dockerMetricSample) validateTransportRange() error {
	for name, value := range map[string]uint64{
		"memory usage": sample.MemoryUsageBytes,
		"memory limit": sample.MemoryLimitBytes,
		"network receive": sample.NetworkRxBytes,
		"network transmit": sample.NetworkTxBytes,
	} {
		if value > maxSafeMetricCounter {
			return fmt.Errorf("%s metric exceeds JSON-safe integer range", name)
		}
	}
	return nil
}

func listManagedContainers(ctx context.Context) ([]managedContainer, error) {
	out, err := exec.CommandContext(ctx, "docker", "ps", "--filter", "label=rundea.managed=true", "--format", `{{.ID}}\t{{.Label "rundea.deployment"}}`).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker ps for metrics: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var containers []managedContainer
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 || !metricDeploymentIDPattern.MatchString(fields[1]) {
			continue
		}
		containers = append(containers, managedContainer{ID: fields[0], DeploymentID: strings.ToLower(fields[1])})
	}
	return containers, nil
}

func sampleDockerContainer(ctx context.Context, containerID string) (dockerMetricSample, error) {
	out, err := exec.CommandContext(ctx, "docker", "stats", "--no-stream", "--format", `{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}`, containerID).CombinedOutput()
	if err != nil {
		return dockerMetricSample{}, fmt.Errorf("docker stats: %w: %s", err, strings.TrimSpace(string(out)))
	}
	parts := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(parts) != 3 {
		return dockerMetricSample{}, fmt.Errorf("unexpected docker stats format")
	}
	cpu, err := parseDockerPercent(parts[0])
	if err != nil {
		return dockerMetricSample{}, err
	}
	memoryUsage, memoryLimit, err := parseDockerPair(parts[1])
	if err != nil {
		return dockerMetricSample{}, fmt.Errorf("memory stats: %w", err)
	}
	rx, tx, err := parseDockerPair(parts[2])
	if err != nil {
		return dockerMetricSample{}, fmt.Errorf("network stats: %w", err)
	}
	sample := dockerMetricSample{
		CPUPercent:       cpu,
		MemoryUsageBytes: memoryUsage,
		MemoryLimitBytes: memoryLimit,
		NetworkRxBytes:   rx,
		NetworkTxBytes:   tx,
	}
	if err := sample.validateTransportRange(); err != nil {
		return dockerMetricSample{}, err
	}
	return sample, nil
}

func collectRuntimeMetrics(ctx context.Context, w *writer) error {
	containers, err := listManagedContainers(ctx)
	if err != nil {
		return err
	}
	var firstErr error
	for _, container := range containers {
		sample, err := sampleDockerContainer(ctx, container.ID)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if err := w.send(map[string]any{
			"type":             "metric",
			"deploymentId":     container.DeploymentID,
			"cpuPercent":       sample.CPUPercent,
			"memoryUsageBytes": sample.MemoryUsageBytes,
			"memoryLimitBytes": sample.MemoryLimitBytes,
			"networkRxBytes":   sample.NetworkRxBytes,
			"networkTxBytes":   sample.NetworkTxBytes,
			"at":               time.Now().UTC().Format(time.RFC3339Nano),
		}); err != nil {
			return err
		}
	}
	return firstErr
}

func runMetricsLoop(ctx context.Context, w *writer, interval time.Duration) {
	if interval < time.Second {
		interval = time.Second
	}
	if interval > 5*time.Minute {
		interval = 5 * time.Minute
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	lastError := ""
	sample := func() {
		err := collectRuntimeMetrics(ctx, w)
		if err == nil {
			lastError = ""
			return
		}
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return
		}
		message := err.Error()
		if message != lastError {
			log.Printf("runtime metrics sampling degraded: %s", message)
			lastError = message
		}
	}

	sample()
	for {
		select {
		case <-ticker.C:
			sample()
		case <-ctx.Done():
			return
		}
	}
}
