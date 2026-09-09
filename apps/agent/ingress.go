package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const caddyImage = "caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d"
const caddyContainer = "rundea-caddy"
const ingressMarkerHeader = "X-Rundea-Reconciliation"

var ingressMu sync.Mutex
var reconciliationIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

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
	ingressMu.Lock()
	defer ingressMu.Unlock()

	results := make([]ingressRouteResult, 0, len(cmd.Routes))
	complete := func(applied, ok bool, globalErr error) {
		event := map[string]any{
			"type": "ingress", "reconciliationId": cmd.ReconciliationID,
			"applied": applied, "ok": ok, "routes": results,
			"completedAt": time.Now().UTC().Format(time.RFC3339Nano),
		}
		if globalErr != nil {
			event["error"] = sanitizeProbeError(globalErr.Error())
		}
		_ = w.send(event)
	}
	if !reconciliationIDPattern.MatchString(strings.ToLower(cmd.ReconciliationID)) {
		complete(false, false, errors.New("invalid ingress reconciliation id"))
		return
	}
	if err := validateIngressRoutes(cmd.Routes); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false, false, err)
		return
	}
	if len(cmd.Routes) == 0 {
		out, err := exec.Command("docker", "rm", "-f", caddyContainer).CombinedOutput()
		if err != nil && !strings.Contains(string(out), "No such container") {
			complete(false, false, fmt.Errorf("remove empty ingress runtime: %w: %s", err, strings.TrimSpace(string(out))))
			return
		}
		complete(true, true, nil)
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
			complete(false, false, err)
			return
		}
	}

	config := renderCaddyfile(cmd.Routes, cmd.ReconciliationID)
	if err := writeAtomic(filepath.Join(caddyDir, "Caddyfile"), []byte(config), 0o600); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false, false, err)
		return
	}
	if err := validateCaddyConfig(caddyDir); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
		}
		complete(false, false, err)
		return
	}
	if err := ensureCaddy(caddyDir, dataDir, configDir); err != nil {
		for _, route := range cmd.Routes {
			results = append(results, ingressRouteResult{Hostname: route.Hostname, Error: sanitizeProbeError(err.Error())})
			}
			complete(false, false, err)
			return
		}

	results = verifyIngressRoutes(cmd.Routes, cmd.ReconciliationID)
	allOK := true
	for _, result := range results {
		if !result.OK {
			allOK = false
			break
		}
	}
	complete(true, allOK, nil)
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

func renderCaddyfile(routes []ingressRoute, reconciliationID string) string {
	sorted := append([]ingressRoute(nil), routes...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Hostname < sorted[j].Hostname })
	var builder strings.Builder
	for _, route := range sorted {
		builder.WriteString(route.Hostname)
		builder.WriteString(" {\n\treverse_proxy 127.0.0.1:")
		builder.WriteString(strconv.Itoa(route.HostPort))
		builder.WriteString(" {\n\t\theader_down ")
		builder.WriteString(ingressMarkerHeader)
		builder.WriteByte(' ')
		builder.WriteString(reconciliationID)
		builder.WriteString("\n\t}\n}\n\n")
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
	args := caddyDockerRunArgs(
		[]string{"--rm", "-v", mount},
		"validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	)
	out, err := exec.Command("docker", args...).CombinedOutput()
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
	args := caddyDockerRunArgs(
		[]string{
			"-d", "--name", caddyContainer, "--restart", "unless-stopped", "--network", "host",
			"--label", "rundea.managed=true", "--label", "rundea.role=ingress",
			"-v", caddyDir + ":/etc/caddy:ro", "-v", dataDir + ":/data", "-v", configDir + ":/config",
		},
		"run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
	)
	out, runErr := exec.Command("docker", args...).CombinedOutput()
	if runErr != nil {
		return fmt.Errorf("Caddy start failed: %w: %s", runErr, strings.TrimSpace(string(out)))
	}
	return nil
}

func verifyIngressRoutes(routes []ingressRoute, reconciliationID string) []ingressRouteResult {
	results := make([]ingressRouteResult, len(routes))
	semaphore := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, route := range routes {
		wg.Add(1)
		go func(index int, current ingressRoute) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			err := verifyHTTPSRoute(current.Hostname, reconciliationID, 75*time.Second)
			result := ingressRouteResult{Hostname: current.Hostname, OK: err == nil}
			if err != nil {
				result.Error = sanitizeProbeError(err.Error())
			}
			results[index] = result
		}(i, route)
	}
	wg.Wait()
	return results
}

func resolveSafePublicIPs(ctx context.Context, hostname string) ([]net.IP, error) {
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", hostname, err)
	}
	seen := map[string]struct{}{}
	ips := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		if !isSafePublicIP(address.IP) {
			continue
		}
		key := address.IP.String()
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		ips = append(ips, address.IP)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("%s does not resolve to a safe public address", hostname)
	}
	return ips, nil
}

func isSafePublicIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, cidr := range []string{"100.64.0.0/10", "198.18.0.0/15"} {
		_, network, err := net.ParseCIDR(cidr)
		if err == nil && network.Contains(ip) {
			return false
		}
	}
	return true
}

func verifyHTTPSRoute(hostname, reconciliationID string, deadline time.Duration) error {
	end := time.Now().Add(deadline)
	var lastErr error
	for time.Now().Before(end) {
		resolveCtx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		ips, resolveErr := resolveSafePublicIPs(resolveCtx, hostname)
		cancel()
		if resolveErr != nil {
			lastErr = resolveErr
			time.Sleep(3 * time.Second)
			continue
		}

		transport := &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: hostname},
		}
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			_, port, splitErr := net.SplitHostPort(address)
			if splitErr != nil {
				port = "443"
			}
			var dialErr error
			dialer := &net.Dialer{Timeout: 3 * time.Second}
			for _, ip := range ips {
				conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				dialErr = err
			}
			if dialErr == nil {
				dialErr = errors.New("no public address could be dialed")
			}
			return nil, dialErr
		}
		client := &http.Client{
			Timeout:   5 * time.Second,
			Transport: transport,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://"+hostname+"/", nil)
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			marker := resp.Header.Get(ingressMarkerHeader)
			if resp.StatusCode < 500 && marker == reconciliationID {
				transport.CloseIdleConnections()
				return nil
			}
			if marker != reconciliationID {
				lastErr = fmt.Errorf("DNS does not reach the current Rundea ingress reconciliation")
			} else {
				lastErr = fmt.Errorf("HTTPS returned %s", resp.Status)
			}
		} else {
			lastErr = err
		}
		transport.CloseIdleConnections()
		time.Sleep(3 * time.Second)
	}
	if lastErr == nil {
		lastErr = errors.New("HTTPS verification timed out")
	}
	return fmt.Errorf("HTTPS verification failed for %s: %w", hostname, lastErr)
}
