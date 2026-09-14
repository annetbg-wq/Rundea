package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

const maxBuildArgs = 64
const maxBuildArgNameBytes = 128
const maxBuildArgValueBytes = 4096

var buildArgNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func validateBuildArgs(values map[string]string) error {
	if len(values) > maxBuildArgs {
		return fmt.Errorf("build args support at most %d entries", maxBuildArgs)
	}
	for key, value := range values {
		if !buildArgNamePattern.MatchString(key) || len(key) > maxBuildArgNameBytes {
			return fmt.Errorf("invalid build arg name %q", key)
		}
		if len(value) > maxBuildArgValueBytes || strings.ContainsAny(value, "\r\n\x00") {
			return fmt.Errorf("build arg %q contains an invalid or oversized value", key)
		}
	}
	return nil
}

func dockerBuildCommandArgs(dockerfile, imageTag string, values map[string]string) ([]string, error) {
	if err := validateBuildArgs(values); err != nil {
		return nil, err
	}

	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	args := []string{"build"}
	args = append(args, buildResourceArgs()...)
	args = append(args, "--pull", "-f", dockerfile, "-t", imageTag)
	for _, key := range keys {
		args = append(args, "--build-arg", key+"="+values[key])
	}
	args = append(args, ".")
	return args, nil
}
