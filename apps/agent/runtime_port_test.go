package main

import "testing"

func TestParseSingleLoopbackPort(t *testing.T) {
	port, err := parseSingleLoopbackPort("3001/tcp -> 127.0.0.1:49153\n")
	if err != nil {
		t.Fatal(err)
	}
	if port != 49153 {
		t.Fatalf("port=%d, want 49153", port)
	}
}

func TestParseSingleLoopbackPortRejectsPublicBinding(t *testing.T) {
	if _, err := parseSingleLoopbackPort("3001/tcp -> 0.0.0.0:49153\n"); err == nil {
		t.Fatal("public binding must not be accepted as a Rundea backend loopback port")
	}
}

func TestParseSingleLoopbackPortRejectsMultiplePorts(t *testing.T) {
	input := "3001/tcp -> 127.0.0.1:49153\n3002/tcp -> 127.0.0.1:49154\n"
	if _, err := parseSingleLoopbackPort(input); err == nil {
		t.Fatal("multiple distinct loopback ports must be rejected")
	}
}

func TestParseSingleLoopbackPortDeduplicatesSameMapping(t *testing.T) {
	input := "3001/tcp -> 127.0.0.1:49153\n3001/tcp -> 127.0.0.1:49153\n"
	port, err := parseSingleLoopbackPort(input)
	if err != nil {
		t.Fatal(err)
	}
	if port != 49153 {
		t.Fatalf("port=%d, want 49153", port)
	}
}

func TestParseSingleLoopbackPortRejectsIPv6Loopback(t *testing.T) {
	if _, err := parseSingleLoopbackPort("3001/tcp -> [::1]:49153\n"); err == nil {
		t.Fatal("IPv6 loopback must be rejected while the runtime router is explicitly IPv4-only")
	}
}
