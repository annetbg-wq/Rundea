import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@rundea/contracts";
import { validateQualificationEvent } from "./node-qualification";

function validEvent(): Extract<AgentEvent, { type: "qualification" }> {
  return {
    type: "qualification",
    qualificationId: "00000000-0000-4000-8000-000000000001",
    profile: "sendina-egress-v1",
    ok: true,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    probes: [
      { name: "smtp-tls", host: "smtp.gmail.com", port: 465, ok: true, latencyMs: 12 },
      { name: "smtp-starttls", host: "smtp.gmail.com", port: 587, ok: true, latencyMs: 14 },
      { name: "imap-tls", host: "imap.gmail.com", port: 993, ok: true, latencyMs: 18 },
    ],
  };
}

test("accepts exact Sendina qualification result", () => {
  assert.doesNotThrow(() => validateQualificationEvent(validEvent()));
});

test("rejects substituted probe target", () => {
  const event = validEvent();
  event.probes[0] = { ...event.probes[0], host: "127.0.0.1" };
  assert.throws(() => validateQualificationEvent(event));
});

test("rejects aggregate pass when one probe failed", () => {
  const event = validEvent();
  event.probes[1] = { ...event.probes[1], ok: false, error: "blocked" };
  assert.throws(() => validateQualificationEvent(event));
});
