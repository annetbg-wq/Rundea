import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { retainedRollbackTargetIds, rollbackTargetIsRetained, runtimeArtifactRetentionLimit } from "./runtime-retention";

const ids = ["d4", "d3", "d2", "d1"];

function fakePool() {
  return {
    query: async (text: string, params?: unknown[]) => {
      assert.match(text, /status IN \('READY','ROLLED_BACK'\)/);
      assert.match(text, /ORDER BY created_at DESC,id DESC/);
      assert.match(text, /LIMIT \$3/);
      assert.deepEqual(params, ["api", "node-1", runtimeArtifactRetentionLimit]);
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    },
  } as unknown as Pool;
}

test("retention query returns newest current plus rollback revisions", async () => {
  assert.equal(runtimeArtifactRetentionLimit, 4);
  assert.deepEqual(await retainedRollbackTargetIds(fakePool(), "api", "node-1"), ids);
});

test("rollback target must be inside retained window", async () => {
  assert.equal(await rollbackTargetIsRetained(fakePool(), "api", "node-1", "d2"), true);
  assert.equal(await rollbackTargetIsRetained(fakePool(), "api", "node-1", "d0"), false);
});
