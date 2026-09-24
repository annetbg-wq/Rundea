import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export const node24BaseImage = "node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function prepareBuildDockerfile(
  sourceDir: string,
  requested: string | null,
): Promise<{ dockerfile: string; plan: string }> {
  if (requested) {
    if (!(await exists(join(sourceDir, requested)))) throw new Error(`requested Dockerfile "${requested}" does not exist`);
    return { dockerfile: requested, plan: "dockerfile" };
  }

  if (await exists(join(sourceDir, "Dockerfile"))) {
    return { dockerfile: "Dockerfile", plan: "dockerfile:auto" };
  }

  const packagePath = join(sourceDir, "package.json");
  if (!(await exists(packagePath))) throw new Error("no Dockerfile or supported package.json build plan found");

  let manifest: { scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`parse package.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!manifest.scripts?.start) throw new Error("Node.js auto build requires package.json scripts.start");
  const install = (await exists(join(sourceDir, "package-lock.json")))
    ? "npm ci --no-audit --no-fund"
    : "npm install --no-audit --no-fund";
  const build = manifest.scripts.build ? "RUN npm run build\n" : "";
  const generated = `FROM ${node24BaseImage}
WORKDIR /app
COPY package*.json ./
RUN ${install}
COPY . .
${build}ENV NODE_ENV=production
CMD ["npm","start"]
`;

  const dockerfile = ".rundea.generated.Dockerfile";
  await writeFile(join(sourceDir, dockerfile), generated, { mode: 0o600 });
  return { dockerfile, plan: "nodejs-24.20.0:auto" };
}
