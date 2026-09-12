import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBuildArgs } from "./build-args";

test("normalizeBuildArgs accepts and sorts string build args", () => {
  assert.deepEqual(normalizeBuildArgs({ ZETA: "2", NEXT_PUBLIC_API_URL: "https://api.example.com", EMPTY: "" }), {
    EMPTY: "",
    NEXT_PUBLIC_API_URL: "https://api.example.com",
    ZETA: "2",
  });
});

test("normalizeBuildArgs rejects non-string values and unsafe names", () => {
  assert.throws(() => normalizeBuildArgs({ "BAD-NAME": "x" }), /invalid build arg name/);
  assert.throws(() => normalizeBuildArgs({ PORT: 3000 }), /must be a string/);
});

test("normalizeBuildArgs rejects line breaks, NULs and excessive entry counts", () => {
  assert.throws(() => normalizeBuildArgs({ VALUE: "line1\nline2" }), /invalid or oversized/);
  assert.throws(() => normalizeBuildArgs({ VALUE: "a\u0000b" }), /invalid or oversized/);
  assert.throws(
    () => normalizeBuildArgs(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`ARG_${index}`, "x"]))),
    /at most 64 entries/,
  );
});
