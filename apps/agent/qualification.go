package main

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

type qualifyCommand struct {
	Type            string `json:"type"`
	QualificationID string `json:"qualificationId"`
	Profile         string `json:"profile"`
}

type probeTarget struct {
	Name string
	Host string
	Port int
}

type probeResult struct {
	Name      string `json:"name"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latencyMs,omitempty"`
	Error     string `json:"error,omitempty"`
}

var sendinaEgressTargets = []probeTarget{
	{Name: "smtp-tls", Host: "smtp.gmail.com", Port: 465},
	{Name: "smtp-starttls", Host: "smtp.gmail.com", Port: 587},
	{Name: "imap-tls", Host: "imap.gmail.com", Port: 993},
}

func targetsForQualificationProfile(profile string) ([]probeTarget, error) {
	switch profile {
	case "sendina-egress-v1":
		return sendinaEgressTargets, nil
	default:
		return nil, fmt.Errorf("unsupported qualification profile %q", profile)
	}
}

func runQualification(w *writer, cmd qualifyCommand) {
	started := time.Now().UTC()
	targets, err := targetsForQualificationProfile(cmd.Profile)
	if err != nil {
		_ = w.send(map[string]any{
			"type": "qualification", "qualificationId": cmd.QualificationID, "profile": cmd.Profile,
			"ok": false, "startedAt": started.Format(time.RFC3339Nano), "completedAt": time.Now().UTC().Format(time.RFC3339Nano),
			"probes": []probeResult{},
		})
		return
	}

	results := make([]probeResult, 0, len(targets))
	allOK := true
	for _, target := range targets {
		result := runTCPProbe(context.Background(), target, 5*time.Second)
		results = append(results, result)
		if !result.OK {
			allOK = false
		}
	}
	_ = w.send(map[string]any{
		"type": "qualification", "qualificationId": cmd.QualificationID, "profile": cmd.Profile,
		"ok": allOK, "startedAt": started.Format(time.RFC3339Nano), "completedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"probes": results,
	})
}

func runTCPProbe(parent context.Context, target probeTarget, timeout time.Duration) probeResult {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	started := time.Now()
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target.Host, strconv.Itoa(target.Port)))
	latency := time.Since(started).Milliseconds()
	result := probeResult{Name: target.Name, Host: target.Host, Port: target.Port, LatencyMS: latency}
	if err != nil {
		result.Error = sanitizeProbeError(err.Error())
		return result
	}
	result.OK = true
	_ = conn.Close()
	return result
}

func sanitizeProbeError(value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.TrimSpace(value)
	if len(value) > 500 {
		value = value[:500]
	}
	return value
}
