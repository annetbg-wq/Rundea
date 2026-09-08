package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const caddyImage = "caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d"
const caddyContainer = "rundea-caddy"

type ingressRoute struct {
	Hostname string `json:"hostname"`
	HostPort int    `json:"hostPort"`
}

type reconcileIngressCommand struct {
	Type             string         `json:"type"`
	ReconciliationID string         `json:"reconciliationId"`
	Routes           []ingressRoute `json:"routes"`
}

type ingressRouteResult struct {
	Hostname string `json:"hostname"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

func runIngressReconciliation(cfg config, w *writer, cmd reconcileIngressCommand) {
	results := make([]ingressRouteResult, 0, len(cmd.Routes))
	complete := func(ok bool) {
		_ = w.send(map[string]any{
			"type": "ingress", "reconciliationId": cmd.ReconciliationID, "ok": ok,
			"routes": results, "completedAt": time.Now().UTC().Format(time.RFC3339Nano),
		})
	}
	if cmd.ReconciliationID == "" {
		complete(false)
		return
	}
	if err := validateIngressRoutes(cmd.Routes); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false)
		return
	}
	if len(cmd.Routes) == 0 {
		_ = exec.Command("docker", "rm", "-f", caddyContainer).Run()
		complete(true)
		return
	}

	caddyDir := filepath.Join(cfg.WorkDir, "caddy")
	dataDir := filepath.Join(cfg.WorkDir, "caddy-data")
	configDir := filepath.Join(cfg.WorkDir, "caddy-config")
	for _, dir := range []string{caddyDir, dataDir, configDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			for _, route := range cmd.Routes {
				results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
			}
			complete(false)
			return
		}
	}

	config := renderCaddyfile(cmd.Routes)
	if err := writeAtomic(filepath.Join(caddyDir, "Caddyfile"), []byte(config), 0o600); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false)
		return
	}
	if err := validateCaddyConfig(caddyDir); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false)
		return
	}
	if err := ensureCaddy(caddyDir, dataDir, configDir); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false)
		return
	}

	allOK := true
	for _, route := range cmd.Routes {
		err := verifyHTTPSRoute(route.Hostname, 75*time.Second)
		result := ingressRouteResult{Hostname: route.Hostname, OK: err == nil}
		if err != nil {
			result.Error = sanitizeProbeError(err.Error())
			allOK = false
		}
		results = append(results, result)
	}
	complete(allOK)
}

func validateIngressRoutes(routes []ingressRoute) error {
	if len(routes) > 100 {
		return errors.New("at most 100 ingress routes are supported per node in v0")
	}
	seen := make(map[string]struct{}, len(routes))
	for _, route := range routes {
		hostname := normalizeHostname(route.Hostname)
		if hostname != route.Hostname {
			return fmt.Errorf("hostname %q must already be normalized", route.Hostname)
		}
		if !validHostname(hostname) {
			return fmt.Errorf("invalid public hostname %q", route.Hostname)
		}
		if route.HostPort < 1 || route.HostPort > 65535 {
			return fmt.Errorf("invalid upstream port for %s", route.Hostname)
		}
		if _, exists := seen[hostname]; exists {
			return fmt.Errorf("duplicate ingress hostname %s", hostname)
		}
		seen[hostname] = struct{}{}
	}
	return nil
}

func normalizeHostname(value string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(value)), ".")
}

func validHostname(host string) bool {
	if len(host) < 4 || len(host) > 253 || !strings.Contains(host, ".") || strings.Contains(host, "*") {
		return false
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if len(label) < 1 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, r := range label {
			if !((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-') {
				return false
			}
		}
	}
	return true
}

func renderCaddyfile(routes []ingressRoute) string {
	sorted := append([]ingressRoute(nil), routes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Hostname < sorted[j].Hostname })
	var builder strings.Builder
	for _, route := range sorted {
		builder.WriteString(route.Hostname)
		builder.WriteString(" {\n\treverse_proxy 127.0.0.1:")
		builder.WriteString(strconv.Itoa(route.HostPort))
		builder.WriteString("\n}\n\n")
	}
	return builder.String()
}

func writeAtomic(path string, content []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".rundea-caddy-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func validateCaddyConfig(caddyDir string) error {
	mount := caddyDir + ":/etc/caddy:ro"
	out, err := exec.Command("docker", "run", "--rm", "-v", mount, caddyImage, "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile").CombinedOutput()
	if err != nil {
		return fmt.Errorf("Caddy config validation failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func ensureCaddy(caddyDir, dataDir, configDir string) error {
	inspect, err := exec.Command("docker", "inspect", "-f", "{{.Config.Image}}", caddyContainer).CombinedOutput()
	if err == nil && strings.TrimSpace(string(inspect)) == caddyImage {
		out, reloadErr := exec.Command("docker", "exec", caddyContainer, "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile").CombinedOutput()
		if reloadErr != nil {
			return fmt.Errorf("Caddy reload failed: %w: %s", reloadErr, strings.TrimSpace(string(out)))
		}
		return nil
	}
	_ = exec.Command("docker", "rm", "-f", caddyContainer).Run()
	args := []string{
		"run", "-d", "--name", caddyContainer, "--restart", "unless-stopped", "--network", "host",
		"--label", "rundea.managed=true", "--label", "rundea.role=ingress",
		"-v", caddyDir + ":/etc/caddy:ro", "-v", dataDir + ":/data", "-v", configDir + ":/config",
		caddyImage, "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	}
	out, runErr := exec.Command("docker", args...).CombinedOutput()
	if runErr != nil {
		return fmt.Errorf("Caddy start failed: %w: %s", runErr, strings.TrimSpace(string(out)))
	}
	return nil
}

func verifyHTTPSRoute(hostname string, deadline time.Duration) error {
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer transport.CloseIdleConnections()
	end := time.Now().Add(deadline)
	var lastErr error
	for time.Now().Before(end) {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://"+hostname+"/", nil)
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return nil
			}
			lastErr = fmt.Errorf("HTTPS returned %s", resp.Status)
		} else {
			lastErr = err
		}
		time.Sleep(3 * time.Second)
	}
	if lastErr == nil {
		lastErr = errors.New("HTTPS verification timed out")
	}
	return fmt.Errorf("HTTPS verification failed for %s: %w", hostname, lastErr)
}
