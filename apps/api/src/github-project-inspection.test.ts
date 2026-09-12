import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { GitHubArchiveProvider, type GitHubAppConfig } from "./github-app-source";

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

function fileBody(content: string) {
  return {
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(content),
    content: Buffer.from(content, "utf8").toString("base64"),
  };
}

test("repository inspection uses a repository-scoped token and returns only allowlisted discovery files", async () => {
  const installationToken = "ghs_private_installation_token_must_never_escape";
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    const auth = authorization(init);

    if (url === "https://api.github.com/repos/Acme/App/installation") {
      assert.match(auth ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return Response.json({ id: 777 }, { status: 200 });
    }
    if (url === "https://api.github.com/app/installations/777/access_tokens") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { repositories: ["App"], permissions: { contents: "read" } });
      return Response.json({ token: installationToken }, { status: 201 });
    }
    assert.equal(auth, `Bearer ${installationToken}`);
    if (url === "https://api.github.com/repos/Acme/App") {
      return Response.json({
        id: 888,
        full_name: "Acme/App",
        html_url: "https://github.com/Acme/App",
        visibility: "private",
        default_branch: "main",
      });
    }
    if (url === "https://api.github.com/repos/Acme/App/commits/main") {
      return Response.json({ sha: "c".repeat(40) });
    }
    if (url === "https://api.github.com/repos/Acme/App/contents?ref=main") {
      return Response.json([
        { name: "Dockerfile", type: "file" },
        { name: "package.json", type: "file" },
        { name: ".env.example", type: "file" },
        { name: ".env", type: "file" },
        { name: "README.md", type: "file" },
      ]);
    }
    if (url === "https://api.github.com/repos/Acme/App/contents/Dockerfile?ref=main") {
      return Response.json(fileBody("FROM node:24\nEXPOSE 3000\n"));
    }
    if (url === "https://api.github.com/repos/Acme/App/contents/package.json?ref=main") {
      return Response.json(fileBody(JSON.stringify({ scripts: { start: "node server.js" } })));
    }
    if (url === "https://api.github.com/repos/Acme/App/contents/.env.example?ref=main") {
      return Response.json(fileBody("DATABASE_URL=placeholder\n"));
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const provider = new GitHubArchiveProvider(config(), fetchImpl);
  const result = await provider.inspectRepository("Acme/App");

  assert.equal(result.installationId, 777);
  assert.equal(result.repositoryId, 888);
  assert.equal(result.repositoryFullName, "acme/app");
  assert.equal(result.repositoryUrl, "https://github.com/Acme/App");
  assert.equal(result.visibility, "PRIVATE");
  assert.equal(result.defaultBranch, "main");
  assert.equal(result.selectedBranch, "main");
  assert.equal(result.revisionSha, "c".repeat(40));
  assert.deepEqual(Object.keys(result.files).sort(), [".env.example", "Dockerfile", "package.json"]);
  assert.equal(requested.some((url) => url.includes("/contents/.env?")), false);
  assert.equal(JSON.stringify(result).includes(installationToken), false);
});

test("repository inspection rejects unconfigured GitHub App before network access", async () => {
  let called = false;
  const provider = new GitHubArchiveProvider(null, async () => {
    called = true;
    throw new Error("network should not be called");
  });

  await assert.rejects(() => provider.inspectRepository("acme/app"), /GitHub App is required/);
  assert.equal(called, false);
});
