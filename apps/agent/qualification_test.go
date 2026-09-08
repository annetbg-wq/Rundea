package main

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"
)

func TestTargetsForSendinaProfileAreFixed(t *testing.T) {
	targets, err := targetsForQualificationProfile("sendina-egress-v1")
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 3 {
		t.Fatalf("expected 3 probes, got %d", len(targets))
	}
	want := map[string]string{
		"smtp-tls":      "smtp.gmail.com:465",
		"smtp-starttls": "smtp.gmail.com:587",
		"imap-tls":      "imap.gmail.com:993",
	}
	for _, target := range targets {
		if got := net.JoinHostPort(target.Host, strconv.Itoa(target.Port)); got != want[target.Name] {
			t.Fatalf("unexpected target %s=%s", target.Name, got)
		}
	}
}

func TestTargetsRejectUnknownProfile(t *testing.T) {
	if _, err := targetsForQualificationProfile("arbitrary-scan"); err == nil {
		t.Fatal("expected unsupported profile to fail")
	}
}

func TestRunTCPProbeAgainstLocalListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	address := listener.Addr().(*net.TCPAddr)
	result := runTCPProbe(context.Background(), probeTarget{Name: "local", Host: "127.0.0.1", Port: address.Port}, time.Second)
	if !result.OK {
		t.Fatalf("expected local probe to pass: %+v", result)
	}
}
