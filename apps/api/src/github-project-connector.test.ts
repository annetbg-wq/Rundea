import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { GitHubAppConfig } from "./github-app-source";
import { GitHubProjectConnector } from "./github-project-connector";

function config(): GitHubAppConfig {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    appId: "12345",
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function file(content: string) {
  return { type: "file", encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") };
}

function authToken() {
  return Response.json({ token: "ghs_test_installation_token_that_is_long_enough" }, { status: 201 });
}

test("lists repositories available to the Rundea GitHub App", async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === "https://api.github.com/app/installations?per_page=100") return Response.json([{ id: 77 }]);
    if (url === "https://api.github.com/app/installations/77/access_tokens") return authToken();
    if (url === "https://api.github.com/installation/repositories?per_page=100&page=1") {
      return Response.json({ repositories: [{ id: 900, full_name: "acme/mono", html_url: "https://github.com/acme/mono", visibility: "private", default_branch: "main" }] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const connector = new GitHubProjectConnector(config(), fetchImpl);
  const repositories = await connector.listRepositories();
  assert.deepEqual(repositories, [{ installationId: 77, repositoryId: 900, fullName: "acme/mono", url: "https://github.com/acme/mono", visibility: "PRIVATE", defaultBranch: "main" }]);
});

test("discovers concrete apps/api and apps/web services with ports, args, env and healthchecks", async () => {
  const sha = "a".repeat(40);
  const rootPackage = JSON.stringify({ private: true, workspaces: ["apps/*"] });
  const apiDockerfile = [
    "FROM node:24-alpine",
    "ENV PORT=8080",
    "EXPOSE 8080",
    "HEALTHCHECK CMD curl -f http://localhost:8080/health || exit 1",
  ].join("\n");
  const webDockerfile = [
    "FROM node:24-alpine",
    "ARG NEXT_PUBLIC_API_URL",
    "EXPOSE 3000",
    "HEALTHCHECK CMD wget -qO- http://localhost:3000/ || exit 1",
  ].join("\n");
  const files: Record<string, string> = {
    "package.json": rootPackage,
    "apps/api/Dockerfile": apiDockerfile,
    "apps/api/package.json": JSON.stringify({ scripts: { start: "node server.js" } }),
    "apps/api/.env.example": "DATABASE_URL=\nREDIS_URL=\n",
    "apps/web/Dockerfile": webDockerfile,
    "apps/web/package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" } }),
  };

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/mono/installation") return Response.json({ id: 77 });
    if (url === "https://api.github.com/app/installations/77/access_tokens") return authToken();
    if (url === "https://api.github.com/repos/acme/mono") {
      return Response.json({ id: 900, full_name: "acme/mono", html_url: "https://github.com/acme/mono", visibility: "private", default_branch: "main" });
    }
    if (url === "https://api.github.com/repos/acme/mono/commits/main") return Response.json({ sha });
    if (url === "https://api.github.com/repos/acme/mono/contents?ref=main") {
      return Response.json([{ name: "apps", type: "dir" }, { name: "package.json", type: "file" }]);
    }
    if (url === "https://api.github.com/repos/acme/mono/contents/package.json?ref=main") return Response.json(file(rootPackage));
    if (url === `https://api.github.com/repos/acme/mono/git/trees/${sha}?recursive=1`) {
      return Response.json({
        truncated: false,
        tree: Object.entries(files).map(([path, content]) => ({ path, type: "blob", size: Buffer.byteLength(content) })),
      });
    }
    const contentsPrefix = "https://api.github.com/repos/acme/mono/contents/";
    if (url.startsWith(contentsPrefix) && url.endsWith(`?ref=${sha}`)) {
      const path = decodeURIComponent(url.slice(contentsPrefix.length, -(`?ref=${sha}`.length)));
      if (files[path] !== undefined) return Response.json(file(files[path]!));
    }
    throw new Error(`unexpected URL ${url}; method=${init?.method ?? "GET"}`);
  };

  const connector = new GitHubProjectConnector(config(), fetchImpl);
  const discovery = await connector.inspect("acme/mono", "main");
  assert.equal(discovery.discovery.monorepo.value, true);
  assert.deepEqual(discovery.discovery.serviceCandidates.value, ["apps/api", "apps/web"]);
  assert.equal(discovery.discovery.services.length, 2);

  const api = discovery.discovery.services.find((service) => service.path === "apps/api");
  const web = discovery.discovery.services.find((service) => service.path === "apps/web");
  assert.deepEqual(api?.containerPorts, [8080]);
  assert.deepEqual(api?.environmentVariableNames, ["DATABASE_URL", "PORT", "REDIS_URL"]);
  assert.equal(api?.healthcheckPath, "/health");
  assert.equal(api?.dockerfile, "apps/api/Dockerfile");
  assert.deepEqual(web?.containerPorts, [3000]);
  assert.deepEqual(web?.buildArgumentNames, ["NEXT_PUBLIC_API_URL"]);
  assert.equal(web?.healthcheckPath, "/");
  assert.equal(web?.dockerfile, "apps/web/Dockerfile");
});
