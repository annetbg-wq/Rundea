package main

import "testing"

func TestAdvanceRuntimeHealthTransitions(t *testing.T) {
	state, changed := advanceRuntimeHealth(runtimeHealthTracker{}, true)
	if state.State != "HEALTHY" || state.Failures != 0 || !changed {
		t.Fatalf("initial healthy state=%#v changed=%v", state, changed)
	}

	state, changed = advanceRuntimeHealth(state, false)
	if state.State != "DEGRADED" || state.Failures != 1 || !changed {
		t.Fatalf("first failure state=%#v changed=%v", state, changed)
	}

	state, changed = advanceRuntimeHealth(state, false)
	if state.State != "DEGRADED" || state.Failures != 2 || changed {
		t.Fatalf("second failure state=%#v changed=%v", state, changed)
	}

	state, changed = advanceRuntimeHealth(state, false)
	if state.State != "DOWN" || state.Failures != 3 || !changed {
		t.Fatalf("third failure state=%#v changed=%v", state, changed)
	}

	state, changed = advanceRuntimeHealth(state, true)
	if state.State != "HEALTHY" || state.Failures != 0 || !changed {
		t.Fatalf("recovery state=%#v changed=%v", state, changed)
	}
}

func TestAdvanceRuntimeHealthStaysDownAfterThreshold(t *testing.T) {
	state := runtimeHealthTracker{State: "DOWN", Failures: 3}
	next, changed := advanceRuntimeHealth(state, false)
	if next.State != "DOWN" || next.Failures != 4 || changed {
		t.Fatalf("continued outage state=%#v changed=%v", next, changed)
	}
}
