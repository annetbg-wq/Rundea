import assert from "node:assert/strict";
import test from "node:test";
import { canTransition } from "./index.ts";

test("happy path requires healthcheck before READY", () => {
  assert.equal(canTransition("QUEUED", "BUILDING"), true);
  assert.equal(canTransition("BUILDING", "DEPLOYING"), true);
  assert.equal(canTransition("DEPLOYING", "HEALTHCHECK"), true);
  assert.equal(canTransition("HEALTHCHECK", "READY"), true);
  assert.equal(canTransition("DEPLOYING", "READY"), false);
});

test("terminal failures cannot silently recover", () => {
  assert.equal(canTransition("FAILED", "READY"), false);
  assert.equal(canTransition("CANCELLED", "BUILDING"), false);
});
