/**
 * The rule that gossip is advisory only and can never authorize anything.
 *
 *   any gossip-derived value ──▶ asAdvisory(v) ──▶ Advisory<{ trust: "advisory" }>
 *        │                                                │
 *   isAdvisoryCategory / assertGossipCategory              ▼
 *        │  only presence | capacity       denyGossipAuthorization(decision)
 *        │                                               │ always throws
 *        └──▶ never reaches ──▶ job-authorization | membership-change | secret-access
 */
import { GossipError } from "./errors";
import { GossipCategory, GossipMessage } from "./messages";

/** The only categories gossip may ever carry. */
export const ADVISORY_CATEGORIES: readonly GossipCategory[] = Object.freeze([
  "presence",
  "capacity",
]);

/**
 * Safety-critical decisions that gossip must never authorize. These are
 * committed only through the consensus log (signed ClusterEvents).
 */
export type GovernedDecision =
  | "job-authorization"
  | "membership-change"
  | "secret-access";

export const GOVERNED_DECISIONS: readonly GovernedDecision[] = Object.freeze([
  "job-authorization",
  "membership-change",
  "secret-access",
]);

/**
 * Brand for gossip-derived data. Advisory data may drive UI hints and
 * scheduling heuristics, but callers must never pass it to authorization
 * paths for jobs, membership, or secrets.
 */
export interface Advisory<T> {
  readonly trust: "advisory";
  readonly value: T;
}

export function asAdvisory<T>(value: T): Advisory<T> {
  return Object.freeze({ trust: "advisory", value });
}

export function isAdvisoryCategory(
  category: string,
): category is GossipCategory {
  return ADVISORY_CATEGORIES.includes(category as GossipCategory);
}

export function assertGossipCategory(
  category: string,
): asserts category is GossipCategory {
  if (!isAdvisoryCategory(category)) {
    throw new GossipError(
      "GOSSIP_CATEGORY_FORBIDDEN",
      `Gossip may only carry advisory categories (presence, capacity); got ${category}.`,
    );
  }
}

export function assertAdvisoryMessage(message: GossipMessage): void {
  assertGossipCategory(message.category);
}

/**
 * The single, explicit answer to any attempt to turn gossip into an
 * authorization decision: it always throws. There is deliberately no code
 * path from Advisory data to job authorization, membership change, or
 * secret access; those require committed consensus events.
 */
export function denyGossipAuthorization(decision: GovernedDecision): never {
  throw new GossipError(
    "GOSSIP_NOT_AUTHORITATIVE",
    `Gossip data is advisory only and cannot authorize ${decision}; authorization requires committed consensus events.`,
  );
}
