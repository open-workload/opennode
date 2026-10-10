/**
 * Deterministic run and attempt IDs, so the same submission deduplicates.
 *
 *   cluster+actor+key+payloadHash ──▶ sha256 ──▶ run-<32hex>
 *   runId + attempt ordinal       ──▶ sha256 ──▶ attempt-<16hex>
 *
 *   Guards, both throwing INVALID_SUBMISSION: every string above must be
 *   non-empty, and the attempt ordinal a positive safe integer. Also
 *   exports computeRunPayloadHash (canonical spec JSON ──▶ sha256).
 */
import { createHash } from "node:crypto";
import { sha256Hex, stableStringify } from "@workspace/sync-engine";
import { RunCoordinatorError } from "./errors";

export interface RunIdentityInput {
  readonly clusterId: string;
  readonly actorId: string;
  readonly clientKey: string;
  readonly payloadHash: string;
}

/**
 * Deterministic run identity: SHA-256(clusterId + actorId + clientKey + payloadHash)
 * so duplicate submissions through different peers deduplicate.
 */
export function deriveRunId(input: RunIdentityInput): string {
  for (const [label, value] of [
    ["clusterId", input.clusterId],
    ["actorId", input.actorId],
    ["clientKey", input.clientKey],
    ["payloadHash", input.payloadHash],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RunCoordinatorError(
        "INVALID_SUBMISSION",
        `${label} must be a non-empty string.`,
      );
    }
  }
  return `run-${sha256Hex(
    stableStringify({
      clusterId: input.clusterId,
      actorId: input.actorId,
      clientKey: input.clientKey,
      payloadHash: input.payloadHash,
    }),
  ).slice(0, 32)}`;
}

export function computeRunPayloadHash(spec: unknown): string {
  const canonical = stableStringify(spec);
  if (typeof canonical !== "string" || canonical.length === 0) {
    throw new RunCoordinatorError(
      "INVALID_SUBMISSION",
      "Run spec must be JSON-serializable.",
    );
  }
  return sha256Hex(canonical);
}

/** Attempt ID tied to the deterministic run ID and ordinal. */
export function deriveAttemptId(runId: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RunCoordinatorError(
      "INVALID_SUBMISSION",
      "Attempt ordinal must be a positive safe integer.",
    );
  }
  return `attempt-${createHash("sha256")
    .update(`${runId}|${attempt}`, "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}
