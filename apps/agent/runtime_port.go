package main

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
)

func parseSingleLoopbackPort(output string) (int, error) {
	ports := map[int]struct{}{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		parts := strings.SplitN(line, " -> ", 2)
		if len(parts) != 2 {
			continue
		}
		host, portText, splitErr := net.SplitHostPort(strings.TrimSpace(parts[1]))
		if splitErr != nil || host != "127.0.0.1" {
			continue
		}
		port, parseErr := strconv.Atoi(portText)
		if parseErr == nil && port >= 1 && port <= 65535 {
			ports[port] = struct{}{}
		}
	}
	if len(ports) != 1 {
		return 0, fmt.Errorf("expected exactly one loopback port, found %d", len(ports))
	}
	for port := range ports {
		return port, nil
	}
	panic("unreachable")
}

// publishedSingleLoopbackPort returns the one host-side loopback port exposed by
// a Rundea workload container. Managed workload backends publish exactly one
// application port; treating additional public or loopback mappings as an error
// keeps restart reconciliation from silently routing to the wrong socket.
func publishedSingleLoopbackPort(ctx context.Context, containerName string) (int, error) {
	out, err := exec.CommandContext(ctx, "docker", "port", containerName).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("resolve runtime backend port after restart: %w: %s", err, strings.TrimSpace(string(out)))
	}
	port, err := parseSingleLoopbackPort(string(out))
	if err != nil {
		return 0, fmt.Errorf("runtime backend %s: %w", containerName, err)
	}
	return port, nil
}
