import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.RUNDEA_CONTROL_TOKEN ?? "acceptance-control-token";
const masterKey = process.env.RUNDEA_MASTER_KEY ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const webhookSecret = process.env.RUNDEA_GITHUB_WEBHOOK_SECRET ?? "acceptance-github-webhook-secret";
const root = mkdtempSync(join(tmpdir(), "rundea-dr-"));
const sourceRoot = join(root, "source-root");
const restoreRoot = join(root, "restore-root");
const backupRoot = join(root, "backups");
const sourceEnv = join(root, "source.env");
const targetEnv = join(root, "restored.env");
const recoveryKeyFile = join(root, "recovery.key");
const composeFile = resolve("infra/live/docker-compose.staging.yml");
const backupScript = resolve("infra/dr/BACKUP_CONTROL_PLANE.sh");
const restoreScript = resolve("infra/dr/RESTORE_CONTROL_PLANE.sh");
const destinationName = "rundea-dr-" + Math.random().toString(36).slice(2, 10);
let restoredApi;

function sh(file, args, env = {}) {
  return execFileSync(file, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function request(path, init = {}) {
  const response = await fetch(api + path, {
    ...init,
    headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

async function waitFor(url, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("timed out waiting for " + url);
}

function sourcePostgresContainer() {
  const ids = sh("docker", ["ps", "--filter", "ancestor=postgres:17-alpine", "--format", "{{.ID}}"])
    .trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1) throw new Error(`expected exactly one postgres:17-alpine CI service container, found ${ids.length}`);
  return ids[0];
}

try {
  const suffix = Date.now().toString(36);
  const workspace = await request("/v0/workspaces", {
    method: "POST",
    body: JSON.stringify({ slug: "drw-" + suffix, name: "DR Workspace " + suffix }),
  });
  const project = await request(`/v0/workspaces/${workspace.id}/projects`, {
    method: "POST",
    body: JSON.stringify({ slug: "drp-" + suffix, name: "DR Project " + suffix }),
  });
  const service = await request(`/v0/projects/${project.id}/services`, {
    method: "POST",
    body: JSON.stringify({ slug: "drs-" + suffix, name: "DR Service " + suffix }),
  });

  const publicValue = "restored-public-" + suffix;
  const secretValue = "restored-secret-" + suffix;
  await request(`/v0/services/${service.id}/config/variables`, {
    method: "PUT",
    body: JSON.stringify({
      variables: [
        { key: "DR_PUBLIC_VALUE", value: publicValue, secret: false },
        { key: "DR_SECRET_VALUE", value: secretValue, secret: true },
      ],
    }),
  });

  mkdirSync(join(sourceRoot, "var/lib/rundea/caddy-data"), { recursive: true });
  mkdirSync(join(sourceRoot, "var/lib/rundea/caddy-config"), { recursive: true });
  mkdirSync(join(sourceRoot, "var/lib/rundea/caddy"), { recursive: true });
  mkdirSync(join(sourceRoot, "etc/systemd/system/rundea-agent.service.d"), { recursive: true });
  mkdirSync(join(sourceRoot, "etc/rundea"), { recursive: true });
  writeFileSync(join(sourceRoot, "var/lib/rundea/caddy/Caddyfile"), "rundea.example.test { reverse_proxy 127.0.0.1:4100 }\n");
  writeFileSync(join(sourceRoot, "var/lib/rundea/caddy-data/acme-marker"), "durable-acme-state\n");
  writeFileSync(join(sourceRoot, "var/lib/rundea/caddy-config/config-marker"), "durable-caddy-config\n");
  writeFileSync(join(sourceRoot, "etc/systemd/system/rundea-agent.service.d/10-reserved-ingress.conf"), "[Service]\nEnvironment=RUNDEA_RESERVED_INGRESS_ROUTES=rundea.example.test=4100\n");
  writeFileSync(join(sourceRoot, "etc/rundea/agent.env"), "RUNDEA_NODE_ID=fixture-node\n");

  writeFileSync(sourceEnv, [
    "POSTGRES_PASSWORD=rundea",
    "POSTGRES_USER=rundea",
    "POSTGRES_DB=rundea",
    "RUNDEA_CONTROL_TOKEN=" + token,
    "RUNDEA_MASTER_KEY=" + masterKey,
    "RUNDEA_GITHUB_WEBHOOK_SECRET=" + webhookSecret,
    "RUNDEA_WEB_ORIGIN=http://127.0.0.1:5173",
    "RUNDEA_IMAGE_TAG=" + "a".repeat(40),
    "RUNDEA_WEB_PASSWORD_HASH=fixture",
    "RUNDEA_INGRESS_MODE=managed",
    "RUNDEA_BACKUP_RETENTION=3",
    "",
  ].join("\n"));
  chmodSync(sourceEnv, 0o600);
  writeFileSync(recoveryKeyFile, sh("openssl", ["rand", "-base64", "32"]).trim() + "\n");
  chmodSync(recoveryKeyFile, 0o600);

  const sourcePg = sourcePostgresContainer();
  sh("bash", [backupScript, sourceEnv, backupRoot, composeFile], {
    RUNDEA_RECOVERY_KEY_FILE: recoveryKeyFile,
    RUNDEA_POSTGRES_CONTAINER: sourcePg,
    RUNDEA_DR_ROOT: sourceRoot,
  });

  const backupDir = join(backupRoot, readFileSync(join(backupRoot, "latest"), { encoding: "utf8", flag: "r" }).trim());
  // 'latest' is a symlink in production. readFileSync follows it and would read a
  // directory, so resolve it with readlink through the host utility instead.
  const actualBackup = join(backupRoot, sh("readlink", [join(backupRoot, "latest")]).trim());
  for (const name of ["database.dump.enc", "environment.env.enc", "host-state.tar.enc", "metadata.env", "SHA256SUMS"]) {
    assert.equal(existsSync(join(actualBackup, name)), true, name + " missing from backup");
  }
  assert.equal(existsSync(join(actualBackup, "database.dump")), false);
  assert.equal(existsSync(join(actualBackup, "host-state.tar")), false);

  writeFileSync(join(root, "wrong.key"), sh("openssl", ["rand", "-base64", "32"]).trim() + "\n");
  chmodSync(join(root, "wrong.key"), 0o600);
  let wrongKeyFailed = false;
  try {
    sh("bash", [restoreScript, join(root, "wrong.env"), actualBackup, composeFile], {
      RUNDEA_RECOVERY_KEY_FILE: join(root, "wrong.key"),
      RUNDEA_POSTGRES_CONTAINER: sourcePg,
      RUNDEA_DR_ROOT: join(root, "wrong-root"),
      RUNDEA_RESTORE_SKIP_RUNTIME_START: "1",
    });
  } catch {
    wrongKeyFailed = true;
  }
  assert.equal(wrongKeyFailed, true, "restore must fail with a different recovery key");

  sh("docker", [
    "run", "-d", "--name", destinationName,
    "-e", "POSTGRES_USER=rundea",
    "-e", "POSTGRES_PASSWORD=rundea",
    "-e", "POSTGRES_DB=rundea",
    "-p", "127.0.0.1:55432:5432",
    "postgres:17-alpine",
  ]);
  for (let i = 0; i < 60; i++) {
    try {
      sh("docker", ["exec", destinationName, "pg_isready", "-U", "rundea", "-d", "rundea"]);
      break;
    } catch {
      if (i === 59) throw new Error("destination PostgreSQL did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  sh("bash", [restoreScript, targetEnv, actualBackup, composeFile], {
    RUNDEA_RECOVERY_KEY_FILE: recoveryKeyFile,
    RUNDEA_POSTGRES_CONTAINER: destinationName,
    RUNDEA_DR_ROOT: restoreRoot,
    RUNDEA_RESTORE_SKIP_RUNTIME_START: "1",
  });

  assert.equal(readFileSync(join(restoreRoot, "var/lib/rundea/caddy/Caddyfile"), "utf8"), "rundea.example.test { reverse_proxy 127.0.0.1:4100 }\n");
  assert.equal(readFileSync(join(restoreRoot, "var/lib/rundea/caddy-data/acme-marker"), "utf8"), "durable-acme-state\n");
  assert.match(readFileSync(join(restoreRoot, "etc/systemd/system/rundea-agent.service.d/10-reserved-ingress.conf"), "utf8"), /RUNDEA_RESERVED_INGRESS_ROUTES/);

  const restoredEnv = Object.fromEntries(
    readFileSync(targetEnv, "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
  assert.equal(restoredEnv.RUNDEA_MASTER_KEY, masterKey, "protected master key did not round-trip");

  restoredApi = spawn("npm", ["run", "start", "-w", "@rundea/api"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...restoredEnv,
      DATABASE_URL: "postgres://rundea:rundea@127.0.0.1:55432/rundea",
      RUNDEA_ENVIRONMENT: "development",
      PORT: "4010",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let apiLog = "";
  restoredApi.stdout.on("data", (chunk) => { apiLog += chunk.toString(); });
  restoredApi.stderr.on("data", (chunk) => { apiLog += chunk.toString(); });
  await waitFor("http://127.0.0.1:4010/health");

  const restoredResponse = await fetch(`http://127.0.0.1:4010/v0/services/${service.id}/config/variables`, {
    headers: { authorization: "Bearer " + token },
  });
  assert.equal(restoredResponse.ok, true, apiLog);
  const restoredBody = await restoredResponse.json();
  const restoredPublic = restoredBody.variables.find((row) => row.key === "DR_PUBLIC_VALUE");
  const restoredSecret = restoredBody.variables.find((row) => row.key === "DR_SECRET_VALUE");
  assert.equal(restoredPublic.value, publicValue, "restored master key cannot decrypt service configuration");
  assert.equal(restoredSecret.secret, true);
  assert.equal("value" in restoredSecret, false, "secret plaintext must remain unreadable through read API");

  console.log(JSON.stringify({
    ok: true,
    verified: [
      "encrypted-postgresql-backup",
      "recovery-key-protected-environment-and-master-key",
      "wrong-recovery-key-fails-closed",
      "managed-ingress-host-state-restored",
      "clean-postgresql-restore",
      "restored-master-key-decrypts-service-configuration",
      "secret-read-api-remains-redacted",
    ],
  }, null, 2));
} finally {
  if (restoredApi) restoredApi.kill("SIGTERM");
  try { sh("docker", ["rm", "-f", destinationName]); } catch {}
  rmSync(root, { recursive: true, force: true });
}
