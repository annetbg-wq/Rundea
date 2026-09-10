import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OperationActorContext, type OAuthOperationActor } from "./operation-actor";

function actor(subject: string): OAuthOperationActor {
  return {
    authenticationMethod: "OAUTH",
    issuer: "https://auth.rundea.test",
    subject,
    scopes: ["rundea:mcp:diagnostics:read"],
  };
}

test("request-local operation actors stay isolated across concurrent async work", async () => {
  const context = new OperationActorContext();
  const first = actor("user-first");
  const second = actor("user-second");

  const [seenFirst, seenSecond] = await Promise.all([
    context.run(first, async () => {
      await delay(20);
      return context.current();
    }),
    context.run(second, async () => {
      await delay(5);
      return context.current();
    }),
  ]);

  assert.deepEqual(seenFirst, first);
  assert.deepEqual(seenSecond, second);
  assert.equal(context.current(), undefined);
});
