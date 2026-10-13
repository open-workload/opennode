/**
 * Adapts a persisted WorkloadRun to the worker runtime's WorkerSpec contract,
 * and reports one attempt's lifecycle out through the AttemptLifecycle port.
 *
 *   WorkloadRun ──▶ workerSpecFromRun ──▶ WorkerSpec (pinned image + limits)
 *                        │ unpinned image
 *                        └──▶ WorkerSpecError (thrown before submit; availability untouched)
 *
 *   startRun ─▶ runtime.submit ─▶ availability=1 ─▶ observe(running) ─▶ waitForCompletion ─▶ observe(terminal)
 *        │ submit rejects                 │ renewEveryMs ▶ renewLease (while active)
 *        └▶ availability=0                finally: clearInterval
 *          + observe(infrastructure_error) unless duplicate_run
 *
 *   cancelRun ──▶ runtime.cancel("cancelled")
 */
import type { WorkloadRun } from "@workspace/db";
import type { ExecutionProvider } from "@workspace/node-store";
import { metricsRegistry } from "@workspace/observability";
import { WorkerRuntimeError, WorkerSpecError } from "./errors";
import { WorkerRuntime } from "./runtime";
import type { ImagePin, WorkerSpec } from "./spec";

const DEFAULT_PID_LIMIT = 256;
const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;

// The busybox rootfs whose content is pinned by install.ts; the userns runtime
// chroots into it, so diagnostics reuse the exact bytes the rootfs verifies.
const DIAGNOSTIC_IMAGE_REF = "busybox:1.35";
const DIAGNOSTIC_IMAGE_DIGEST = "sha256:6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348";

const PINNED_IMAGE_RE = /^.+@sha256:[a-f0-9]{64}$/;

function imagePinFromRun(run: WorkloadRun): ImagePin {
  if (run.image === null) {
    return { ref: DIAGNOSTIC_IMAGE_REF, digest: DIAGNOSTIC_IMAGE_DIGEST };
  }
  if (!PINNED_IMAGE_RE.test(run.image)) {
    throw new WorkerSpecError([`image ${run.image} must be pinned to an immutable sha256 digest`]);
  }
  const at = run.image.lastIndexOf("@");
  return { ref: run.image, digest: run.image.slice(at + 1) };
}

export function workerSpecFromRun(run: WorkloadRun): WorkerSpec {
  return {
    runId: run.id,
    image: imagePinFromRun(run),
    command: run.command.length > 0 ? run.command : undefined,
    env: { entries: [] },
    limits: {
      cpuMilli: run.resources.cpuMilli,
      memoryBytes: run.resources.memoryMiB * 1024 * 1024,
      pidLimit: DEFAULT_PID_LIMIT,
      diskBytes: run.resources.diskMiB * 1024 * 1024,
      wallClockMs: run.resources.timeoutSeconds * 1000,
      outputBytes: DEFAULT_OUTPUT_BYTES,
    },
    network: {
      mode: run.networkPolicy,
      allowedEgressHosts: [],
      blockMetadataEndpoints: true,
      blockControlPlane: true,
    },
  };
}

export type AttemptObservationStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "infrastructure_error";

export interface AttemptLifecycle {
  /** Cadence at which the provider must renew the committed lease while a run is active. */
  readonly renewEveryMs: number;
  observe(input: {
    readonly runId: string;
    readonly status: AttemptObservationStatus;
    readonly note?: string;
    readonly requestId?: string;
  }): Promise<void>;
  renewLease(runId: string, opts?: { readonly requestId?: string }): Promise<void>;
}

function noteFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkerExecutionProvider implements ExecutionProvider {
  readonly executionMode = "isolated_worker" as const;

  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly lifecycle: AttemptLifecycle,
  ) {}

  async startRun(run: WorkloadRun, opts: { requestId?: string }): Promise<void> {
    const spec = workerSpecFromRun(run);
    try {
      await this.runtime.submit(spec);
      metricsRegistry.set("provider.availability", 1);
    } catch (error) {
      metricsRegistry.set("provider.availability", 0);
      if (!(error instanceof WorkerRuntimeError && error.code === "duplicate_run")) {
        await this.lifecycle
          .observe({ runId: run.id, status: "infrastructure_error", note: noteFromError(error), requestId: opts?.requestId })
          .catch(() => undefined);
      }
      throw error;
    }

    const timer = setInterval(() => {
      void this.lifecycle.renewLease(run.id, opts).catch(() => undefined);
    }, this.lifecycle.renewEveryMs);
    timer.unref?.();

    try {
      await this.lifecycle.observe({ runId: run.id, status: "running", requestId: opts?.requestId }).catch(() => undefined);
      const result = await this.runtime.waitForCompletion(run.id);
      await this.lifecycle.observe({
        runId: run.id,
        status: result.status,
        note: result.error ?? `exit=${result.exitCode} outputBytes=${result.outputBytes}`,
        requestId: opts?.requestId,
      });
    } catch (error) {
      await this.lifecycle
        .observe({ runId: run.id, status: "infrastructure_error", note: noteFromError(error), requestId: opts?.requestId })
        .catch(() => undefined);
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  async cancelRun(runId: string, opts?: { requestId?: string }): Promise<void> {
    await this.runtime.cancel(runId, "cancelled");
  }
}