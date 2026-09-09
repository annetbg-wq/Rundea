import { randomBytes } from "node:crypto";

export async function activateNodeCredential(api, nodeId, bootstrapToken) {
  if (!nodeId || !bootstrapToken) throw new Error("node id and bootstrap token are required");
  const permanentToken = randomBytes(32).toString("hex");
  const response = await fetch(`${api}/v0/nodes/${encodeURIComponent(nodeId)}/bootstrap/exchange`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bootstrapToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ agentToken: permanentToken }),
  });
  if (response.status !== 204) {
    throw new Error(`bootstrap exchange for acceptance node failed: ${response.status} ${await response.text()}`);
  }
  return permanentToken;
}
