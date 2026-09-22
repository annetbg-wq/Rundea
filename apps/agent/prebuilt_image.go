package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

func validateImmutableImageRef(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 1024 || strings.ContainsAny(value, " \t\r\n") {
		return errors.New("prebuilt image reference is invalid")
	}
	marker := strings.LastIndex(value, "@")
	if marker <= 0 || marker == len(value)-1 {
		return errors.New("prebuilt image reference must be pinned by immutable @sha256 digest")
	}
	name := value[:marker]
	digest := value[marker+1:]
	if !strings.Contains(name, "/") || strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") || !dockerImageIDPattern.MatchString(digest) {
		return errors.New("prebuilt image reference must be a registry image pinned by immutable @sha256 digest")
	}
	return nil
}

func pullAndRetainPrebuiltImage(ctx context.Context, w *writer, deploymentID, imageRef, localTag string) (string, error) {
	if err := validateImmutableImageRef(imageRef); err != nil {
		return "", err
	}
	if err := runStreaming(ctx, w, deploymentID, "build", "docker", "pull", imageRef); err != nil {
		return "", fmt.Errorf("docker pull immutable artifact: %w", err)
	}
	pulledID, err := inspectImageID(ctx, imageRef)
	if err != nil {
		return "", err
	}
	out, err := exec.CommandContext(ctx, "docker", "image", "tag", imageRef, localTag).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("retain prebuilt artifact under deployment tag: %w: %s", err, strings.TrimSpace(string(out)))
	}
	retainedID, err := inspectImageID(ctx, localTag)
	if err != nil {
		return "", err
	}
	if retainedID != pulledID {
		return "", fmt.Errorf("retained prebuilt artifact identity mismatch: pulled %s, retained %s", pulledID, retainedID)
	}
	return retainedID, nil
}
