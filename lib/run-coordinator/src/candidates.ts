/**
 * Deterministic rendezvous (highest-random-weight) pick of one worker per attempt.
 *
 *   members ──▶ eligible ──▶ sha256 score ──▶ nodeId
 *              filter       per node        (highest)
 *              by caps
 *
 * Exclusions are not this module's concern: they derive from the capacity
 * view (capacityView.ts), never from a caller-supplied parameter.
 *
 * No eligible node throws NO_ELIGIBLE_WORKER. Selection authorizes nothing:
 * the winner still needs a committed lease with a fencing token.
 */
import { sha256Hex } from "@workspace/sync-engine";
import { RunCoordinatorError } from "./errors";

export interface NodeCapability {
  readonly nodeId: string;
  readonly capabilities: readonly string[];
}

/**
 * Deterministic candidate selection via rendezvous (highest-random-weight)
 * hashing over eligible node IDs. Selection never authorizes execution on
 * its own: the chosen candidate must still obtain a committed lease with a
 * fencing token before any work starts.
 */
export function eligibleCandidates(input: {
  readonly members: readonly string[];
  readonly capabilities: readonly NodeCapability[];
  readonly requiredCapabilities: readonly string[];
}): readonly string[] {
  const byNode = new Map<string, readonly string[]>();
  for (const entry of input.capabilities) {
    byNode.set(entry.nodeId, entry.capabilities);
  }
  const eligible: string[] = [];
  for (const nodeId of input.members) {
    const caps = byNode.get(nodeId);
    if (caps === undefined) continue;
    if (
      input.requiredCapabilities.every((required) => caps.includes(required))
    ) {
      eligible.push(nodeId);
    }
  }
  return Object.freeze(eligible.sort());
}

export function rendezvousScore(
  runId: string,
  attempt: number,
  nodeId: string,
): string {
  return sha256Hex(`${runId}|${attempt}|${nodeId}`);
}

export function selectCandidate(input: {
  readonly runId: string;
  readonly attempt: number;
  readonly members: readonly string[];
  readonly capabilities: readonly NodeCapability[];
  readonly requiredCapabilities: readonly string[];
}): string {
  const eligible = eligibleCandidates(input);
  if (eligible.length === 0) {
    throw new RunCoordinatorError(
      "NO_ELIGIBLE_WORKER",
      "No eligible worker for this run.",
    );
  }
  let best: string | null = null;
  let bestScore = "";
  for (const nodeId of eligible) {
    const score = rendezvousScore(input.runId, input.attempt, nodeId);
    if (best === null || score > bestScore) {
      best = nodeId;
      bestScore = score;
    }
  }
  return best as string;
}
