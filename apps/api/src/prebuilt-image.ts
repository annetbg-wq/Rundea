export const prebuiltImageCapability = "prebuiltImages" as const;

const fullCommitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export function normalizePrebuiltImageRef(value: unknown): string {
  if (typeof value !== "string") throw new Error("artifactImageRef must be a string");
  const imageRef = value.trim();
  if (!imageRef || imageRef.length > 1024 || /[\s\r\n]/.test(imageRef)) {
    throw new Error("artifactImageRef is invalid");
  }
  const marker = imageRef.lastIndexOf("@");
  if (marker <= 0 || marker === imageRef.length - 1) {
    throw new Error("artifactImageRef must be pinned by immutable @sha256 digest");
  }
  const name = imageRef.slice(0, marker);
  const digest = imageRef.slice(marker + 1);
  if (!name.includes("/") || name.startsWith("/") || name.endsWith("/") || !digestPattern.test(digest)) {
    throw new Error("artifactImageRef must be a registry image pinned by immutable @sha256 digest");
  }
  return `${name}@${digest}`;
}

export function normalizeArtifactSourceCommit(value: unknown): string {
  if (typeof value !== "string") throw new Error("artifactSourceCommitSha must be a string");
  const commit = value.trim().toLowerCase();
  if (!fullCommitPattern.test(commit)) {
    throw new Error("artifactSourceCommitSha must be an exact 40-character Git SHA");
  }
  return commit;
}

export function supportsPrebuiltImages(capabilities: unknown): boolean {
  return Array.isArray(capabilities) && capabilities.includes(prebuiltImageCapability);
}
