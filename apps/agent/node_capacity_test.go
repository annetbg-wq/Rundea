package main

import (
	"strings"
	"testing"
)

func TestSystemReserveUsesFloorAndPercentage(t *testing.T) {
	mib := uint64(1024 * 1024)
	if got := systemReserveBytes(2 * 1024 * mib); got != 768*mib {
		t.Fatalf("2 GiB node reserve = %d MiB, want 768", got/mib)
	}
	total := uint64(8 * 1024 * 1024 * 1024)
	if got := systemReserveBytes(total); got != total/5 {
		t.Fatalf("8 GiB node reserve = %d bytes, want exact 20%% = %d", got, total/5)
	}
}

func TestValidateNodeMemoryCapacityReservesSystemHeadroom(t *testing.T) {
	mib := uint64(1024 * 1024)
	if err := validateNodeMemoryCapacity(4096*mib, 2*768*mib, 1024*mib); err != nil {
		t.Fatalf("safe 4 GiB build rejected: %v", err)
	}
	if err := validateNodeMemoryCapacity(4096*mib, 3*768*mib, 1024*mib); err == nil || !strings.Contains(err.Error(), "Rundea reserve") {
		t.Fatalf("unsafe 4 GiB build was not rejected: %v", err)
	}
	if err := validateNodeMemoryCapacity(2048*mib, 768*mib, 768*mib); err == nil {
		t.Fatal("2 GiB node must reject a second 768 MiB runtime when reserve would be consumed")
	}
}

func TestParseMemTotalBytes(t *testing.T) {
	got, err := parseMemTotalBytes(strings.NewReader("MemFree: 10 kB\nMemTotal:       4194304 kB\n"))
	if err != nil {
		t.Fatal(err)
	}
	if want := uint64(4 * 1024 * 1024 * 1024); got != want {
		t.Fatalf("MemTotal parsed as %d, want %d", got, want)
	}
	if _, err := parseMemTotalBytes(strings.NewReader("MemFree: 10 kB\n")); err == nil {
		t.Fatal("missing MemTotal must fail closed")
	}
}
