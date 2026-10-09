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
  readonly excludedNodeIds?: readonly string[];
}): readonly string[] {
  const byNode = new Map<string, readonly string[]>();
  for (const entry of input.capabilities) {
    byNode.set(entry.nodeId, entry.capabilities);
  }
  const excluded = new Set(input.excludedNodeIds ?? []);
  const eligible: string[] = [];
  for (const nodeId of input.members) {
    if (excluded.has(nodeId)) continue;
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
  readonly excludedNodeIds?: readonly string[];
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
