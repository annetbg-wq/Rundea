import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  agentAssetName,
  GitHubAgentReleaseProvider,
  loadAgentReleaseConfig,
  parseSha256Manifest,
  type AgentReleaseConfig,
} from "./agent-release";

function releaseConfig(): AgentReleaseConfig {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    repositoryFullName: "acme/rundea-releases",
    tag: "agent-v0.1.0",
    appConfig: {
      appId: "12345",
      privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    },
  };
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

test("agent release env config is optional and atomic", () => {
  assert.equal(loadAgentReleaseConfig({}), null);
  assert.throws(() => loadAgentReleaseConfig({ RUNDEA_AGENT_RELEASE_REPOSITORY: "acme/releases" }));
  assert.throws(() => loadAgentReleaseConfig({ RUNDEA_AGENT_RELEASE_TAG: "agent-v1" }));
  assert.throws(() => loadAgentReleaseConfig({
    RUNDEA_AGENT_RELEASE_REPOSITORY: "acme/releases",
    RUNDEA_AGENT_RELEASE_TAG: "agent-v1",
  }), /GitHub App/);
});

test("SHA256SUMS parser rejects malformed and duplicate entries", () => {
  const digest = "a".repeat(64);
  assert.equal(parseSha256Manifest(`${digest}  rundea-agent-linux-amd64\n`).get("rundea-agent-linux-amd64"), digest);
  assert.throws(() => parseSha256Manifest("not-a-checksum file"));
  assert.throws(() => parseSha256Manifest(`${digest}  agent\n${digest}  agent\n`), /duplicate/);
});

test("private release uses repository-scoped contents-read token and never forwards it to release asset host", async () => {
  const config = releaseConfig();
  const binary = Buffer.from("verified-agent-binary");
  const digest = createHash("sha256").update(binary).digest("hex");
  const manifest = Buffer.from(`${digest}  ${agentAssetName("amd64")}\n`);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const installationToken = "ghs_release_token";
  const assetBase = "https://api.github.com/repos/acme/rundea-releases/releases/assets";

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const authorization = header(init, "authorization");
    if (url === "https://api.github.com/repos/acme/rundea-releases/installation") {
      assert.match(authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ id: 77 });
    }
    if (url === "https://api.github.com/app/installations/77/access_tokens") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        repositories: ["rundea-releases"],
        permissions: { contents: "read" },
      });
      return Response.json({ token: installationToken }, { status: 201 });
    }
    if (url.endsWith("/releases/tags/agent-v0.1.0")) {
      assert.equal(authorization, `Bearer ${installationToken}`);
      return Response.json({ assets: [
        { name: "SHA256SUMS", url: `${assetBase}/1`, size: manifest.byteLength },
        { name: agentAssetName("amd64"), url: `${assetBase}/2`, size: binary.byteLength },
      ] });
    }
    if (url === `${assetBase}/1`) {
      assert.equal(authorization, `Bearer ${installationToken}`);
      return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/private/manifest?sig=1" } });
    }
    if (url === `${assetBase}/2`) {
      assert.equal(authorization, `Bearer ${installationToken}`);
      return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/private/agent?sig=2" } });
    }
    if (url.startsWith("https://release-assets.githubusercontent.com/")) {
      assert.equal(authorization, null, "GitHub installation credential must not reach release CDN");
      return new Response(manifest);
    }
    if (url.startsWith("https://objects.githubusercontent.com/")) {
      assert.equal(authorization, null, "GitHub installation credential must not reach release CDN");
      return new Response(binary);
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const provider = new GitHubAgentReleaseProvider(config, fetchImpl);
  const release = await provider.get("amd64");
  assert.equal(release.sha256, digest);
  assert.deepEqual(release.binary, binary);
  assert.equal(release.tag, "agent-v0.1.0");
  const callCount = calls.length;
  await provider.get("amd64");
  assert.equal(calls.length, callCount, "immutable configured release should be cached in process");
});

test("release redirect cannot escape GitHub-controlled asset hosts", async () => {
  const config = releaseConfig();
  const digest = createHash("sha256").update("agent").digest("hex");
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/installation")) return Response.json({ id: 1 });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_test" }, { status: 201 });
    if (url.includes("/releases/tags/")) return Response.json({ assets: [
      { name: "SHA256SUMS", url: "https://api.github.com/repos/acme/rundea-releases/releases/assets/1", size: 80 },
      { name: agentAssetName("amd64"), url: "https://api.github.com/repos/acme/rundea-releases/releases/assets/2", size: 5 },
    ] });
    if (url.endsWith("/assets/1")) return new Response(`${digest}  ${agentAssetName("amd64")}\n`);
    if (url.endsWith("/assets/2")) return new Response(null, { status: 302, headers: { location: "https://evil.example/agent" } });
    throw new Error(`unexpected URL ${url}; auth=${header(init, "authorization")}`);
  };
  const provider = new GitHubAgentReleaseProvider(config, fetchImpl);
  await assert.rejects(() => provider.get("amd64"), /redirect host is not allowed/);
});

test("binary checksum mismatch is rejected", async () => {
  const config = releaseConfig();
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/installation")) return Response.json({ id: 1 });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "ghs_test" }, { status: 201 });
    if (url.includes("/releases/tags/")) return Response.json({ assets: [
      { name: "SHA256SUMS", url: "https://api.github.com/repos/acme/rundea-releases/releases/assets/1", size: 80 },
      { name: agentAssetName("amd64"), url: "https://api.github.com/repos/acme/rundea-releases/releases/assets/2", size: 5 },
    ] });
    if (url.endsWith("/assets/1")) return new Response(`${"0".repeat(64)}  ${agentAssetName("amd64")}\n`);
    if (url.endsWith("/assets/2")) return new Response("agent");
    throw new Error(`unexpected URL ${url}`);
  };
  const provider = new GitHubAgentReleaseProvider(config, fetchImpl);
  await assert.rejects(() => provider.get("amd64"), /checksum mismatch/);
});
