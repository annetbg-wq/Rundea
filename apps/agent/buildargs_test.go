package main

import (
	"reflect"
	"testing"
)

func TestDockerBuildCommandArgsSortsPassesValuesAndAppliesGuardrails(t *testing.T) {
	args, err := dockerBuildCommandArgs("apps/web/Dockerfile", "rundea/test:build", map[string]string{
		"ZETA":                "2",
		"NEXT_PUBLIC_API_URL": "https://api.example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"build",
		"--memory", "1024m",
		"--memory-swap", "1024m",
		"--cpu-period", "100000",
		"--cpu-quota", "100000",
		"--pull", "-f", "apps/web/Dockerfile", "-t", "rundea/test:build",
		"--build-arg", "NEXT_PUBLIC_API_URL=https://api.example.com",
		"--build-arg", "ZETA=2",
		".",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("unexpected docker args:\nwant %#v\n got %#v", want, args)
	}
}

func TestDockerBuildCommandArgsRejectsUnsafeValues(t *testing.T) {
	if _, err := dockerBuildCommandArgs("Dockerfile", "rundea/test:build", map[string]string{"BAD-NAME": "x"}); err == nil {
		t.Fatal("expected invalid name error")
	}
	if _, err := dockerBuildCommandArgs("Dockerfile", "rundea/test:build", map[string]string{"VALUE": "line1\nline2"}); err == nil {
		t.Fatal("expected newline value error")
	}
}
