/**
 * Coordinator-backed AttemptLifecycle port: turns the execution provider's
 * observe/renew callbacks into committed coordinator events.
 *
 *   observe(runId, status)  ─┐
 *   renewLease(runId, opts)  ┴─▶ getCoordinator ─▶ getState ─▶ last attempt
 *                                   │ none / lease fields null
 *                                   └─▶ throw RunCoordinatorError
 *                                         (provider swallows non-terminal)
 *
 *   attempt ─▶ observeAttempt ─▶ committed log ─▶ node-store mirror
 *   leaseId ─▶ renewLease     ─▶ expiry + fencing token refreshed
 *
 *   renewEveryMs = LEASE_RENEWAL_INTERVAL_MS (the provider's renewal cadence).
 */
import {
  LEASE_RENEWAL_INTERVAL_MS,
  RunCoordinatorError,
  type RunCoordinator,
} from "@workspace/run-coordinator";
import type { AttemptLifecycle } from "@workspace/worker-runtime";

interface BoundAttempt {
  readonly coordinator: RunCoordinator;
  readonly attempt: number;
  readonly leaseId: string;
  readonly workerNodeId: string;
  readonly fencingToken: number;
}

async function resolveBoundAttempt(
  getCoordinator: () => Promise<RunCoordinator>,
  runId: string,
): Promise<BoundAttempt> {
  const coordinator = await getCoordinator();
  const state = await coordinator.getState();
  const attempt = state.attempts.filter((a) => a.runId === runId).at(-1);
  if (attempt === undefined) {
    throw new RunCoordinatorError("ATTEMPT_NOT_FOUND", `No attempt recorded for run ${runId}.`);
  }
  if (attempt.workerNodeId === null || attempt.fencingToken === null || attempt.leaseId === null) {
    throw new RunCoordinatorError(
      "ATTEMPT_NOT_FOUND",
      `Attempt ${attempt.attempt} for run ${runId} has no committed lease binding.`,
    );
  }
  return {
    coordinator,
    attempt: attempt.attempt,
    leaseId: attempt.leaseId,
    workerNodeId: attempt.workerNodeId,
    fencingToken: attempt.fencingToken,
  };
}

export function createAttemptLifecycle(
  getCoordinator: () => Promise<RunCoordinator>,
): AttemptLifecycle {
  return {
    renewEveryMs: LEASE_RENEWAL_INTERVAL_MS,
    async observe({ runId, status, note, requestId }) {
      const bound = await resolveBoundAttempt(getCoordinator, runId);
      await bound.coordinator.observeAttempt({
        report: {
          runId,
          attempt: bound.attempt,
          workerNodeId: bound.workerNodeId,
          status,
          reportedAt: Date.now(),
          fencingToken: bound.fencingToken,
          ...(note !== undefined ? { note } : {}),
        },
        correlationId: requestId ?? "execution-provider",
        now: Date.now(),
      });
    },
    async renewLease(runId, opts) {
      const bound = await resolveBoundAttempt(getCoordinator, runId);
      await bound.coordinator.renewLease({
        request: {
          leaseId: bound.leaseId,
          runId,
          attempt: bound.attempt,
          workerNodeId: bound.workerNodeId,
          fencingToken: bound.fencingToken,
          requestedAt: Date.now(),
        },
        correlationId: opts?.requestId ?? "execution-provider",
        now: Date.now(),
      });
    },
  };
}
