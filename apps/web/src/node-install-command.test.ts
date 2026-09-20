import assert from "node:assert/strict";
import test from "node:test";
import { createNodeInstallCommand } from "./node-install-command";

const bootstrap = {
  id: "22222222-2222-4222-8222-222222222222",
  token: "one-time-token",
};

test("builds the complete one-command HTTPS installer used by Nodes UI", () => {
  const command = createNodeInstallCommand("https://rundea.example", bootstrap);
  assert.ok(command);
  assert.match(command, /https:\/\/rundea\.example\/v0\/install\.sh/);
  assert.match(command, /RUNDEA_CONTROL_PLANE_URL='https:\/\/rundea\.example'/);
  assert.match(command, /RUNDEA_NODE_ID='22222222-2222-4222-8222-222222222222'/);
  assert.match(command, /RUNDEA_NODE_TOKEN='one-time-token'/);
  assert.match(command, /sudo env/);
});

test("refuses non-HTTPS or non-origin values", () => {
  assert.equal(createNodeInstallCommand("http://rundea.example", bootstrap), null);
  assert.equal(createNodeInstallCommand("https://user@rundea.example", bootstrap), null);
  assert.equal(createNodeInstallCommand("https://rundea.example/path", bootstrap), null);
  assert.equal(createNodeInstallCommand("https://rundea.example?x=1", bootstrap), null);
});
