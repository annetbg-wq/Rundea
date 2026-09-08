import assert from "node:assert/strict";
import test from "node:test";
import { canonicalGitHubRepository, validateSourceDelivery } from "./source-broker";

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
