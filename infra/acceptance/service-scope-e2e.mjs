import assert from "node:assert/strict";

const api = process.env.RUNDEA_ACCEPTANCE_API_URL ?? "http://127.0.0.1:4000";
const token = process.env.RUNDEA_CONTROL_TOKEN;
if (!token) throw new Error("RUNDEA_CONTROL_TOKEN is required");

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

async function request(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return body;
}

const suffix = Date.now().toString(36);
const workspace = await request("/v0/workspaces", {
  method: "POST",
  body: JSON.stringify({ slug: `dogfood-${suffix}`, name: `Dogfood ${suffix}` }),
});

const projectA = await request(`/v0/workspaces/${workspace.id}/projects`, {
  method: "POST",
  body: JSON.stringify({ slug: `alpha-${suffix}`, name: "Alpha" }),
});
const projectB = await request(`/v0/workspaces/${workspace.id}/projects`, {
  method: "POST",
  body: JSON.stringify({ slug: `bravo-${suffix}`, name: "Bravo" }),
});

const serviceA = await request(`/v0/projects/${projectA.id}/services`, {
  method: "POST",
  body: JSON.stringify({ slug: "api", name: "api" }),
});
const serviceB = await request(`/v0/projects/${projectB.id}/services`, {
  method: "POST",
  body: JSON.stringify({ slug: "api", name: "api" }),
});

assert.notEqual(serviceA.id, serviceB.id, "same human service name must still have different stable identities");

await request(`/v0/services/${serviceA.id}/config/variables`, {
  method: "PUT",
  body: JSON.stringify({ variables: [{ key: "PROJECT_MARKER", value: "alpha-value", secret: false }] }),
});
await request(`/v0/services/${serviceB.id}/config/variables`, {
  method: "PUT",
  body: JSON.stringify({ variables: [{ key: "PROJECT_MARKER", value: "bravo-value", secret: false }] }),
});

const variablesA = await request(`/v0/services/${serviceA.id}/config/variables`);
const variablesB = await request(`/v0/services/${serviceB.id}/config/variables`);

assert.deepEqual(variablesA.variables, [{ key: "PROJECT_MARKER", secret: false, value: "alpha-value" }]);
assert.deepEqual(variablesB.variables, [{ key: "PROJECT_MARKER", secret: false, value: "bravo-value" }]);
assert.equal(variablesA.serviceId, serviceA.id);
assert.equal(variablesB.serviceId, serviceB.id);

const listedA = await request(`/v0/projects/${projectA.id}/services`);
const listedB = await request(`/v0/projects/${projectB.id}/services`);
assert.equal(listedA.services.filter((service) => service.name === "api").length, 1);
assert.equal(listedB.services.filter((service) => service.name === "api").length, 1);

console.log(JSON.stringify({
  ok: true,
  workspaceId: workspace.id,
  projectA: projectA.id,
  projectB: projectB.id,
  serviceA: serviceA.id,
  serviceB: serviceB.id,
}));
