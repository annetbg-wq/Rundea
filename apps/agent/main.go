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
		Mode       string `json:"mode"`
		Repository string `json:"repository"`
		Ref        string `json:"ref"`
		Ticket     string `json:"ticket"`
		Dockerfile string `json:"dockerfile"`
	} `json:"source"`
	Build struct {
		Args map[string]string `json:"args"`
	} `json:"build"`
	Runtime struct {
		ContainerName string            `json:"containerName"`
		ContainerPort int               `json:"containerPort"`
		HostPort      int               `json:"hostPort"`
		Environment   map[string]string `json:"environment"`
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

	identity := currentAgentIdentity()
	if err := w.send(map[string]any{
		"type":            "hello",
		"agentVersion":    identity.AgentVersion,
		"buildSha":        identity.BuildSHA,
		"capabilities":    identity.Capabilities,
		"publicAddresses": identity.PublicAddresses,
	}); err != nil {
		return fmt.Errorf("send Agent hello: %w", err)
	}

	if err := recoverRuntimeRouter(cfg, w); err != nil {
		return fmt.Errorf("recover runtime router: %w", err)
	}

	metricsCtx, cancelMetrics := context.WithCancel(context.Background())
	defer cancelMetrics()
	go runMetricsLoop(metricsCtx, w, durationEnv("RUNDEA_METRICS_INTERVAL", defaultMetricsInterval))

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
		var envelope struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			continue
		}
		switch envelope.Type {
		case "deploy":
			var cmd deployCommand
			if err := json.Unmarshal(payload, &cmd); err != nil {
				continue
			}
			go runDeployment(cfg, w, cmd)
		case "rollback":
			var cmd rollbackCommand
			if err := json.Unmarshal(payload, &cmd); err != nil {
				continue
			}
			go runRollback(cfg, w, cmd)
		case "restart":
			var cmd restartCommand
			if err := json.Unmarshal(payload, &cmd); err != nil {
				continue
			}
			go runRestart(cfg, w, cmd)
		case "qualify":
			var cmd qualifyCommand
			if err := json.Unmarshal(payload, &cmd); err != nil || cmd.QualificationID == "" || cmd.Profile == "" {
				continue
			}
			go runQualification(w, cmd)
		case "reconcileIngress":
			var cmd reconcileIngressCommand
			if err := json.Unmarshal(payload, &cmd); err != nil || cmd.ReconciliationID == "" {
				continue
			}
			go runIngressReconciliation(cfg, w, cmd)
		}
	}
}

func runDeployment(cfg config, w *writer, cmd deployCommand) {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()

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

	if err := w.status(cmd.DeploymentID, "BUILDING", "checking out source", ""); err != nil {
		return
	}
	var sourceSHA string
	if cmd.Source.Mode == "bundle" {
		if err := fetchBrokeredSource(ctx, cfg, cmd.DeploymentID, cmd.Source.Ticket, cmd.Source.Ref, sourceDir); err != nil {
			fail(fmt.Errorf("brokered source checkout: %w", err))
			return
		}
		sourceSHA = strings.ToLower(cmd.Source.Ref)
		w.log(cmd.DeploymentID, "system", "source delivered through Rundea broker")
	} else {
		if err := cloneSource(ctx, w, cmd.DeploymentID, cmd.Source.Repository, cmd.Source.Ref, sourceDir); err != nil {
			fail(fmt.Errorf("source checkout: %w", err))
			return
		}
		resolvedSHA, err := sourceCommitSHA(ctx, sourceDir)
		if err != nil {
			fail(err)
			return
		}
		sourceSHA = resolvedSHA
	}

	dockerfile, plan, err := prepareDockerfile(sourceDir, cmd.Source.Dockerfile)
	if err != nil {
		fail(err)
		return
	}
	healthcheckPath := resolveHealthcheckPath(sourceDir, cmd.Runtime.Healthcheck.Path)
	w.log(cmd.DeploymentID, "system", "selected build plan: "+plan)
	w.log(cmd.DeploymentID, "system", "healthcheck path: "+healthcheckPath)
	imageTag := "rundea/" + strings.ToLower(cmd.DeploymentID) + ":build"
	buildArgs, err := dockerBuildCommandArgs(dockerfile, imageTag, cmd.Build.Args)
	if err != nil {
		fail(fmt.Errorf("docker build arguments: %w", err))
		return
	}
	if err := runGuardedDockerBuild(ctx, sourceDir, w, cmd.DeploymentID, buildArgs); err != nil {
		fail(fmt.Errorf("docker build: %w", err))
		return
	}
	imageID, err := inspectImageID(ctx, imageTag)
	if err != nil {
		fail(err)
		return
	}
	if err := w.send(map[string]any{
		"type": "artifact",
		"deploymentId": cmd.DeploymentID,
		"sourceCommitSha": sourceSHA,
		"imageId": imageID,
		"healthcheckPath": healthcheckPath,
	}); err != nil {
		return
	}

	if err := w.status(cmd.DeploymentID, "DEPLOYING", "starting isolated runtime backend", ""); err != nil {
		return
	}
	envFile, err := writeRuntimeEnvFile(workspace, cmd.Runtime.Environment, cmd.Runtime.ContainerPort)
	if err != nil {
		fail(fmt.Errorf("runtime environment: %w", err))
		return
	}
	timeout := time.Duration(cmd.Runtime.Healthcheck.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	containerID, runtimeErr := runSafeRuntime(ctx, cfg, w, safeRuntimeSpec{
		WorkDir:       cfg.WorkDir,
		DeploymentID:  cmd.DeploymentID,
		ServiceName:   cmd.ServiceName,
		ContainerName: cmd.Runtime.ContainerName,
		ImageTag:      imageTag,
		EnvFile:       envFile,
		ContainerPort: cmd.Runtime.ContainerPort,
		HostPort:      cmd.Runtime.HostPort,
		HealthPath:    healthcheckPath,
		HealthTimeout: timeout,
	})
	if removeErr := os.Remove(envFile); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		w.log(cmd.DeploymentID, "system", "failed to remove temporary runtime env file: "+removeErr.Error())
	}
	if runtimeErr != nil {
		fail(runtimeErr)
		return
	}

	if err := w.status(cmd.DeploymentID, "READY", "runtime backend is healthy and stable route switched without port rebinding", containerID); err != nil {
		return
	}
	go streamRuntimeLogs(context.Background(), w, cmd.DeploymentID, revisionContainerName(cmd.Runtime.ContainerName, cmd.DeploymentID))
}

func cleanupContainer(ctx context.Context, w *writer, deploymentID, containerName string) {
	out, err := exec.CommandContext(ctx, "docker", "rm", "-f", containerName).CombinedOutput()
	if err != nil && !strings.Contains(string(out), "No such container") {
		w.log(deploymentID, "system", fmt.Sprintf("failed to remove incomplete container: %v: %s", err, strings.TrimSpace(string(out))))
	}
}

func validateCommand(cmd deployCommand) error {
	if cmd.DeploymentID == "" || cmd.Source.Ref == "" {
		return errors.New("deployment command is missing source fields")
	}
	if cmd.Source.Mode == "bundle" {
		if cmd.Source.Ticket == "" || !isFullGitCommit(cmd.Source.Ref) {
			return errors.New("brokered source requires a ticket and exact commit SHA")
		}
		if cmd.Source.Repository != "" {
			return errors.New("brokered source must not expose repository credentials or clone URLs to the Agent")
		}
	} else {
		if cmd.Source.Mode != "" && cmd.Source.Mode != "git" {
			return errors.New("deployment command contains an unknown source mode")
		}
		if cmd.Source.Repository == "" {
			return errors.New("direct git source is missing repository")
		}
		repoURL, err := url.Parse(cmd.Source.Repository)
		if err != nil || repoURL.Scheme != "https" || !strings.EqualFold(repoURL.Hostname(), "github.com") || repoURL.User != nil {
			return errors.New("source repository must be an HTTPS github.com URL without embedded credentials")
		}
		if !isFullGitCommit(cmd.Source.Ref) {
			if err := validateNamedGitRef(cmd.Source.Ref); err != nil {
				return err
			}
		}
	}
	if cmd.Source.Dockerfile != "" {
		cleanDockerfile := filepath.Clean(cmd.Source.Dockerfile)
		if filepath.IsAbs(cleanDockerfile) || cleanDockerfile == ".." || strings.HasPrefix(cleanDockerfile, ".."+string(filepath.Separator)) {
			return errors.New("dockerfile path must stay inside the source repository")
		}
	}
	if err := validateBuildArgs(cmd.Build.Args); err != nil {
		return err
	}
	if cmd.Runtime.ContainerName == "" || cmd.Runtime.ContainerPort < 1 || cmd.Runtime.ContainerPort > 65535 || cmd.Runtime.HostPort < 1 || cmd.Runtime.HostPort > 65535 {
		return errors.New("deployment command contains invalid runtime fields")
	}
	if cmd.Runtime.HostPort == 80 || cmd.Runtime.HostPort == 443 || cmd.Runtime.HostPort == 2019 || cmd.Runtime.HostPort == 2020 {
		return fmt.Errorf("host port %d is reserved by Rundea routing", cmd.Runtime.HostPort)
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
