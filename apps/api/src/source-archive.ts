export const maxCompressedSourceArchiveBytes = 64 * 1024 * 1024;

export async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid source archive size limit");
  if (!response.body) throw new Error("source archive response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("source archive size limit exceeded").catch(() => undefined);
        throw new Error("source archive exceeds v0 compressed size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("source archive is empty");
  return Buffer.concat(chunks, total);
}

export async function readSourceArchiveResponse(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredLength = Number(declared);
    if (Number.isFinite(declaredLength) && declaredLength > maxCompressedSourceArchiveBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("source archive exceeds v0 compressed size limit");
    }
  }
  return await readResponseBodyWithLimit(response, maxCompressedSourceArchiveBytes);
}
