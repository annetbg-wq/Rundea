import assert from "node:assert/strict";
import test from "node:test";
import { canonicalGitHubRepository, readResponseBodyWithLimit, validateSourceDelivery } from "./source-broker";

test("canonicalGitHubRepository accepts strict GitHub clone URLs", () => {
  assert.deepEqual(canonicalGitHubRepository("https://github.com/OpenAI/openai.git"), {
    owner: "OpenAI",
    repository: "openai",
    fullName: "OpenAI/openai",
  });
});

test("canonicalGitHubRepository rejects credentials and non-GitHub hosts", () => {
  for (const value of [
    "https://token@github.com/owner/repo.git",
    "https://github.example.com/owner/repo.git",
    "http://github.com/owner/repo.git",
    "https://github.com/owner/repo/extra",
    "https://github.com/owner/repo.git?token=x",
  ]) {
    assert.throws(() => canonicalGitHubRepository(value));
  }
});

test("broker delivery requires an exact commit", () => {
  const sha = "039c34770852fb07cef7f9f0f8534c5de408b207";
  assert.equal(validateSourceDelivery(undefined, "main"), "DIRECT");
  assert.equal(validateSourceDelivery("direct", "main"), "DIRECT");
  assert.equal(validateSourceDelivery("broker", sha), "BROKER");
  assert.throws(() => validateSourceDelivery("broker", "main"));
  assert.throws(() => validateSourceDelivery("other", sha));
});

test("source archive body is rejected as soon as the streaming limit is exceeded", async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(() => readResponseBodyWithLimit(response, 3), /exceeds v0 compressed size limit/);
});

test("source archive body rejects empty responses", async () => {
  const response = new Response(new Uint8Array());
  await assert.rejects(() => readResponseBodyWithLimit(response, 3), /source archive is empty/);
});
