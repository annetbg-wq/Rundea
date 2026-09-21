package main

import "testing"

func TestValidateImmutableImageRef(t *testing.T) {
	digest := "sha256:" + repeatHex("a", 64)
	for _, ref := range []string{
		"ghcr.io/acme/momna@" + digest,
		"localhost:5000/momna@" + digest,
	} {
		if err := validateImmutableImageRef(ref); err != nil {
			t.Fatalf("expected %q to be valid: %v", ref, err)
		}
	}
	for _, ref := range []string{
		"",
		"ghcr.io/acme/momna:latest",
		"momna@" + digest,
		"ghcr.io/acme/momna@sha256:" + repeatHex("A", 64),
		"ghcr.io/acme/momna@" + digest + " extra",
	} {
		if err := validateImmutableImageRef(ref); err == nil {
			t.Fatalf("expected %q to be rejected", ref)
		}
	}
}

func repeatHex(value string, count int) string {
	result := ""
	for i := 0; i < count; i++ {
		result += value
	}
	return result
}
