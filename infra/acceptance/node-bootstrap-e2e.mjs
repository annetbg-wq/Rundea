import { randomBytes } from "node:crypto";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const controlToken = process.env.RUNDEA_CONTROL_TOKEN;
if (!controlToken) throw new Error("RUNDEA_CONTROL_TOKEN is required");

async function json(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

const createdResponse = await fetch(`${api}/v0/nodes`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${controlToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ name: `bootstrap-acceptance-${process.pid}` }),
});
const created = await json(createdResponse);
if (createdResponse.status !== 201 || !created?.id || !created?.token) {
  throw new Error(`node creation failed: ${createdResponse.status} ${JSON.stringify(created)}`);
}

const permanentToken = randomBytes(32).toString("hex");
const exchangeResponse = await fetch(`${api}/v0/nodes/${encodeURIComponent(created.id)}/bootstrap/exchange`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ agentToken: permanentToken }),
});
if (exchangeResponse.status !== 204) {
  throw new Error(`bootstrap exchange failed: ${exchangeResponse.status} ${await exchangeResponse.text()}`);
}

const replayResponse = await fetch(`${api}/v0/nodes/${encodeURIComponent(created.id)}/bootstrap/exchange`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${created.token}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ agentToken: randomBytes(32).toString("hex") }),
});
if (replayResponse.status !== 401) {
  throw new Error(`consumed bootstrap credential was accepted again: ${replayResponse.status}`);
}

const oldCredentialResponse = await fetch(`${api}/v0/agent/releases/amd64/sha256`, {
  headers: {
    authorization: `Bearer ${created.token}`,
    "x-rundea-node-id": created.id,
  },
});
if (oldCredentialResponse.status !== 401) {
  throw new Error(`old bootstrap credential still authenticates as node: ${oldCredentialResponse.status}`);
}

const permanentCredentialResponse = await fetch(`${api}/v0/agent/releases/amd64/sha256`, {
  headers: {
    authorization: `Bearer ${permanentToken}`,
    "x-rundea-node-id": created.id,
  },
});
if (permanentCredentialResponse.status !== 503) {
  throw new Error(`permanent node credential was not accepted before release-provider check: ${permanentCredentialResponse.status}`);
}

console.log(JSON.stringify({
  ok: true,
  nodeId: created.id,
  verified: [
    "bootstrap-token-accepted-once",
    "bootstrap-token-invalid-after-exchange",
    "permanent-node-credential-activated",
    "agent-release-route-authenticates-permanent-credential",
  ],
}, null, 2));
