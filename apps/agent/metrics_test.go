package main

import (
	"testing"
)

func TestParseDockerPercent(t *testing.T) {
	got, err := parseDockerPercent(" 12.34% ")
	if err != nil {
		t.Fatal(err)
	}
	if got != 12.34 {
		t.Fatalf("unexpected CPU percentage: %v", got)
	}
	for _, value := range []string{"-1%", "NaN%", "abc", "100001%"} {
		if _, err := parseDockerPercent(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
}

func TestParseDockerBytesSupportsDockerUnits(t *testing.T) {
	cases := map[string]uint64{
		"0B":      0,
		"1kB":     1000,
		"1.5MB":   1500000,
		"1KiB":    1024,
		"8.5MiB":  8912896,
		"1GiB":    1073741824,
		"2.25 GiB": 2415919104,
	}
	for input, want := range cases {
		got, err := parseDockerBytes(input)
		if err != nil {
			t.Fatalf("parse %q: %v", input, err)
		}
		if got != want {
			t.Fatalf("parse %q = %d, want %d", input, got, want)
		}
	}
	for _, input := range []string{"", "-1MiB", "1XB", "NaNB"} {
		if _, err := parseDockerBytes(input); err == nil {
			t.Fatalf("expected %q to be rejected", input)
		}
	}
}

func TestParseDockerPair(t *testing.T) {
	usage, limit, err := parseDockerPair("8.5MiB / 512MiB")
	if err != nil {
		t.Fatal(err)
	}
	if usage != 8912896 || limit != 536870912 {
		t.Fatalf("unexpected pair: %d / %d", usage, limit)
	}
	rx, tx, err := parseDockerPair("1.2kB / 500B")
	if err != nil {
		t.Fatal(err)
	}
	if rx != 1200 || tx != 500 {
		t.Fatalf("unexpected network pair: %d / %d", rx, tx)
	}
}

func TestMetricDeploymentIDPattern(t *testing.T) {
	if !metricDeploymentIDPattern.MatchString("123e4567-e89b-42d3-a456-426614174000") {
		t.Fatal("expected valid deployment UUID to match")
	}
	if metricDeploymentIDPattern.MatchString("../../escape") {
		t.Fatal("invalid deployment label should not match")
	}
}
