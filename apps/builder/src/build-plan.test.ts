import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { node24BaseImage, prepareBuildDockerfile } from "./build-plan";

test("builder prefers existing Dockerfile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rundea-builder-plan-"));
  try {
    await writeFile(join(dir, "Dockerfile"), "FROM scratch\n");
    assert.deepEqual(await prepareBuildDockerfile(dir, null), { dockerfile:"Dockerfile", plan:"dockerfile:auto" });
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test("builder generates pinned Node plan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rundea-builder-plan-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({scripts:{build:"vite build",start:"node server.js"}}));
    await writeFile(join(dir, "package-lock.json"), "{}");
    const result = await prepareBuildDockerfile(dir, null);
    assert.equal(result.plan, "nodejs-24.20.0:auto");
    const text = await readFile(join(dir,result.dockerfile),"utf8");
    assert.equal(text.includes("FROM " + node24BaseImage), true);
    assert.equal(text.includes("npm ci --no-audit --no-fund"), true);
    assert.equal(text.includes("RUN npm run build"), true);
    assert.equal(text.includes('CMD ["npm","start"]'), true);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test("builder Node plan requires scripts.start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rundea-builder-plan-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({scripts:{build:"echo build"}}));
    await assert.rejects(() => prepareBuildDockerfile(dir,null), /scripts.start/);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
