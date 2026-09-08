package main

import (
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

func TestRenderCaddyfileIsDeterministic(t *testing.T) {
	got := renderCaddyfile([]ingressRoute{
		{Hostname: "z.example.com", HostPort: 19000},
		{Hostname: "a.example.com", HostPort: 18000},
	})
	want := "a.example.com {\n\treverse_proxy 127.0.0.1:18000\n}\n\nz.example.com {\n\treverse_proxy 127.0.0.1:19000\n}\n\n"
	if got != want {
		t.Fatalf("unexpected Caddyfile:\n%s", got)
	}
	if strings.Contains(got, "0.0.0.0") {
		t.Fatal("ingress upstream must remain loopback-only")
	}
}

func TestNormalizeHostname(t *testing.T) {
	if got := normalizeHostname(" API.Example.COM. "); got != "api.example.com" {
		t.Fatalf("unexpected hostname %q", got)
	}
}
