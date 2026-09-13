import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { equalTokenHash, hashToken } from "@rundea/crypto";

type ControlPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type AgentArchitecture = "amd64" | "arm64";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const permanentTokenPattern = /^[a-f0-9]{64}$/;
const agentBundleDir = process.env.RUNDEA_AGENT_BUNDLE_DIR?.trim() || "/app/agent-release";
const installerPath = process.env.RUNDEA_AGENT_INSTALLER_PATH?.trim() || "/app/infra/agent/install.sh";

function bearer(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7).trim() || null;
}

function validNodeId(value: string): boolean {
  return uuidPattern.test(value);
}

function architecture(value: string): AgentArchitecture | null {
  return value === "amd64" || value === "arm64" ? value : null;
}

async function nodeCredentialAccepted(pool: Pool, nodeId: string, token: string | null): Promise<boolean> {
  if (!validNodeId(nodeId) || !token) return false;
  const result = await pool.query("SELECT token_hash FROM nodes WHERE id=$1", [nodeId]);
  return result.rowCount === 1 && equalTokenHash(result.rows[0].token_hash, hashToken(token));
}

async function requireNodeCredential(pool: Pool, request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const nodeHeader = request.headers["x-rundea-node-id"];
  const nodeId = Array.isArray(nodeHeader) ? nodeHeader[0] : nodeHeader;
  const token = bearer(request.headers.authorization);
  if (!nodeId || !(await nodeCredentialAccepted(pool, nodeId, token))) {
    await reply.code(401).send({ error: "invalid node credentials" });
    return null;
  }
  return nodeId;
}

async function bundledAgent(arch: AgentArchitecture): Promise<Buffer> {
  return await readFile(`${agentBundleDir}/rundea-agent-linux-${arch}`);
}

export function registerNodeBootstrapRoutes(
  app: FastifyInstance,
  pool: Pool,
  requireControl: ControlPreHandler,
): void {
  // The installer contains no credential. It is intentionally public so a new
  // host needs only its one-time node token, never a GitHub/PAT credential.
  app.get("/v0/agent/install.sh", async (_request, reply) => {
    try {
      const script = await readFile(installerPath, "utf8");
      return reply
        .header("Cache-Control", "no-store")
        .type("text/x-shellscript; charset=utf-8")
        .send(script);
    } catch {
      return reply.code(503).send({ error: "agent installer is unavailable" });
    }
  });

  app.get<{ Params: { arch: string } }>("/v0/agent/releases/:arch/sha256", async (request, reply) => {
    if (!(await requireNodeCredential(pool, request, reply))) return;
    const arch = architecture(request.params.arch);
    if (!arch) return reply.code(404).send({ error: "unsupported agent architecture" });
    try {
      const binary = await bundledAgent(arch);
      const digest = createHash("sha256").update(binary).digest("hex");
      return reply.header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(`${digest}\n`);
    } catch {
      return reply.code(503).send({ error: "agent release is unavailable" });
    }
  });

  app.get<{ Params: { arch: string } }>("/v0/agent/releases/:arch", async (request, reply) => {
    if (!(await requireNodeCredential(pool, request, reply))) return;
    const arch = architecture(request.params.arch);
    if (!arch) return reply.code(404).send({ error: "unsupported agent architecture" });
    try {
      const binary = await bundledAgent(arch);
      return reply
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename=\"rundea-agent-linux-${arch}\"`)
        .type("application/octet-stream")
        .send(binary);
    } catch {
      return reply.code(503).send({ error: "agent release is unavailable" });
    }
  });

  app.post<{ Params: { id: string }; Body: { agentToken?: string } }>(
    "/v0/nodes/:id/bootstrap/exchange",
    async (request, reply) => {
      const nodeId = request.params.id;
      const bootstrapToken = bearer(request.headers.authorization);
      const agentToken = request.body?.agentToken?.trim().toLowerCase() ?? "";
      if (!validNodeId(nodeId) || !bootstrapToken || !permanentTokenPattern.test(agentToken)) {
        return reply.code(400).send({ error: "invalid bootstrap exchange" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const current = await client.query("SELECT token_hash FROM nodes WHERE id=$1 FOR UPDATE", [nodeId]);
        if (current.rowCount !== 1 || !equalTokenHash(current.rows[0].token_hash, hashToken(bootstrapToken))) {
          await client.query("ROLLBACK");
          return reply.code(401).send({ error: "invalid or already-consumed bootstrap credential" });
        }
        await client.query("UPDATE nodes SET token_hash=$2 WHERE id=$1", [nodeId, hashToken(agentToken)]);
        await client.query("COMMIT");
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK");
        request.log.error(error, "node bootstrap exchange failed");
        return reply.code(500).send({ error: "bootstrap exchange failed" });
      } finally {
        client.release();
      }
    },
  );

  app.get<{ Params: { id: string } }>("/v0/nodes/:id/self/status", async (request, reply) => {
    const token = bearer(request.headers.authorization);
    if (!(await nodeCredentialAccepted(pool, request.params.id, token))) {
      return reply.code(401).send({ error: "invalid node credentials" });
    }
    const result = await pool.query("SELECT status FROM nodes WHERE id=$1", [request.params.id]);
    if (result.rowCount !== 1) return reply.code(404).send({ error: "node not found" });
    return reply.header("Cache-Control", "no-store").type("text/plain; charset=utf-8").send(String(result.rows[0].status));
  });

  // Browser/admin clients can ask the Control Plane for the canonical public
  // origin used when rendering a bootstrap command. No secret is returned.
  app.get("/v0/node-bootstrap/config", { preHandler: requireControl }, async () => ({
    controlPlaneUrl: process.env.RUNDEA_PUBLIC_CONTROL_PLANE_URL ?? null,
    installerPath: "/v0/agent/install.sh",
  }));
}
