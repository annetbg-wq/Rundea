package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var runtimeMu sync.Mutex
var dockerImageIDPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type rollbackCommand struct {
	Type               string `json:"type"`
	DeploymentID       string `json:"deploymentId"`
	TargetDeploymentID string `json:"targetDeploymentId"`
	ExpectedImageID    string `json:"expectedImageId"`
	ServiceName        string `json:"serviceName"`
	Runtime            struct {
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

type restartCommand struct {
	Type         string `json:"type"`
	ActionID     string `json:"actionId"`
	DeploymentID string `json:"deploymentId"`
	ServiceName  string `json:"serviceName"`
	Runtime      struct {
		ContainerName string `json:"containerName"`
		HostPort      int    `json:"hostPort"`
		Healthcheck   struct {
			Path           string `json:"path"`
			TimeoutSeconds int    `json:"timeoutSeconds"`
		} `json:"healthcheck"`
	} `json:"runtime"`
}

func inspectImageID(ctx context.Context, image string) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", "image", "inspect", "--format", "{{.Id}}", image).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("inspect image %s: %w: %s", image, err, strings.TrimSpace(string(out)))
	}
	id := strings.TrimSpace(string(out))
	if !dockerImageIDPattern.MatchString(id) {
		return "", fmt.Errorf("image %s returned invalid identity", image)
	}
	return id, nil
}

func sourceCommitSHA(ctx context.Context, sourceDir string) (string, error) {
	out, err := exec.CommandContext(ctx, "git", "-C", sourceDir, "rev-parse", "HEAD").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("resolve source commit: %w: %s", err, strings.TrimSpace(string(out)))
	}
	sha := strings.ToLower(strings.TrimSpace(string(out)))
	if len(sha) != 40 {
		return "", errors.New("resolved source commit is not a full Git SHA")
	}
	for _, r := range sha {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return "", errors.New("resolved source commit is not hexadecimal")
		}
	}
	return sha, nil
}

func validateRollbackCommand(cmd rollbackCommand) error {
	if cmd.DeploymentID == "" || cmd.TargetDeploymentID == "" || cmd.ServiceName == "" {
		return errors.New("rollback command is missing identity fields")
	}
	if !dockerImageIDPattern.MatchString(cmd.ExpectedImageID) {
		return errors.New("rollback command contains invalid expected image identity")
	}
	if cmd.Runtime.ContainerName == "" || cmd.Runtime.ContainerPort < 1 || cmd.Runtime.ContainerPort > 65535 || cmd.Runtime.HostPort < 1 || cmd.Runtime.HostPort > 65535 {
		return errors.New("rollback command contains invalid runtime fields")
	}
	return nil
}

func runRollback(cfg config, w *writer, cmd rollbackCommand) {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()

	ctx := context.Background()
	fail := func(err error) {
		w.log(cmd.DeploymentID, "system", err.Error())
		_ = w.status(cmd.DeploymentID, "FAILED", err.Error(), "")
	}
	if err := validateRollbackCommand(cmd); err != nil {
		fail(err)
		return
	}
	if err := w.status(cmd.DeploymentID, "BUILDING", "validating retained rollback artifact", ""); err != nil {
		return
	}

	targetImageTag := "rundea/" + strings.ToLower(cmd.TargetDeploymentID) + ":build"
	actualImageID, err := inspectImageID(ctx, targetImageTag)
	if err != nil {
		fail(err)
		return
	}
	if actualImageID != cmd.ExpectedImageID {
		fail(fmt.Errorf("retained rollback artifact identity mismatch: expected %s, found %s", cmd.ExpectedImageID, actualImageID))
		return
	}
	rollbackImageTag := "rundea/" + strings.ToLower(cmd.DeploymentID) + ":build"
	if out, err := exec.CommandContext(ctx, "docker", "image", "tag", targetImageTag, rollbackImageTag).CombinedOutput(); err != nil {
		fail(fmt.Errorf("retain rollback artifact under new revision: %w: %s", err, strings.TrimSpace(string(out))))
		return
	}
	if retainedID, err := inspectImageID(ctx, rollbackImageTag); err != nil || retainedID != cmd.ExpectedImageID {
		if err != nil {
			fail(err)
		} else {
			fail(fmt.Errorf("new rollback artifact identity mismatch: expected %s, found %s", cmd.ExpectedImageID, retainedID))
		}
		return
	}
	if err := w.status(cmd.DeploymentID, "DEPLOYING", "starting retained rollback revision", ""); err != nil {
		return
	}

	workspace := filepath.Join(cfg.WorkDir, "deployments", cmd.DeploymentID)
	_ = os.RemoveAll(workspace)
	if err := os.MkdirAll(workspace, 0o700); err != nil {
		fail(err)
		return
	}
	envFile, err := writeRuntimeEnvFile(workspace, cmd.Runtime.Environment, cmd.Runtime.ContainerPort)
	if err != nil {
		fail(fmt.Errorf("rollback runtime environment: %w", err))
		return
	}
	defer os.Remove(envFile)

	backupName := cmd.Runtime.ContainerName + "-rollback-backup"
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", backupName).Run()
	backupExists := false
	if inspectErr := exec.CommandContext(ctx, "docker", "inspect", cmd.Runtime.ContainerName).Run(); inspectErr == nil {
		if out, renameErr := exec.CommandContext(ctx, "docker", "rename", cmd.Runtime.ContainerName, backupName).CombinedOutput(); renameErr != nil {
			fail(fmt.Errorf("preserve current revision before rollback: %w: %s", renameErr, strings.TrimSpace(string(out))))
			return
		}
		backupExists = true
		if out, stopErr := exec.CommandContext(ctx, "docker", "stop", backupName).CombinedOutput(); stopErr != nil {
			_ = exec.CommandContext(ctx, "docker", "rename", backupName, cmd.Runtime.ContainerName).Run()
			fail(fmt.Errorf("stop current revision before rollback: %w: %s", stopErr, strings.TrimSpace(string(out))))
			return
		}
	}

	restoreBackup := func() error {
		_ = exec.CommandContext(ctx, "docker", "rm", "-f", cmd.Runtime.ContainerName).Run()
		if !backupExists {
			return nil
		}
		if out, renameErr := exec.CommandContext(ctx, "docker", "rename", backupName, cmd.Runtime.ContainerName).CombinedOutput(); renameErr != nil {
			return fmt.Errorf("restore previous container name: %w: %s", renameErr, strings.TrimSpace(string(out)))
		}
		if out, startErr := exec.CommandContext(ctx, "docker", "start", cmd.Runtime.ContainerName).CombinedOutput(); startErr != nil {
			return fmt.Errorf("restart previous container: %w: %s", startErr, strings.TrimSpace(string(out)))
		}
		backupExists = false
		return nil
	}

	port := fmt.Sprintf("127.0.0.1:%d:%d", cmd.Runtime.HostPort, cmd.Runtime.ContainerPort)
	out, runErr := exec.CommandContext(
		ctx, "docker", "run", "-d", "--restart", "unless-stopped",
		"--label", "rundea.managed=true",
		"--label", "rundea.deployment="+cmd.DeploymentID,
		"--label", "rundea.rollback_target="+cmd.TargetDeploymentID,
		"--name", cmd.Runtime.ContainerName, "-p", port, "--env-file", envFile, rollbackImageTag,
	).CombinedOutput()
	if removeErr := os.Remove(envFile); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		w.log(cmd.DeploymentID, "system", "failed to remove temporary rollback environment file: "+removeErr.Error())
	}
	if runErr != nil {
		restoreErr := restoreBackup()
		if restoreErr != nil {
			fail(fmt.Errorf("rollback start failed: %w: %s; previous revision restore also failed: %v", runErr, strings.TrimSpace(string(out)), restoreErr))
		} else {
			fail(fmt.Errorf("rollback start failed: %w: %s; previous revision restored", runErr, strings.TrimSpace(string(out))))
		}
		return
	}
	containerID := strings.TrimSpace(string(out))
	if err := w.status(cmd.DeploymentID, "HEALTHCHECK", "validating rollback revision", containerID); err != nil {
		_ = restoreBackup()
		return
	}
	timeout := time.Duration(cmd.Runtime.Healthcheck.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if err := waitForHealth(ctx, cmd.Runtime.HostPort, cmd.Runtime.Healthcheck.Path, timeout); err != nil {
		restoreErr := restoreBackup()
		if restoreErr != nil {
			fail(fmt.Errorf("rollback healthcheck failed: %w; previous revision restore also failed: %v", err, restoreErr))
		} else {
			fail(fmt.Errorf("rollback healthcheck failed: %w; previous revision restored", err))
		}
		return
	}
	if err := w.status(cmd.DeploymentID, "READY", "rollback revision is healthy", containerID); err != nil {
		_ = restoreBackup()
		return
	}
	if backupExists {
		if out, removeErr := exec.CommandContext(ctx, "docker", "rm", "-f", backupName).CombinedOutput(); removeErr != nil {
			w.log(cmd.DeploymentID, "system", fmt.Sprintf("rollback succeeded but backup cleanup failed: %v: %s", removeErr, strings.TrimSpace(string(out))))
		}
	}
	go streamRuntimeLogs(context.Background(), w, cmd.DeploymentID, cmd.Runtime.ContainerName)
}

func runRestart(w *writer, cmd restartCommand) {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()

	complete := func(ok bool, err error) {
		event := map[string]any{
			"type": "runtimeAction",
			"actionId": cmd.ActionID,
			"deploymentId": cmd.DeploymentID,
			"kind": "RESTART",
			"ok": ok,
			"completedAt": time.Now().UTC().Format(time.RFC3339Nano),
		}
		if err != nil {
			event["error"] = sanitizeProbeError(err.Error())
		}
		_ = w.send(event)
	}
	if cmd.ActionID == "" || cmd.DeploymentID == "" || cmd.Runtime.ContainerName == "" || cmd.Runtime.HostPort < 1 || cmd.Runtime.HostPort > 65535 {
		complete(false, errors.New("restart command contains invalid fields"))
		return
	}
	ctx := context.Background()
	out, err := exec.CommandContext(ctx, "docker", "inspect", "--format", `{{ index .Config.Labels "rundea.deployment" }}`, cmd.Runtime.ContainerName).CombinedOutput()
	if err != nil {
		complete(false, fmt.Errorf("restart target is not running as a managed container: %w: %s", err, strings.TrimSpace(string(out))))
		return
	}
	if strings.TrimSpace(string(out)) != cmd.DeploymentID {
		complete(false, errors.New("restart target container does not belong to the requested deployment"))
		return
	}
	if out, err := exec.CommandContext(ctx, "docker", "restart", cmd.Runtime.ContainerName).CombinedOutput(); err != nil {
		complete(false, fmt.Errorf("docker restart failed: %w: %s", err, strings.TrimSpace(string(out))))
		return
	}
	timeout := time.Duration(cmd.Runtime.Healthcheck.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	if err := waitForHealth(ctx, cmd.Runtime.HostPort, cmd.Runtime.Healthcheck.Path, timeout); err != nil {
		complete(false, fmt.Errorf("restart healthcheck failed: %w", err))
		return
	}
	complete(true, nil)
}
