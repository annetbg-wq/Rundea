import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import test from "node:test";
import {
  createGitHubAppJwt,
  GitHubArchiveProvider,
  loadGitHubAppConfig,
  type GitHubAppConfig,
} from "./github-app-source";

function keyPair(): { config: GitHubAppConfig; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    config: {
      appId: "12345",
      privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
    publicKey: pair.publicKey,
  };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

test("GitHub App JWT is RS256 signed with a ten minute window including backdate", () => {
  const { config, publicKey } = keyPair();
  const nowMs = 1_800_000_000_000;
  const jwt = createGitHubAppJwt(config, nowMs);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);
  const headerBody = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  assert.deepEqual(headerBody, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, Math.floor(nowMs / 1000) - 60);
  assert.equal(payload.exp, Math.floor(nowMs / 1000) + 540);
  assert.equal(
    cryptoVerify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2]!, "base64url"),
    ),
    true,
  );
});

test("GitHub App env config is optional but atomic", () => {
  assert.equal(loadGitHubAppConfig({}), null);
  assert.throws(() => loadGitHubAppConfig({ RUNDEA_GITHUB_APP_ID: "123" }));
  assert.throws(() => loadGitHubAppConfig({ RUNDEA_GITHUB_APP_PRIVATE_KEY_BASE64: "abc" }));

  const { config } = keyPair();
  const loaded = loadGitHubAppConfig({
    RUNDEA_GITHUB_APP_ID: config.appId,
    RUNDEA_GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(config.privateKeyPem).toString("base64"),
  });
  assert.equal(loaded?.appId, config.appId);
  assert.match(loaded?.privateKeyPem ?? "", /PRIVATE KEY/);
});

test("public GitHub archive path never needs GitHub App credentials", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://api.github.com/repos/acme/public/tarball/")) {
      return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/public/legacy.tar.gz/abc" } });
    }
    if (url.startsWith("https://codeload.github.com/")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    throw new Error(`unexpected URL ${url}`);
  };
  const provider = new GitHubArchiveProvider(null, fetchImpl);
  const result = await provider.fetchArchive("acme/public", "a".repeat(40));
  assert.equal(result.authMode, "PUBLIC");
  assert.deepEqual([...result.archive], [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(header(calls[0]!.init, "authorization"), null);
  assert.equal(header(calls[1]!.init, "authorization"), null);
});

test("private archive uses one-repository contents-read token and strips auth before codeload", async () => {
  const { config } = keyPair();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const installationToken = "ghs_12345_new_stateless_token_format_is_not_fixed_length";
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const authorization = header(init, "authorization");

    if (url.startsWith("https://api.github.com/repos/acme/private/tarball/") && !authorization) {
      return new Response(null, { status: 404 });
    }
    if (url === "https://api.github.com/repos/acme/private/installation") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ id: 9876 }, { status: 200 });
    }
    if (url === "https://api.github.com/app/installations/9876/access_tokens") {
      assert.equal(init?.method, "POST");
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["private"],
        permissions: { contents: "read" },
      });
      return Response.json({ token: installationToken, expires_at: "2099-01-01T00:00:00Z" }, { status: 201 });
    }
    if (url.startsWith("https://api.github.com/repos/acme/private/tarball/") && authorization) {
      assert.equal(authorization, `Bearer ${installationToken}`);
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://codeload.github.com/acme/private/legacy.tar.gz/abc?temporary=1" },
      });
    }
    if (url.startsWith("https://codeload.github.com/")) {
      assert.equal(authorization, null, "installation token must not be forwarded to codeload");
      assert.equal(init?.redirect, "error");
      return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const provider = new GitHubArchiveProvider(config, fetchImpl);
  const result = await provider.fetchArchive("acme/private", "b".repeat(40));
  assert.equal(result.authMode, "GITHUB_APP");
  assert.deepEqual([...result.archive], [4, 5, 6]);
  assert.equal(calls.length, 5);
});

test("archive redirect cannot escape to an attacker-controlled host", async () => {
  const fetchImpl = async (): Promise<Response> => new Response(null, {
    status: 302,
    headers: { location: "https://evil.example/archive.tar.gz" },
  });
  const provider = new GitHubArchiveProvider(null, fetchImpl);
  await assert.rejects(
    () => provider.fetchArchive("acme/public", "c".repeat(40)),
    /redirect host is not allowed/,
  );
});
