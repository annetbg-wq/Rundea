package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type config struct {
	ControlPlane string
	NodeID       string
	Token        string
	WorkDir      string
}

type deployCommand struct {
	Type         string `json:"type"`
	DeploymentID string `json:"deploymentId"`
	ServiceName  string `json:"serviceName"`
	Source       struct {
		Repository string `json:"repository"`
		Ref        string `json:"ref"`
		Dockerfile string `json:"dockerfile"`
	} `json:"source"`
	Runtime struct {
		ContainerName string `json:"containerName"`
		ContainerPort int    `json:"containerPort"`
		HostPort      int    `json:"hostPort"`
		Healthcheck   struct {
			Path           string `json:"path"`
			TimeoutSeconds int    `json:"timeoutSeconds"`
		} `json:"healthcheck"`
	} `json:"runtime"`
}

type writer struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *writer) send(v any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.WriteJSON(v)
}

func (w *writer) status(id, status, message, containerID string) error {
	event := map[string]any{"type": "status", "deploymentId": id, "status": status}
	if message != "" {
		event["message"] = message
	}
	if containerID != "" {
		event["containerId"] = containerID
	}
	return w.send(event)
}

func (w *writer) log(id, stream, message string) {
	if strings.TrimSpace(message) == "" {
		return
	}
	_ = w.send(map[string]any{
		"type": "log", "deploymentId": id, "stream": stream,
		"message": strings.TrimSpace(message), "at": time.Now().UTC().Format(time.RFC3339Nano),
	})
}

type logSink struct {
	w                    *writer
	deploymentID, stream string
}

func (s logSink) Write(p []byte) (int, error) {
	s.w.log(s.deploymentID, s.stream, string(p))
	return len(p), nil
}

func main() {
	cfg := config{}
	flag.StringVar(&cfg.ControlPlane, "control-plane", env("RUNDEA_CONTROL_PLANE_URL", ""), "control plane URL")
	flag.StringVar(&cfg.NodeID, "node-id", env("RUNDEA_NODE_ID", ""), "node ID")
	flag.StringVar(&cfg.Token, "token", env("RUNDEA_NODE_TOKEN", ""), "node token")
	flag.StringVar(&cfg.WorkDir, "work-dir", env("RUNDEA_WORK_DIR", "/var/lib/rundea"), "agent working directory")
	flag.Parse()
	if cfg.ControlPlane == "" || cfg.NodeID == "" || cfg.Token == "" {
		log.Fatal("control-plane, node-id and token are required")
	}
	if err := os.MkdirAll(cfg.WorkDir, 0o700); err != nil {
		log.Fatal(err)
	}

	backoff := time.Second
	for {
		if err := connectAndServe(cfg); err != nil {
			log.Printf("agent connection ended: %v", err)
		}
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func wsURL(base string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "http":
		u.Scheme = "ws"
	case "https":
		u.Scheme = "wss"
	default:
		return "", fmt.Errorf("unsupported control plane scheme %q", u.Scheme)
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v0/agent/ws"
	return u.String(), nil
}

func connectAndServe(cfg config) error {
	endpoint, err := wsURL(cfg.ControlPlane)
	if err != nil {
		return err
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+cfg.Token)
	headers.Set("X-Rundea-Node-Id", cfg.NodeID)
	conn, resp, err := websocket.DefaultDialer.Dial(endpoint, headers)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("dial failed: %s: %w", resp.Status, err)
		}
		return err
	}
	defer conn.Close()
	w := &writer{conn: conn}
	log.Printf("connected to %s as node %s", cfg.ControlPlane, cfg.NodeID)

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = w.send(map[string]any{"type": "heartbeat", "at": time.Now().UTC().Format(time.RFC3339Nano)})
			case <-done:
				return
			}
		}
	}()
	defer close(done)

	for {
		_, payload, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var cmd deployCommand
		if err := json.Unmarshal(payload, &cmd); err != nil {
			continue
		}
		if cmd.Type != "deploy" {
			continue
		}
		go runDeployment(cfg, w, cmd)
	}
}

func runDeployment(cfg config, w *writer, cmd deployCommand) {
	ctx := context.Background()
	fail := func(err error) {
		w.log(cmd.DeploymentID, "system", err.Error())
		_ = w.status(cmd.DeploymentID, "FAILED", err.Error(), "")
	}
	if err := validateCommand(cmd); err != nil {
		fail(err)
		return
	}

	workspace := filepath.Join(cfg.WorkDir, "deployments", cmd.DeploymentID)
	sourceDir := filepath.Join(workspace, "src")
	_ = os.RemoveAll(workspace)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		fail(err)
		return
	}

	if err := w.status(cmd.DeploymentID, "BUILDING", "cloning source", ""); err != nil {
		return
	}
	if err := runStreaming(ctx, w, cmd.DeploymentID, "build", "git", "clone", "--depth", "1", "--branch", cmd.Source.Ref, "--single-branch", cmd.Source.Repository, sourceDir); err != nil {
		fail(fmt.Errorf("git clone: %w", err))
		return
	}

	imageTag := "rundea/" + strings.ToLower(cmd.DeploymentID) + ":build"
	if err := runStreamingIn(ctx, sourceDir, w, cmd.DeploymentID, "build", "docker", "build", "--pull", "-f", cmd.Source.Dockerfile, "-t", imageTag, "."); err != nil {
		fail(fmt.Errorf("docker build: %w", err))
		return
	}

	if err := w.status(cmd.DeploymentID, "DEPLOYING", "starting container", ""); err != nil {
		return
	}
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", cmd.Runtime.ContainerName).Run()
	port := fmt.Sprintf("127.0.0.1:%d:%d", cmd.Runtime.HostPort, cmd.Runtime.ContainerPort)
	out, err := exec.CommandContext(ctx, "docker", "run", "-d", "--restart", "unless-stopped", "--label", "rundea.managed=true", "--label", "rundea.deployment="+cmd.DeploymentID, "--name", cmd.Runtime.ContainerName, "-p", port, imageTag).CombinedOutput()
	if err != nil {
		fail(fmt.Errorf("docker run: %w: %s", err, strings.TrimSpace(string(out))))
		return
	}
	containerID := strings.TrimSpace(string(out))

	if err := w.status(cmd.DeploymentID, "HEALTHCHECK", "waiting for healthcheck", containerID); err != nil {
		cleanupContainer(ctx, w, cmd.DeploymentID, cmd.Runtime.ContainerName)
		return
	}
	timeout := time.Duration(cmd.Runtime.Healthcheck.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if err := waitForHealth(ctx, cmd.Runtime.HostPort, cmd.Runtime.Healthcheck.Path, timeout); err != nil {
		cleanupContainer(ctx, w, cmd.DeploymentID, cmd.Runtime.ContainerName)
		fail(err)
		return
	}

	if err := w.status(cmd.DeploymentID, "READY", "healthcheck passed", containerID); err != nil {
		cleanupContainer(ctx, w, cmd.DeploymentID, cmd.Runtime.ContainerName)
		return
	}
	go streamRuntimeLogs(ctx, w, cmd.DeploymentID, cmd.Runtime.ContainerName)
}

func cleanupContainer(ctx context.Context, w *writer, deploymentID, containerName string) {
	out, err := exec.CommandContext(ctx, "docker", "rm", "-f", containerName).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "No such container") {
		w.log(deploymentID, "system", fmt.Sprintf("failed to remove incomplete container: %v: %s", err, strings.TrimSpace(string(out))))
	}
}

func validateCommand(cmd deployCommand) error {
	if cmd.DeploymentID == "" || cmd.Source.Repository == "" || cmd.Source.Ref == "" || cmd.Source.Dockerfile == "" {
		return errors.New("deployment command is missing source fields")
	}
	repoURL, err := url.Parse(cmd.Source.Repository)
	if err != nil || repoURL.Scheme != "https" || !strings.EqualFold(repoURL.Hostname(), "github.com") || repoURL.User != nil {
		return errors.New("source repository must be an HTTPS github.com URL without embedded credentials")
	}
	cleanDockerfile := filepath.Clean(cmd.Source.Dockerfile)
	if filepath.IsAbs(cleanDockerfile) || cleanDockerfile == ".." || strings.HasPrefix(cleanDockerfile, ".."+string(filepath.Separator)) {
		return errors.New("dockerfile path must stay inside the source repository")
	}
	if cmd.Runtime.ContainerName == "" || cmd.Runtime.ContainerPort < 1 || cmd.Runtime.ContainerPort > 65535 || cmd.Runtime.HostPort < 1 || cmd.Runtime.HostPort > 65535 {
		return errors.New("deployment command contains invalid runtime fields")
	}
	return nil
}

func runStreaming(ctx context.Context, w *writer, deploymentID, stream, name string, args ...string) error {
	return runStreamingIn(ctx, "", w, deploymentID, stream, name, args...)
}

func runStreamingIn(ctx context.Context, dir string, w *writer, deploymentID, stream, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	sink := logSink{w: w, deploymentID: deploymentID, stream: stream}
	cmd.Stdout = sink
	cmd.Stderr = sink
	return cmd.Run()
}

func waitForHealth(ctx context.Context, hostPort int, path string, timeout time.Duration) error {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d%s", hostPort, path)
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 3 * time.Second}
	for time.Now().Before(deadline) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := client.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode >= 200 && resp.StatusCode < 400 {
				return nil
			}
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("healthcheck did not succeed within %s", timeout)
}

func streamRuntimeLogs(ctx context.Context, w *writer, deploymentID, containerName string) {
	_ = runStreaming(ctx, w, deploymentID, "runtime", "docker", "logs", "-f", "--since", "0s", containerName)
}
