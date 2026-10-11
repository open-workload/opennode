/**
 * Single authoritative capacity view for scheduling (RUN-18).
 *
 *   CapacityView                      deriveExcludedNodeIds      string[]
 *   ├ committedMemberIds ──┐
 *   ├ quarantined ─────────┼──▶ union all sets, dedupe ──▶ excluded ids
 *   ├ draining ────────────┤    (pure; no I/O, no clock)
 *   └ unhealthy ───────────┘
 *
 * The coordinator derives exclusions from this view; candidates never take
 * an exclusions parameter from callers.
 */
export interface CapacityView {
  readonly committedMemberIds: ReadonlySet<string>;
  readonly quarantined: ReadonlySet<string>;
  readonly draining: ReadonlySet<string>;
  readonly unhealthy: ReadonlySet<string>;
}

/**
 * Union every set in the view into one deduplicated list of excluded node
 * IDs. Pure: same view in, same list out, no side effects.
 */
export function deriveExcludedNodeIds(view: CapacityView): string[] {
  const excluded = new Set<string>();
  for (const nodeId of view.committedMemberIds) excluded.add(nodeId);
  for (const nodeId of view.quarantined) excluded.add(nodeId);
  for (const nodeId of view.draining) excluded.add(nodeId);
  for (const nodeId of view.unhealthy) excluded.add(nodeId);
  return [...excluded];
}
