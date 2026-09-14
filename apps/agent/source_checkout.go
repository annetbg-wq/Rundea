package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var fullGitCommitPattern = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func isFullGitCommit(ref string) bool {
	return fullGitCommitPattern.MatchString(ref)
}

func validateNamedGitRef(ref string) error {
	if ref == "" || len(ref) > 255 {
		return errors.New("source ref must be between 1 and 255 characters")
	}
	if strings.HasPrefix(ref, "-") || strings.ContainsAny(ref, "\x00\r\n") {
		return errors.New("source ref contains unsafe characters")
	}
	return nil
}

func cloneSource(ctx context.Context, w *writer, deploymentID, repository, ref, destination string) error {
	if err := requireDiskHeadroom(filepath.Dir(destination)); err != nil {
		return fmt.Errorf("source checkout admission: %w", err)
	}
	if isFullGitCommit(ref) {
		expected := strings.ToLower(ref)
		steps := []struct {
			name string
			args []string
		}{
			{name: "git", args: []string{"init", "--quiet", destination}},
			{name: "git", args: []string{"-C", destination, "remote", "add", "origin", repository}},
			{name: "git", args: []string{"-C", destination, "fetch", "--depth", "1", "origin", expected}},
			{name: "git", args: []string{"-C", destination, "checkout", "--quiet", "--detach", "FETCH_HEAD"}},
		}
		for _, step := range steps {
			if err := runStreaming(ctx, w, deploymentID, "build", step.name, step.args...); err != nil {
				return err
			}
		}
		actual, err := sourceCommitSHA(ctx, destination)
		if err != nil {
			return err
		}
		if actual != expected {
			return fmt.Errorf("source commit identity mismatch: expected %s, checked out %s", expected, actual)
		}
		return nil
	}

	if err := validateNamedGitRef(ref); err != nil {
		return err
	}
	return runStreaming(
		ctx,
		w,
		deploymentID,
		"build",
		"git",
		"clone",
		"--depth",
		"1",
		"--branch",
		ref,
		"--single-branch",
		repository,
		destination,
	)
}
