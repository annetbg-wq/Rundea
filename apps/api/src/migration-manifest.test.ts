import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { migrationFiles } from "./migration-manifest";

test("migration manifest includes every SQL migration exactly once and in numeric order", async () => {
  const diskFiles = (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  assert.deepEqual([...migrationFiles], diskFiles);
  assert.equal(new Set(migrationFiles).size, migrationFiles.length);

  const prefixes = migrationFiles.map((name) => Number(name.slice(0, 3)));
  assert.deepEqual(prefixes, prefixes.map((_, index) => index + 1));
});
