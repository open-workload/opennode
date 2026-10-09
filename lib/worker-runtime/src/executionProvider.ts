import type { WorkloadRun } from "@workspace/db";
import type { ExecutionProvider } from "@workspace/node-store";
import { WorkerRuntime } from "./runtime";
import type { WorkerSpec } from "./spec";

const DEFAULT_PID_LIMIT = 256;
const DEFAULT_OUTPUT_BYTES = 16 * 1024 * 1024;

export function workerSpecFromRun(run: WorkloadRun): WorkerSpec {
  return {
    runId: run.id,
    image: { ref: run.image ?? "", digest: run.imageDigest ?? "" },
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
  readonly executionMode = "built_in_diagnostic" as const;

  constructor(private readonly runtime: WorkerRuntime) {}

  async startRun(run: WorkloadRun, opts: { requestId?: string }): Promise<void> {
    await this.runtime.submit(workerSpecFromRun(run));
  }

  async cancelRun(runId: string, opts?: { requestId?: string }): Promise<void> {
    await this.runtime.cancel(runId, "cancelled");
  }
}
