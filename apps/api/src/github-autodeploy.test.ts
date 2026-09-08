import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { canonicalGitHubRepository, validateGitHubBranch, verifyGitHubSignature } from "./github-autodeploy";

test("canonicalGitHubRepository normalizes an HTTPS GitHub repository", () => {
  assert.deepEqual(canonicalGitHubRepository("https://github.com/Render-Examples/express-hello-world.git"), {
    fullName: "render-examples/express-hello-world",
    cloneUrl: "https://github.com/Render-Examples/express-hello-world.git",
  });
  assert.deepEqual(canonicalGitHubRepository("https://github.com/render-examples/express-hello-world"), {
    fullName: "render-examples/express-hello-world",
    cloneUrl: "https://github.com/render-examples/express-hello-world.git",
  });
});

test("canonicalGitHubRepository rejects credentials, query strings and nested paths", () => {
  for (const repository of [
    "http://github.com/owner/repo",
    "https://token@github.com/owner/repo",
    "https://github.com/owner/repo?token=x",
    "https://github.com/owner/repo/tree/main",
    "https://example.com/owner/repo",
  ]) {
    assert.throws(() => canonicalGitHubRepository(repository));
  }
});

test("validateGitHubBranch accepts common names and rejects revision syntax", () => {
  for (const branch of ["main", "release/v1.2.3", "feature/foo_bar", "hotfix-2026.09"]) {
    assert.equal(validateGitHubBranch(branch), branch);
  }
  for (const branch of ["", "-main", "/main", "main/", "foo..bar", "foo~1", "foo^", "foo:bar", "foo?bar", "foo*bar", "foo[bar", "foo\\bar", "foo@{bar", "foo bar", "main.lock"]) {
    assert.throws(() => validateGitHubBranch(branch));
  }
});

test("verifyGitHubSignature requires the exact HMAC-SHA256 body signature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from('{"ref":"refs/heads/main","after":"039c34770852fb07cef7f9f0f8534c5de408b207"}');
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature(secret, body, signature), true);
  assert.equal(verifyGitHubSignature(secret, Buffer.from(body.toString().replace("main", "prod")), signature), false);
  assert.equal(verifyGitHubSignature(secret, body, "sha256=bad"), false);
  assert.equal(verifyGitHubSignature(secret, body, undefined), false);
});
