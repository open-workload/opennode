import { DomainError } from "./errors";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyRecord {
  readonly actorId: string;
  readonly key: string;
  readonly payloadHash: string;
  readonly runId: string;
  readonly expiresAt: Date;
}

export interface IdempotentSubmission {
  readonly runId: string;
  readonly record: IdempotencyRecord;
}

export interface IdempotencyConflict {
  readonly code: "IDEMPOTENCY_CONFLICT";
  readonly message: string;
  readonly existingRunId: string;
  readonly existingActorId: string;
}

export function computePayloadHash(payload: unknown): string {
  const canonical = canonicalJson(payload);
  if (canonical === undefined) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Submission payload must be JSON-serializable.",
    );
  }
  return hashString(canonical);
}

export function createSubmissionRecord(
  actorId: string,
  key: string,
  payload: unknown,
): IdempotencyRecord {
  validateKey(key);
  validateActorId(actorId);
  const payloadHash = computePayloadHash(payload);
  return Object.freeze({
    actorId,
    key,
    payloadHash,
    runId: `run-${hashString(`${actorId}:${key}:${payloadHash}`)}`,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
  });
}

export function resolveIdempotentSubmission(
  actorId: string,
  key: string,
  payload: unknown,
  existing: IdempotencyRecord | undefined,
): IdempotentSubmission {
  validateKey(key);
  validateActorId(actorId);
  if (existing === undefined) {
    const record = createSubmissionRecord(actorId, key, payload);
    return Object.freeze({ runId: record.runId, record });
  }
  validateExisting(existing);
  if (existing.actorId !== actorId) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "Existing idempotency record belongs to a different actor.",
    );
  }
  if (existing.key !== key) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "Existing idempotency record belongs to a different key.",
    );
  }
  if (existing.expiresAt <= new Date()) {
    throw new DomainError(
      "IDEMPOTENCY_EXPIRED",
      "Idempotency key has expired.",
    );
  }
  const payloadHash = computePayloadHash(payload);
  if (existing.payloadHash !== payloadHash) {
    const conflict: IdempotencyConflict = {
      code: "IDEMPOTENCY_CONFLICT",
      message: "Idempotency key was already used with a different payload.",
      existingRunId: existing.runId,
      existingActorId: existing.actorId,
    };
    throw new DomainError("IDEMPOTENCY_CONFLICT", JSON.stringify(conflict));
  }
  return Object.freeze({ runId: existing.runId, record: existing });
}

export function extractIdempotencyKey(headers: Record<string, string | undefined>): string | null {
  const key = headers[IDEMPOTENCY_HEADER.toLowerCase()] ?? headers[IDEMPOTENCY_HEADER];
  const trimmed = key?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key must not be empty.",
    );
  }
}

function validateActorId(actorId: string): void {
  if (typeof actorId !== "string" || actorId.trim().length === 0) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Actor ID must not be empty.",
    );
  }
}

function validateExisting(record: IdempotencyRecord): void {
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.actorId !== "string" ||
    typeof record.key !== "string" ||
    typeof record.payloadHash !== "string" ||
    typeof record.runId !== "string" ||
    record.runId.trim().length === 0 ||
    !(record.expiresAt instanceof Date) ||
    Number.isNaN(record.expiresAt.getTime())
  ) {
    throw new DomainError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency record is malformed.",
    );
  }
}

function canonicalJson(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : undefined;
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (const item of value) {
          const rendered = canonicalJson(item);
          if (rendered === undefined) return undefined;
          items.push(rendered);
        }
        return `[${items.join(",")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && typeof v !== "function")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const rendered: string[] = [];
      for (const [k, v] of entries) {
        const r = canonicalJson(v);
        if (r === undefined) return undefined;
        rendered.push(`${JSON.stringify(k)}:${r}`);
      }
      return `{${rendered.join(",")}}`;
    }
    default:
      return undefined;
  }
}

function hashString(input: string): string {
  let hash = 0x811c9dc5 >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}