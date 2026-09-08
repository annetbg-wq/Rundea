package main

import "testing"

func TestIsFullGitCommit(t *testing.T) {
	valid := []string{
		"039c34770852fb07cef7f9f0f8534c5de408b207",
		"039C34770852FB07CEF7F9F0F8534C5DE408B207",
	}
	for _, ref := range valid {
		if !isFullGitCommit(ref) {
			t.Fatalf("expected %q to be recognized as a full commit", ref)
		}
	}

	invalid := []string{"main", "039c347", "g39c34770852fb07cef7f9f0f8534c5de408b207", "039c34770852fb07cef7f9f0f8534c5de408b2070"}
	for _, ref := range invalid {
		if isFullGitCommit(ref) {
			t.Fatalf("did not expect %q to be recognized as a full commit", ref)
		}
	}
}

func TestValidateNamedGitRef(t *testing.T) {
	valid := []string{"main", "release/v1.2.3", "feature/foo_bar", "v1.0.0+build"}
	for _, ref := range valid {
		if err := validateNamedGitRef(ref); err != nil {
			t.Fatalf("expected named ref %q to be valid: %v", ref, err)
		}
	}

	invalid := []string{"", "--upload-pack=evil", "bad\nref", "bad\rref", string([]byte{'b', 'a', 'd', 0, 'r', 'e', 'f'})}
	for _, ref := range invalid {
		if err := validateNamedGitRef(ref); err == nil {
			t.Fatalf("expected named ref %q to be invalid", ref)
		}
	}
}
