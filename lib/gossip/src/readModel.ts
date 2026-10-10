/**
 * Rebuilds named projections from committed ClusterEvents; gossip is not an input.
 *
 *   CommittedEventSource ──▶ syncFrom() ──▶ readCommitted(applied, target)
 *        │                              │
 *        │                  gap / short batch ──▶ READ_MODEL_GAP
 *        ▼                              ▼
 *   applyChecked: event.sequence must equal applied ──▶ each Projection.apply()
 *        │                              │
 *   MembershipProjection / JobStateProjection    status(): lag 0 = healthy,
 *        │                              │    fresh = syncing, else stale
 *        └──▶ snapshot()      rebuild(events) resets then replays from 0
 */
import { ClusterEvent } from "@workspace/opennode-domain";
import { GossipError } from "./errors";

export type ReadModelSyncState = "stale" | "syncing" | "healthy";

export interface ReadModelSyncStatus {
  readonly state: ReadModelSyncState;
  readonly appliedHeight: number;
  readonly targetHeight: number;
  readonly lag: number;
  readonly lastProgressAt: number | null;
}

export const DEFAULT_STALE_AFTER_MS = 30_000;

/** A named projection rebuilt purely from committed ClusterEvents. */
export interface Projection {
  readonly name: string;
  reset(): void;
  apply(event: ClusterEvent): void;
  snapshot(): unknown;
}

/** Source of committed consensus events; the only authoritative input. */
export interface CommittedEventSource {
  committedHeight(): Promise<number>;
  readCommitted(
    fromSequence: number,
    toExclusive: number,
  ): Promise<ClusterEvent[]>;
}

export class ReadModelProjector {
  private applied = 0;
  private lastProgress: number | null = null;
  private readonly staleAfterMs: number;
  private readonly projections: readonly Projection[];

  constructor(
    projections: readonly Projection[],
    options?: { readonly staleAfterMs?: number },
  ) {
    const names = new Set<string>();
    for (const projection of projections) {
      if (
        typeof projection.name !== "string" ||
        projection.name.trim().length === 0
      ) {
        throw new GossipError(
          "INVALID_READ_MODEL_EVENT",
          "Projection names must not be empty.",
        );
      }
      if (names.has(projection.name)) {
        throw new GossipError(
          "INVALID_READ_MODEL_EVENT",
          `Duplicate projection name ${projection.name}.`,
        );
      }
      names.add(projection.name);
    }
    this.projections = Object.freeze([...projections]);
    this.staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs <= 0) {
      throw new GossipError(
        "INVALID_READ_MODEL_EVENT",
        "staleAfterMs must be a positive safe integer.",
      );
    }
  }

  get appliedHeight(): number {
    return this.applied;
  }

  get lastProgressAt(): number | null {
    return this.lastProgress;
  }

  /** Reset all projections and replay committed events from sequence 0. */
  rebuild(events: readonly ClusterEvent[], now: number): void {
    validateNow(now);
    this.resetAll();
    for (const event of events) {
      this.applyChecked(event);
    }
    if (events.length > 0) this.lastProgress = now;
  }

  /** Apply one newly committed event in sequence order. */
  applyCommitted(event: ClusterEvent, now: number): void {
    validateNow(now);
    this.applyChecked(event);
    this.lastProgress = now;
  }

  /** Catch up to the committed height of the source. */
  async syncFrom(
    source: CommittedEventSource,
    now: number,
  ): Promise<ReadModelSyncStatus> {
    validateNow(now);
    const target = await source.committedHeight();
    if (target < this.applied) {
      throw new GossipError(
        "READ_MODEL_GAP",
        `Committed height ${target} is below applied height ${this.applied}; a rebuild is required.`,
      );
    }
    let progressed = false;
    while (this.applied < target) {
      const batch = await source.readCommitted(this.applied, target);
      if (batch.length === 0) {
        throw new GossipError(
          "READ_MODEL_GAP",
          "Committed event source returned no events during catch-up.",
        );
      }
      for (const event of batch) {
        this.applyChecked(event);
        progressed = true;
      }
    }
    if (progressed) this.lastProgress = now;
    return this.status(target, now);
  }

  /** Compute the UI-facing sync state. */
  status(targetHeight: number, now: number): ReadModelSyncStatus {
    validateNow(now);
    if (!Number.isSafeInteger(targetHeight) || targetHeight < 0) {
      throw new GossipError(
        "INVALID_READ_MODEL_EVENT",
        "targetHeight must be a non-negative safe integer.",
      );
    }
    const lag = Math.max(0, targetHeight - this.applied);
    let state: ReadModelSyncState;
    if (lag === 0) {
      state = "healthy";
    } else if (
      this.lastProgress !== null &&
      now - this.lastProgress <= this.staleAfterMs
    ) {
      state = "syncing";
    } else {
      state = "stale";
    }
    return Object.freeze({
      state,
      appliedHeight: this.applied,
      targetHeight,
      lag,
      lastProgressAt: this.lastProgress,
    });
  }

  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const projection of this.projections) {
      out[projection.name] = projection.snapshot();
    }
    return out;
  }

  private resetAll(): void {
    for (const projection of this.projections) {
      projection.reset();
    }
    this.applied = 0;
    this.lastProgress = null;
  }

  private applyChecked(event: ClusterEvent): void {
    if (typeof event !== "object" || event === null) {
      throw new GossipError(
        "INVALID_READ_MODEL_EVENT",
        "A committed ClusterEvent is required.",
      );
    }
    if (event.sequence !== this.applied) {
      throw new GossipError(
        "READ_MODEL_GAP",
        `Expected committed sequence ${this.applied}, got ${event.sequence}.`,
      );
    }
    for (const projection of this.projections) {
      projection.apply(event);
    }
    this.applied += 1;
  }
}

export const MEMBERSHIP_EVENT_KINDS = Object.freeze({
  admitted: "member-admitted",
  evicted: "member-evicted",
  left: "member-left",
});

/** Projects committed membership events into the current member set. */
export class MembershipProjection implements Projection {
  readonly name = "membership";
  private members = new Set<string>();

  reset(): void {
    this.members = new Set<string>();
  }

  apply(event: ClusterEvent): void {
    const nodeId = payloadNodeId(event);
    if (nodeId === undefined) return;
    switch (event.kind) {
      case MEMBERSHIP_EVENT_KINDS.admitted:
        this.members.add(nodeId);
        break;
      case MEMBERSHIP_EVENT_KINDS.evicted:
      case MEMBERSHIP_EVENT_KINDS.left:
        this.members.delete(nodeId);
        break;
      default:
        break;
    }
  }

  snapshot(): { readonly members: readonly string[] } {
    return Object.freeze({
      members: Object.freeze([...this.members].sort()),
    });
  }
}

export const JOB_EVENT_KINDS = Object.freeze({
  created: "job-created",
  stateChanged: "job-state-changed",
});

/** Projects committed job events into job ID -> latest committed state. */
export class JobStateProjection implements Projection {
  readonly name = "jobs";
  private states = new Map<string, string>();

  reset(): void {
    this.states = new Map<string, string>();
  }

  apply(event: ClusterEvent): void {
    const jobId = payloadString(event, "jobId");
    if (jobId === undefined) return;
    switch (event.kind) {
      case JOB_EVENT_KINDS.created:
        this.states.set(jobId, "queued");
        break;
      case JOB_EVENT_KINDS.stateChanged: {
        const state = payloadString(event, "state");
        if (state === undefined) {
          throw new GossipError(
            "INVALID_READ_MODEL_EVENT",
            "job-state-changed events require a payload state string.",
          );
        }
        this.states.set(jobId, state);
        break;
      }
      default:
        break;
    }
  }

  snapshot(): { readonly jobs: Readonly<Record<string, string>> } {
    const jobs: Record<string, string> = {};
    for (const key of [...this.states.keys()].sort()) {
      jobs[key] = this.states.get(key) as string;
    }
    return Object.freeze({ jobs });
  }
}

function payloadNodeId(event: ClusterEvent): string | undefined {
  return payloadString(event, "nodeId");
}

function payloadString(event: ClusterEvent, key: string): string | undefined {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GossipError(
      "INVALID_READ_MODEL_EVENT",
      `Event ${event.eventId} payload ${key} must be a non-empty string.`,
    );
  }
  return value;
}

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new GossipError(
      "INVALID_READ_MODEL_EVENT",
      "now must be a non-negative safe integer.",
    );
  }
}
