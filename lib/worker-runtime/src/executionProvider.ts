import type { WorkloadRun } from "@workspace/db";
import type { ExecutionProvider } from "@workspace/node-store";
import { WorkerSpecError } from "./errors";
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

export class WorkerExecutionProvider implements ExecutionProvider {
  readonly executionMode = "isolated_worker" as const;

  constructor(private readonly runtime: WorkerRuntime) {}

  async startRun(run: WorkloadRun, opts: { requestId?: string }): Promise<void> {
    await this.runtime.submit(workerSpecFromRun(run));
  }

  async cancelRun(runId: string, opts?: { requestId?: string }): Promise<void> {
    await this.runtime.cancel(runId, "cancelled");
  }
}