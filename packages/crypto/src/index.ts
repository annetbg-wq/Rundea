import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type EncryptedValue = {
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
};

const serviceVariableAad = Buffer.from("rundea:service-variable:v1", "utf8");
const providerCredentialAad = Buffer.from("rundea:provider-credential:v1", "utf8");
const managedRedisCredentialAad = Buffer.from("rundea:managed-redis-credential:v1", "utf8");

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function equalTokenHash(leftHex: string, rightHex: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(leftHex) || !/^[a-f0-9]{64}$/i.test(rightHex)) return false;
  return timingSafeEqual(Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex"));
}

export function parseMasterKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("RUNDEA_MASTER_KEY must be base64");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("RUNDEA_MASTER_KEY must decode to exactly 32 bytes");
  return key;
}

function encryptWithAad(value: string, key: Buffer, aad: Buffer): EncryptedValue {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptWithAad(value: EncryptedValue, key: Buffer, aad: Buffer): string {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  if (value.version !== 1) throw new Error("unsupported encrypted value version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptValue(value: string, key: Buffer): EncryptedValue {
  return encryptWithAad(value, key, serviceVariableAad);
}

export function decryptValue(value: EncryptedValue, key: Buffer): string {
  return decryptWithAad(value, key, serviceVariableAad);
}

export function encryptProviderCredential(value: string, key: Buffer): EncryptedValue {
  return encryptWithAad(value, key, providerCredentialAad);
}

export function decryptProviderCredential(value: EncryptedValue, key: Buffer): string {
  return decryptWithAad(value, key, providerCredentialAad);
}

export function encryptManagedRedisCredential(value: string, key: Buffer): EncryptedValue {
  return encryptWithAad(value, key, managedRedisCredentialAad);
}

export function decryptManagedRedisCredential(value: EncryptedValue, key: Buffer): string {
  return decryptWithAad(value, key, managedRedisCredentialAad);
}
