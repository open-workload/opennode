import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function requestFingerprint(input: unknown): string {
  return sha256Hex(stableStringify(input));
}

export function logEntryChecksum(parts: {
  runId: string;
  attempt: number;
  stream: string;
  sequence: number;
  message: string;
  createdAt: Date;
}): string {
  return sha256Hex(
    [parts.runId, parts.attempt, parts.stream, parts.sequence, parts.message, parts.createdAt.toISOString()].join("|"),
  );
}
