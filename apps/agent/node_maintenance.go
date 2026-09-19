package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const maxAgentUpdateBytes = 64 * 1024 * 1024

type updateAgentCommand struct {
	Type     string `json:"type"`
	ActionID string `json:"actionId"`
}

type cleanupNodeCommand struct {
	Type     string `json:"type"`
	ActionID string `json:"actionId"`
}

type maintenanceResult struct {
	AgentVersion string
	BuildSHA     string
}

func validateMaintenanceActionID(value string) error {
	value = strings.TrimSpace(value)
	if !reconciliationIDPattern.MatchString(strings.ToLower(value)) {
		return errors.New("invalid node maintenance action id")
	}
	return nil
}

func maintenanceEvent(w *writer, actionID, kind string, ok bool, result maintenanceResult, err error) {
	event := map[string]any{
		"type": "nodeMaintenance", "actionId": actionID, "kind": kind, "ok": ok,
		"completedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}
	if result.AgentVersion != "" {
		event["agentVersion"] = result.AgentVersion
	}
	if result.BuildSHA != "" {
		event["buildSha"] = result.BuildSHA
	}
	if err != nil {
		event["error"] = sanitizeProbeError(err.Error())
	}
	_ = w.send(event)
}

func maintenanceArchitecture() (string, error) {
	switch runtime.GOARCH {
	case "amd64", "arm64":
		return runtime.GOARCH, nil
	default:
		return "", fmt.Errorf("unsupported Agent update architecture %q", runtime.GOARCH)
	}
}

func authenticatedReleaseGet(cfg config, endpoint string, maxBytes int64) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("X-Rundea-Node-Id", cfg.NodeID)
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("Agent release endpoint returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("Agent release exceeds %d bytes", maxBytes)
	}
	return body, nil
}

func validAgentVersion(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func validateDownloadedAgentIdentity(path string) (maintenanceResult, error) {
	out, err := exec.Command(path, "--identity").CombinedOutput()
	if err != nil {
		return maintenanceResult{}, fmt.Errorf("updated Agent identity check failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var identity agentIdentity
	if err := json.Unmarshal(out, &identity); err != nil {
		return maintenanceResult{}, fmt.Errorf("updated Agent identity is invalid JSON: %w", err)
	}
	if !validAgentVersion(strings.TrimSpace(identity.AgentVersion)) {
		return maintenanceResult{}, fmt.Errorf("updated Agent reports invalid version %q", identity.AgentVersion)
	}
	if strings.TrimSpace(identity.BuildSHA) == "" {
		return maintenanceResult{}, errors.New("updated Agent reports an empty build SHA")
	}
	capabilities := make(map[string]struct{}, len(identity.Capabilities))
	for _, capability := range identity.Capabilities {
		capabilities[capability] = struct{}{}
	}
	for _, required := range declaredAgentCapabilities {
		if _, ok := capabilities[required]; !ok {
			return maintenanceResult{}, fmt.Errorf("updated Agent is missing required capability %s", required)
		}
	}
	return maintenanceResult{
		AgentVersion: strings.TrimSpace(identity.AgentVersion),
		BuildSHA: strings.TrimSpace(identity.BuildSHA),
	}, nil
}

func installAgentUpdate(cfg config, executablePath string) (maintenanceResult, error) {
	arch, err := maintenanceArchitecture()
	if err != nil {
		return maintenanceResult{}, err
	}
	base := strings.TrimRight(cfg.ControlPlane, "/") + "/v0/agent/releases/" + arch
	checksumRaw, err := authenticatedReleaseGet(cfg, base+"/sha256", 1024)
	if err != nil {
		return maintenanceResult{}, fmt.Errorf("fetch Agent checksum: %w", err)
	}
	expected := strings.ToLower(strings.TrimSpace(string(checksumRaw)))
	if len(expected) != 64 {
		return maintenanceResult{}, errors.New("Agent release checksum is not 64 hex characters")
	}
	if _, err := hex.DecodeString(expected); err != nil {
		return maintenanceResult{}, errors.New("Agent release checksum is not valid hex")
	}

	binary, err := authenticatedReleaseGet(cfg, base, maxAgentUpdateBytes)
	if err != nil {
		return maintenanceResult{}, fmt.Errorf("fetch Agent release: %w", err)
	}
	actual := fmt.Sprintf("%x", sha256.Sum256(binary))
	if actual != expected {
		return maintenanceResult{}, errors.New("Agent release checksum mismatch")
	}

	executablePath, err = filepath.Abs(executablePath)
	if err != nil {
		return maintenanceResult{}, err
	}
	dir := filepath.Dir(executablePath)
	tmp, err := os.CreateTemp(dir, ".rundea-agent-update-*")
	if err != nil {
		return maintenanceResult{}, fmt.Errorf("create Agent update file: %w", err)
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmp.Write(binary); err != nil {
		return maintenanceResult{}, fmt.Errorf("write Agent update: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return maintenanceResult{}, fmt.Errorf("sync Agent update: %w", err)
	}
	if err := tmp.Chmod(0o755); err != nil {
		return maintenanceResult{}, fmt.Errorf("chmod Agent update: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return maintenanceResult{}, fmt.Errorf("close Agent update: %w", err)
	}

	result, err := validateDownloadedAgentIdentity(tmpPath)
	if err != nil {
		return maintenanceResult{}, err
	}
	if err := os.Rename(tmpPath, executablePath); err != nil {
		return maintenanceResult{}, fmt.Errorf("atomically install Agent update: %w", err)
	}
	committed = true
	return result, nil
}

func scheduleAgentServiceAction(action string) error {
	if os.Getenv("RUNDEA_AGENT_TEST_DISABLE_SERVICE_ACTIONS") == "1" {
		return nil
	}
	if action != "restart" && action != "stop" {
		return fmt.Errorf("unsupported Agent service action %q", action)
	}
	unit := fmt.Sprintf("rundea-agent-self-%s-%d", action, time.Now().UnixNano())
	if path, err := exec.LookPath("systemd-run"); err == nil {
		cmd := exec.Command(path, "--unit="+unit, "--on-active=2s", "/bin/systemctl", action, "rundea-agent.service")
		if _, err := cmd.CombinedOutput(); err == nil {
			return nil
		}
	}
	cmd := exec.Command("/bin/sh", "-c", fmt.Sprintf("sleep 2; systemctl %s rundea-agent.service >/dev/null 2>&1", action))
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("schedule Agent service %s: %w", action, err)
	}
	return nil
}

func runAgentUpdate(cfg config, w *writer, cmd updateAgentCommand) {
	if err := validateMaintenanceActionID(cmd.ActionID); err != nil {
		maintenanceEvent(w, cmd.ActionID, "UPDATE_AGENT", false, maintenanceResult{}, err)
		return
	}
	executablePath, err := os.Executable()
	if err != nil {
		maintenanceEvent(w, cmd.ActionID, "UPDATE_AGENT", false, maintenanceResult{}, fmt.Errorf("resolve current Agent executable: %w", err))
		return
	}
	result, err := installAgentUpdate(cfg, executablePath)
	if err != nil {
		maintenanceEvent(w, cmd.ActionID, "UPDATE_AGENT", false, maintenanceResult{}, err)
		return
	}
	if err := scheduleAgentServiceAction("restart"); err != nil {
		maintenanceEvent(w, cmd.ActionID, "UPDATE_AGENT", false, result, err)
		return
	}
	maintenanceEvent(w, cmd.ActionID, "UPDATE_AGENT", true, result, nil)
}

type managedContainerIdentity struct {
	Name string
	Role string
	Kind string
	Backend bool
}

func removableManagedContainer(identity managedContainerIdentity) bool {
	if identity.Role == "ingress" {
		return false
	}
	return identity.Backend || identity.Role == "runtime-router" || identity.Kind == "managed-redis"
}

func managedCleanupContainers() ([]managedContainerIdentity, error) {
	out, err := exec.Command("docker", "ps", "-a", "--filter", "label=rundea.managed=true", "--format", "{{.Names}}").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("list Rundea containers: %w: %s", err, strings.TrimSpace(string(out)))
	}
	names := strings.Fields(string(out))
	result := make([]managedContainerIdentity, 0, len(names))
	for _, name := range names {
		inspect, err := exec.Command(
			"docker", "inspect", "--format",
			`{{ index .Config.Labels "rundea.role" }}|{{ index .Config.Labels "rundea.kind" }}|{{ index .Config.Labels "rundea.backend" }}`,
			name,
		).CombinedOutput()
		if err != nil {
			return nil, fmt.Errorf("inspect Rundea container %s: %w: %s", name, err, strings.TrimSpace(string(inspect)))
		}
		parts := strings.Split(strings.TrimSpace(string(inspect)), "|")
		if len(parts) != 3 {
			return nil, fmt.Errorf("inspect Rundea container %s returned unexpected labels", name)
		}
		result = append(result, managedContainerIdentity{
			Name: name, Role: parts[0], Kind: parts[1], Backend: parts[2] == "true",
		})
	}
	return result, nil
}

func cleanupManagedNode(cfg config) error {
	containers, err := managedCleanupContainers()
	if err != nil {
		return err
	}
	sort.Slice(containers, func(i, j int) bool { return containers[i].Name < containers[j].Name })
	for _, container := range containers {
		if !removableManagedContainer(container) {
			continue
		}
		out, err := exec.Command("docker", "rm", "-f", container.Name).CombinedOutput()
		if err != nil && !strings.Contains(string(out), "No such container") {
			return fmt.Errorf("remove Rundea container %s: %w: %s", container.Name, err, strings.TrimSpace(string(out)))
		}
	}

	networksOut, err := exec.Command("docker", "network", "ls", "--filter", "label=rundea.managed=true", "--format", "{{.Name}}").CombinedOutput()
	if err != nil {
		return fmt.Errorf("list Rundea networks: %w: %s", err, strings.TrimSpace(string(networksOut)))
	}
	for _, network := range strings.Fields(string(networksOut)) {
		inspect, err := exec.Command(
			"docker", "network", "inspect", "--format",
			`{{ index .Labels "rundea.kind" }}`,
			network,
		).CombinedOutput()
		if err != nil {
			return fmt.Errorf("inspect Rundea network %s: %w: %s", network, err, strings.TrimSpace(string(inspect)))
		}
		if strings.TrimSpace(string(inspect)) != "project-network" {
			continue
		}
		out, err := exec.Command("docker", "network", "rm", network).CombinedOutput()
		if err != nil && !strings.Contains(string(out), "No such network") {
			return fmt.Errorf("remove Rundea network %s: %w: %s", network, err, strings.TrimSpace(string(out)))
		}
	}

	for _, path := range []string{
		filepath.Join(cfg.WorkDir, "deployments"),
		filepath.Join(cfg.WorkDir, "runtime-router"),
		filepath.Join(cfg.WorkDir, "addons"),
		filepath.Join(cfg.WorkDir, "artifact-retention.json"),
	} {
		if err := os.RemoveAll(path); err != nil {
			return fmt.Errorf("remove Rundea runtime state %s: %w", path, err)
		}
	}
	return nil
}

func runNodeCleanup(cfg config, w *writer, cmd cleanupNodeCommand) {
	if err := validateMaintenanceActionID(cmd.ActionID); err != nil {
		maintenanceEvent(w, cmd.ActionID, "CLEANUP_NODE", false, maintenanceResult{}, err)
		return
	}
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	if err := cleanupManagedNode(cfg); err != nil {
		maintenanceEvent(w, cmd.ActionID, "CLEANUP_NODE", false, maintenanceResult{}, err)
		return
	}
	if err := scheduleAgentServiceAction("stop"); err != nil {
		maintenanceEvent(w, cmd.ActionID, "CLEANUP_NODE", false, maintenanceResult{}, err)
		return
	}
	maintenanceEvent(w, cmd.ActionID, "CLEANUP_NODE", true, maintenanceResult{}, nil)
}
