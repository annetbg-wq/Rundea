package main

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func TestCurrentAgentIdentity(t *testing.T) {
	identity := currentAgentIdentity()
	if !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(identity.AgentVersion) { t.Fatalf("unexpected Agent version %q", identity.AgentVersion) }
	if strings.TrimSpace(identity.BuildSHA) == "" { t.Fatal("build SHA must never be empty") }
	for _, required := range []string{"artifactRetention", "buildArgs", "buildGuardrails", "continuousHealth", "managedIngress", "nodeCapacity", "resourceGuardrails", "runtimeMetrics"} {
		if !hasAgentCapability(required) { t.Fatalf("required capability %q is missing", required) }
	}
	for i := 1; i < len(identity.Capabilities); i++ { if identity.Capabilities[i-1] > identity.Capabilities[i] { t.Fatalf("capabilities are not sorted: %#v", identity.Capabilities) } }
}
func TestIdentityCLI(t *testing.T) {
	var out bytes.Buffer; handled, code := handleIdentityCLI([]string{"--identity"}, &out)
	if !handled || code != 0 { t.Fatalf("identity CLI handled=%v code=%d", handled, code) }
	var identity agentIdentity; if err := json.Unmarshal(out.Bytes(), &identity); err != nil { t.Fatal(err) }
	if identity.AgentVersion != currentAgentIdentity().AgentVersion || identity.BuildSHA != currentAgentIdentity().BuildSHA { t.Fatalf("identity output mismatch: %#v", identity) }
}
func TestRequireCapabilityCLI(t *testing.T) {
	for _, capability := range []string{"managedIngress", "resourceGuardrails", "buildGuardrails", "nodeCapacity", "continuousHealth", "artifactRetention"} {
		if handled, code := handleIdentityCLI([]string{"--require-capability="+capability}, &bytes.Buffer{}); !handled || code != 0 { t.Fatalf("capability %s handled=%v code=%d", capability, handled, code) }
	}
	if handled, code := handleIdentityCLI([]string{"--require-capability=not-real"}, &bytes.Buffer{}); !handled || code != 3 { t.Fatalf("unknown capability handled=%v code=%d", handled, code) }
	if handled, _ := handleIdentityCLI([]string{"--node-id", "x"}, &bytes.Buffer{}); handled { t.Fatal("normal Agent arguments must not be consumed by identity CLI") }
}
