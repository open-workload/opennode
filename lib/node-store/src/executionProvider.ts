/**
 * ExecutionProvider contract and the built-in diagnostic implementation.
 *
 *   startRun(run) ──▶ createAttempt(starting) ──▶ timer: running ──▶ timer: succeeded
 *         │                    │                       │
 *         │              pending map entry        cancelRun() clears timers
 *         │                    │                       │
 *         └── unrealised run ──┴──▶ cancelled ◀────────┘
 *
 * cancelRun falls back to the store when no timer entry exists (run not started
 * on this process). Real container execution lives in WorkerExecutionProvider.
 */
import type { NodeStore } from "./nodeStore";
import type { WorkloadRun } from "@workspace/db";

export interface ExecutionProvider {
  readonly executionMode: "built_in_diagnostic" | "isolated_worker";
  startRun(run: WorkloadRun, opts: { requestId?: string }): Promise<void>;
  cancelRun(runId: string, opts?: { requestId?: string }): Promise<void>;
}

interface PendingRun {
  attemptId: string;
  attempt: number;
  timers: NodeJS.Timeout[];
  finished: boolean;
  cancelRequested: boolean;
}

export interface FakeExecutionProviderOptions {
  stepDelayMs?: number;
  workerNodeId?: string;
}

export class FakeExecutionProvider implements ExecutionProvider {
  readonly executionMode = "built_in_diagnostic" as const;
  private pending = new Map<string, PendingRun>();

  constructor(
    private readonly store: NodeStore,
    private readonly options: FakeExecutionProviderOptions = {},
  ) {}

  async startRun(run: WorkloadRun, opts: { requestId?: string }): Promise<void> {
    const step = this.options.stepDelayMs ?? 50;
    const workerNodeId = this.options.workerNodeId ?? "local";
    const localNodeId = await this.store.getLocalNodeId();
    const attempt = await this.store.createAttempt(run.id, { status: "starting", workerNodeId: localNodeId, requestId: opts?.requestId });
    const log = (stream: "stdout" | "stderr" | "system", message: string) =>
      void this.store.appendLog({ runId: run.id, attempt: attempt.attempt, stream, message, requestId: opts?.requestId }).catch(() => undefined);
    const entry: PendingRun = { attemptId: attempt.id, attempt: attempt.attempt, timers: [], finished: false, cancelRequested: false };
    this.pending.set(run.id, entry);

    void this.store.appendLog({ runId: run.id, attempt: attempt.attempt, stream: "system", message: `Run accepted; providerRunId=${attempt.providerRunId}`, requestId: opts?.requestId }).catch(() => undefined);

    entry.timers.push(
      setTimeout(() => {
        void (async () => {
          if (entry.cancelRequested || entry.finished) return;
          await this.store.transitionAttempt(attempt.id, "running");
          await this.store.setRunRunning(run.id, localNodeId, opts?.requestId);
          log("system", "Diagnostic running");
          log("stdout", "health-check: starting");
        })().catch(() => undefined);
      }, step),
    );

    entry.timers.push(
      setTimeout(() => {
        if (entry.cancelRequested || entry.finished) return;
        log("stdout", "health-check: ok");
      }, step * 2),
    );

    entry.timers.push(
      setTimeout(() => {
        void (async () => {
          if (entry.cancelRequested || entry.finished) return;
          entry.finished = true;
          await this.store.transitionAttempt(attempt.id, "succeeded");
          await this.store.markRunTerminal(run.id, "succeeded", null, opts?.requestId);
          log("system", "Run completed: succeeded");
        })().catch(() => undefined);
      }, step * 4),
    );
  }

  async cancelRun(runId: string, opts?: { requestId?: string }): Promise<void> {
    const entry = this.pending.get(runId);
    if (!entry) {
      const run = await this.store.getRun(runId);
      if (!run) return;
      if (run.status === "queued" || run.status === "starting" || run.status === "running" || run.status === "cancel_requested") {
        await this.store.markRunTerminal(runId, "cancelled", "cancelled before provider started", opts?.requestId);
      }
      return;
    }
    entry.cancelRequested = true;
    for (const t of entry.timers) clearTimeout(t);
    if (!entry.finished) {
      await this.store.transitionAttempt(entry.attemptId, "cancelled", { errorReason: "cancel requested", requestId: opts?.requestId });
      await this.store.markRunTerminal(runId, "cancelled", "cancel requested", opts?.requestId);
      await this.store.appendLog({ runId, attempt: entry.attempt, stream: "system", message: "Run cancelled", requestId: opts?.requestId });
      entry.finished = true;
    }
    this.pending.delete(runId);
  }
}
