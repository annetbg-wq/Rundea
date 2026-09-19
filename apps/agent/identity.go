package main

import (
	_ "embed"
	"encoding/json"
	"net"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

//go:embed VERSION
var embeddedAgentVersion string

// agentBuildSHA is replaced at build time for immutable release/live binaries.
// Development builds intentionally keep the explicit sentinel so operators can
// distinguish them from SHA-pinned release artifacts.
var agentBuildSHA = "development"

var declaredAgentCapabilities = []string{
	"artifactRetention",
	"buildArgs",
	"buildGuardrails",
	"continuousHealth",
	"managedIngress",
	"managedRedis",
	"nodeCapacity",
	"nodeDiskMetrics",
	"nodeMaintenance",
	"persistentVolumes",
	"privateNetworking",
	"resourceGuardrails",
	"runtimeMetrics",
	"runtimeRecovery",
	"safePromotion",
}

type agentIdentity struct {
	AgentVersion    string   `json:"agentVersion"`
	BuildSHA        string   `json:"buildSha"`
	Capabilities    []string `json:"capabilities"`
	PublicAddresses []string `json:"publicAddresses,omitempty"`
}

func currentAgentIdentity() agentIdentity {
	capabilities := append([]string(nil), declaredAgentCapabilities...)
	sort.Strings(capabilities)
	return agentIdentity{
		AgentVersion:    strings.TrimSpace(embeddedAgentVersion),
		BuildSHA:        strings.TrimSpace(agentBuildSHA),
		Capabilities:    capabilities,
		PublicAddresses: publicNodeAddresses(),
	}
}

func publicNodeAddresses() []string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]struct{}{}
	for _, iface := range interfaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch value := addr.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || isCarrierGradeNAT(ip) {
				continue
			}
			seen[ip.String()] = struct{}{}
		}
	}
	result := make([]string, 0, len(seen))
	for address := range seen {
		result = append(result, address)
	}
	sort.Strings(result)
	if len(result) > 8 {
		result = result[:8]
	}
	return result
}

func isCarrierGradeNAT(ip net.IP) bool {
	v4 := ip.To4()
	return v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127
}

func hasAgentCapability(name string) bool {
	for _, capability := range declaredAgentCapabilities {
		if capability == name {
			return true
		}
	}
	return false
}

func handleIdentityCLI(args []string, stdout io.Writer) (bool, int) {
	if len(args) != 1 {
		return false, 0
	}

	switch args[0] {
	case "--version":
		_, _ = fmt.Fprintln(stdout, currentAgentIdentity().AgentVersion)
		return true, 0
	case "--build-sha":
		_, _ = fmt.Fprintln(stdout, currentAgentIdentity().BuildSHA)
		return true, 0
	case "--capabilities":
		for _, capability := range currentAgentIdentity().Capabilities {
			_, _ = fmt.Fprintln(stdout, capability)
		}
		return true, 0
	case "--identity":
		if err := json.NewEncoder(stdout).Encode(currentAgentIdentity()); err != nil {
			return true, 1
		}
		return true, 0
	}

	const prefix = "--require-capability="
	if strings.HasPrefix(args[0], prefix) {
		name := strings.TrimSpace(strings.TrimPrefix(args[0], prefix))
		if name != "" && hasAgentCapability(name) {
			return true, 0
		}
		return true, 3
	}

	return false, 0
}

func init() {
	if handled, code := handleIdentityCLI(os.Args[1:], os.Stdout); handled {
		os.Exit(code)
	}
}
