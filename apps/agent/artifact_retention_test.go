package main

import (
	"reflect"
	"testing"
)

func TestNextRetainedArtifactsKeepsCurrentAndThreeRollbackRevisions(t *testing.T) {
	existing := []string{"d3", "d2", "d1", "d0"}
	retained, evicted := nextRetainedArtifacts(existing, "d4", "d3")
	if want := []string{"d4", "d3", "d2", "d1"}; !reflect.DeepEqual(retained, want) {
		t.Fatalf("retained=%#v want=%#v", retained, want)
	}
	if want := []string{"d0"}; !reflect.DeepEqual(evicted, want) {
		t.Fatalf("evicted=%#v want=%#v", evicted, want)
	}
}

func TestNextRetainedArtifactsDeduplicatesCurrentAndPrevious(t *testing.T) {
	existing := []string{"D3", "d2", "d1"}
	retained, evicted := nextRetainedArtifacts(existing, "d4", "d3")
	if want := []string{"d4", "d3", "d2", "d1"}; !reflect.DeepEqual(retained, want) {
		t.Fatalf("retained=%#v want=%#v", retained, want)
	}
	if len(evicted) != 0 {
		t.Fatalf("unexpected eviction %#v", evicted)
	}
}

func TestNextRetainedArtifactsNeverEvictsPreviousRoute(t *testing.T) {
	existing := []string{"d4", "d3", "d2", "d1"}
	retained, evicted := nextRetainedArtifacts(existing, "d5", "d1")
	if want := []string{"d5", "d1", "d4", "d3"}; !reflect.DeepEqual(retained, want) {
		t.Fatalf("retained=%#v want=%#v", retained, want)
	}
	if want := []string{"d2"}; !reflect.DeepEqual(evicted, want) {
		t.Fatalf("evicted=%#v want=%#v", evicted, want)
	}
}
