/**
 * STUB backend (kind = "isolated_process_stub"). No sandbox: two setTimeouts
 * stand in for spawning and exiting; cleanup only deletes a scratch dir.
 *
 *   start(spec) ─▶ mkdtemp scratch + temp-creds.json ─▶ starting
 *                                                          │
 *                              setTimeout(step) ────────────┤
 *                              setTimeout(4x step) ─────────┤
 *                                                          ▼
 *                                          running ─▶ finished (succeeded | failed)
 *
 *   cancel ─▶ finished (cancelled)    wait ─▶ WorkerResult
 *   cleanup ─▶ rm scratch; cgroup/nft/image flags are always false
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupReport, TeardownReason, WorkerBackend, WorkerHandle, WorkerLifecycleState, WorkerResult } from "./backend";
import type { WorkerSpec } from "./spec";

export interface IsolatedProcessBackendOptions {
  readonly stepDelayMs?: number;
  readonly scratchRoot?: string;
  readonly simulateOutputBytes?: number;
  readonly shouldFail?: boolean;
}

interface Pending {
  state: WorkerLifecycleState;
  timers: NodeJS.Timeout[];
  finished: boolean;
  cancelled: boolean;
  scratchDir: string;
  tempCredsPath: string;
  resolveWait?: (result: WorkerResult) => void;
}

export class IsolatedProcessBackend implements WorkerBackend {
  readonly kind = "isolated_process_stub";
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly options: IsolatedProcessBackendOptions = {}) {}

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    const step = this.options.stepDelayMs ?? 20;
    const root = this.options.scratchRoot ?? tmpdir();
    const scratchDir = await mkdtemp(join(root, "worker-runtime-"));
    await mkdir(join(scratchDir, "work"), { recursive: true }).catch(() => undefined);
    const tempCredsPath = join(scratchDir, "temp-creds.json");
    await writeFile(tempCredsPath, JSON.stringify({ runId: spec.runId, refs: spec.env.entries.filter((e) => e.source === "secret_ref").map((e) => e.secretRefId) }), { mode: 0o600 });

    const entry: Pending = {
      state: "starting",
      timers: [],
      finished: false,
      cancelled: false,
      scratchDir,
      tempCredsPath,
      resolveWait: undefined,
    };
    const key = `${spec.runId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.pending.set(key, entry);

    const wait = new Promise<WorkerResult>((resolve) => {
      entry.resolveWait = resolve;
    });

    entry.timers.push(
      setTimeout(() => {
        if (entry.cancelled || entry.finished) return;
        entry.state = "running";
      }, step),
    );

    entry.timers.push(
      setTimeout(() => {
        if (entry.cancelled || entry.finished) return;
        entry.finished = true;
        entry.state = "finished";
        const status = this.options.shouldFail ? "failed" : "succeeded";
        entry.resolveWait?.({
          runId: spec.runId,
          backendRunId: scratchDir,
          status,
          exitCode: this.options.shouldFail ? 1 : 0,
          outputBytes: this.options.simulateOutputBytes ?? 256,
          error: this.options.shouldFail ? "simulated workload failure" : undefined,
        });
      }, step * 4),
    );

    return {
      runId: spec.runId,
      backendRunId: scratchDir,
      state: () => entry.state,
      cancel: async (_reason: TeardownReason) => {
        entry.cancelled = true;
        for (const t of entry.timers) clearTimeout(t);
        if (!entry.finished) {
          entry.finished = true;
          entry.state = "finished";
          entry.resolveWait?.({
            runId: spec.runId,
            backendRunId: scratchDir,
            status: "cancelled",
            exitCode: null,
            outputBytes: 0,
          });
        }
      },
cleanup: async (): Promise<CleanupReport> => {
        let scratchRemoved = false;
        let tempCredsRevoked = false;
        let cgroupRemoved = false;
        let networkRulesRemoved = false;
        let imageLayersCleaned = false;
        try {
          await rm(entry.scratchDir, { recursive: true, force: true });
          scratchRemoved = true;
          tempCredsRevoked = true;
        } catch {
        }
        this.pending.delete(key);
        return { scratchRemoved, tempCredsRevoked, cgroupRemoved, networkRulesRemoved, imageLayersCleaned };
      },
      wait: () => wait,
    };
  }
}
