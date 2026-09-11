import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { GitHubAppConfig } from "./github-app-source";
import { GitHubAppDiscoveryReader } from "./github-app-discovery-reader";
import { discoverGitHubSource } from "./github-source-discovery";

function config(): GitHubAppConfig {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    appId: "12345",
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

function encodedBlob(text: string) {
  return { encoding: "base64", size: Buffer.byteLength(text), content: Buffer.from(text).toString("base64") };
}

test("GitHub App discovery uses one repo-scoped contents token and never returns it", async () => {
  const appConfig = config();
  const token = "ghs_scoped_discovery_token_that_must_never_leave_reader";
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const dockerSha = "c".repeat(40);
  const packageSha = "d".repeat(40);
  const envSha = "e".repeat(40);
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });

    if (url === "https://api.github.com/repos/acme/payments/installation") {
      assert.match(authorization(init) ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ id: 77 });
    }
    if (url === "https://api.github.com/app/installations/77/access_tokens") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["payments"],
        permissions: { contents: "read" },
      });
      return Response.json({ token, expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
    }

    assert.equal(authorization(init), `Bearer ${token}`);
    if (url === "https://api.github.com/repos/acme/payments") {
      return Response.json({
        full_name: "acme/payments",
        html_url: "https://github.com/acme/payments",
        visibility: "private",
        default_branch: "main",
      });
    }
    if (url === "https://api.github.com/repos/acme/payments/commits/main") {
      return Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (url === `https://api.github.com/repos/acme/payments/git/trees/${treeSha}?recursive=1`) {
      return Response.json({
        truncated: false,
        tree: [
          { path: "Dockerfile", type: "blob", sha: dockerSha, size: 48 },
          { path: "package.json", type: "blob", sha: packageSha, size: 80 },
          { path: ".env.example", type: "blob", sha: envSha, size: 40 },
        ],
      });
    }
    if (url === `https://api.github.com/repos/acme/payments/git/blobs/${dockerSha}`) {
      return Response.json(encodedBlob("FROM node:24\nEXPOSE 4000\n"));
    }
    if (url === `https://api.github.com/repos/acme/payments/git/blobs/${packageSha}`) {
      return Response.json(encodedBlob(JSON.stringify({ scripts: { build: "tsc", start: "node app.js" } })));
    }
    if (url === `https://api.github.com/repos/acme/payments/git/blobs/${envSha}`) {
      return Response.json(encodedBlob("DATABASE_URL=do-not-return-this-value\n"));
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const reader = new GitHubAppDiscoveryReader(appConfig, fetchImpl, () => 1_800_000_000_000);
  const result = await discoverGitHubSource(reader, "acme/payments");

  assert.equal(result.commitSha, commitSha);
  assert.deepEqual(result.portCandidates, [4000]);
  assert.deepEqual(result.environmentVariableNames, ["DATABASE_URL"]);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("do-not-return-this-value"), false);
  assert.equal(calls.filter((call) => call.url.endsWith("/installation")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/access_tokens")).length, 1);
});

test("discovery fails closed when GitHub tree is truncated", async () => {
  const appConfig = config();
  const token = "ghs_scoped";
  const treeSha = "b".repeat(40);
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/installation")) return Response.json({ id: 77 });
    if (url.endsWith("/access_tokens")) return Response.json({ token, expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
    if (url === "https://api.github.com/repos/acme/huge") {
      return Response.json({ full_name: "acme/huge", html_url: "https://github.com/acme/huge", visibility: "private", default_branch: "main" });
    }
    if (url.endsWith("/commits/main")) return Response.json({ sha: "a".repeat(40), commit: { tree: { sha: treeSha } } });
    if (url.includes("/git/trees/")) return Response.json({ truncated: true, tree: [] });
    throw new Error(`unexpected URL ${url}`);
  };
  const reader = new GitHubAppDiscoveryReader(appConfig, fetchImpl);
  await assert.rejects(discoverGitHubSource(reader, "acme/huge"), /tree is truncated/);
});

test("connected discovery requires a configured GitHub App", async () => {
  const reader = new GitHubAppDiscoveryReader(null, async () => new Response(null, { status: 500 }));
  await assert.rejects(reader.repository("acme/private"), /GitHub App is required/);
});
