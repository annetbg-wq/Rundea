package main

import (
	"net"
	"strconv"
	"strings"
	"testing"
)

func TestValidateIngressRoutesAcceptsNormalizedDomains(t *testing.T) {
	routes := []ingressRoute{{Hostname: "api.example.com", HostPort: 18080}, {Hostname: "sendina.example.com", HostPort: 18081}}
	if err := validateIngressRoutes(routes); err != nil {
		t.Fatalf("expected valid routes: %v", err)
	}
}

func TestValidateIngressRoutesRejectsUnsafeDomainsAndDuplicates(t *testing.T) {
	for _, routes := range [][]ingressRoute{
		{{Hostname: "localhost", HostPort: 18080}},
		{{Hostname: "*.example.com", HostPort: 18080}},
		{{Hostname: "Example.com", HostPort: 18080}},
		{{Hostname: "api.example.com", HostPort: 18080}, {Hostname: "api.example.com", HostPort: 18081}},
		{{Hostname: "api.example.com", HostPort: 70000}},
	} {
		if validateIngressRoutes(routes) == nil {
			t.Fatalf("expected routes to fail: %+v", routes)
		}
	}
}

func TestReservedIngressRoutesParseAndMerge(t *testing.T) {
	reserved, err := parseReservedIngressRoutes("rundea.example.com=4000")
	if err != nil {
		t.Fatalf("parse reserved route: %v", err)
	}
	merged, err := mergeIngressRoutes(reserved, []ingressRoute{{Hostname: "app.example.com", HostPort: 18080}})
	if err != nil {
		t.Fatalf("merge ingress routes: %v", err)
	}
	if len(merged) != 2 || merged[0].Hostname != "rundea.example.com" || merged[1].Hostname != "app.example.com" {
		t.Fatalf("unexpected merged routes: %+v", merged)
	}
}

func TestReservedIngressRoutesRejectCollision(t *testing.T) {
	reserved, err := parseReservedIngressRoutes("rundea.example.com=4000")
	if err != nil {
		t.Fatal(err)
	}
	_, err = mergeIngressRoutes(reserved, []ingressRoute{{Hostname: "rundea.example.com", HostPort: 18080}})
	if err == nil || !strings.Contains(err.Error(), "reserved for node system ingress") {
		t.Fatalf("expected reserved-host collision, got %v", err)
	}
}

func TestReservedIngressRoutesRejectMalformedInput(t *testing.T) {
	for _, raw := range []string{
		"Rundea.example.com=4000",
		"rundea.example.com",
		"rundea.example.com=0",
		"rundea.example.com=70000",
		"rundea.example.com=4000,rundea.example.com=4001",
	} {
		if _, err := parseReservedIngressRoutes(raw); err == nil {
			t.Fatalf("expected %q to fail", raw)
		}
	}
}

func TestReservedIngressUpstreamMustBeLoopbackReachable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	if err := verifyReservedIngressUpstreams([]ingressRoute{{Hostname: "rundea.example.com", HostPort: port}}); err != nil {
		t.Fatalf("expected loopback upstream to be reachable: %v", err)
	}
	if port <= 0 || strconv.Itoa(port) == "" {
		t.Fatal("invalid test port")
	}
}

func TestRenderCaddyfileIsDeterministicAndMarksReconciliation(t *testing.T) {
	marker := "00000000-0000-4000-8000-000000000001"
	got := renderCaddyfile([]ingressRoute{
		{Hostname: "z.example.com", HostPort: 19000},
		{Hostname: "a.example.com", HostPort: 18000},
	}, marker)
	want := "a.example.com {\n\treverse_proxy 127.0.0.1:18000 {\n\t\theader_down X-Rundea-Reconciliation " + marker + "\n\t}\n}\n\nz.example.com {\n\treverse_proxy 127.0.0.1:19000 {\n\t\theader_down X-Rundea-Reconciliation " + marker + "\n\t}\n}\n\n"
	if got != want {
		t.Fatalf("unexpected Caddyfile:\n%s", got)
	}
	if strings.Contains(got, "0.0.0.0") {
		t.Fatal("ingress upstream must remain loopback-only")
	}
}

func TestSafePublicIPGuard(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "::1", "fc00::1", "fe80::1"} {
		if isSafePublicIP(net.ParseIP(raw)) {
			t.Fatalf("expected %s to be rejected", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !isSafePublicIP(net.ParseIP(raw)) {
			t.Fatalf("expected %s to be accepted", raw)
		}
	}
}

func TestNormalizeHostname(t *testing.T) {
	if got := normalizeHostname(" API.Example.COM. "); got != "api.example.com" {
		t.Fatalf("unexpected hostname %q", got)
	}
}
