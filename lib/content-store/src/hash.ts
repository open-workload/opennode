import { createHash } from "node:crypto";

export function sha256Hex(input: Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof input === "string") {
    hash.update(input, "utf8");
  } else {
    hash.update(input);
  }
  return hash.digest("hex");
}

export function sha256Bytes(input: Uint8Array | string): Uint8Array {
  const hash = createHash("sha256");
  if (typeof input === "string") {
    hash.update(input, "utf8");
  } else {
    hash.update(input);
  }
  return new Uint8Array(hash.digest());
}

export function contentAddress(data: Uint8Array): string {
  return sha256Hex(data);
}

export function verifyChecksum(data: Uint8Array, expectedChecksum: string): boolean {
  const actual = contentAddress(data);
  return timingSafeEqualHex(actual, expectedChecksum);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.every((byte, i) => byte === bb[i]);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}