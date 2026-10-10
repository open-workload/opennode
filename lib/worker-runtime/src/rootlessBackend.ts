import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CleanupReport,
  TeardownReason,
  WorkerBackend,
  WorkerHandle,
  WorkerLifecycleState,
  WorkerResult,
  WorkerTerminalStatus,
} from "./backend";
import type { WorkerSpec } from "./spec";
import { createCgroupConfigFromLimits, type CgroupHandle, type CgroupManager } from "./cgroup";
import {
  buildRootlessInvocation,
  type RootlessInvocation,
  type RootlessRuntimeKind,
} from "./rootlessRuntime";

const DEFAULT_KILL_GRACE_MS = 2000;
const MAX_TAIL_BYTES = 65536;
const OUTPUT_LOG = "output.log";

export interface RootlessBackendOptions {
  readonly kind: RootlessRuntimeKind;
  readonly installPrefix: string;
  readonly rootfs?: string;
  readonly scratchRoot?: string;
  readonly killGraceMs?: number;
  readonly cgroupManager?: CgroupManager;
  readonly invocationFactory?: (spec: WorkerSpec, workDir: string) => RootlessInvocation;
}

interface RootlessRun {
  readonly spec: WorkerSpec;
  readonly scratchDir: string;
  state: WorkerLifecycleState;
  process?: ChildProcess;
  cgroupHandle?: CgroupHandle;
  wallTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
  finished: boolean;
  bytes: number;
  tail: string;
  resolveWait: (result: WorkerResult) => void;
}

export class RootlessBackend implements WorkerBackend {
  readonly kind = "rootless_isolated";

  constructor(private readonly options: RootlessBackendOptions) {}

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    const root = this.options.scratchRoot ?? tmpdir();
    const scratchDir = await mkdtemp(join(root, "rootless-"));
    const workDir = join(scratchDir, "work");
    await mkdir(workDir, { recursive: true });

    const command = spec.command?.length ? spec.command : ["/bin/true"];
    const invocation = this.options.invocationFactory
      ? this.options.invocationFactory(spec, workDir)
      : buildRootlessInvocation({
          kind: this.options.kind,
          image: spec.image.ref,
          command,
          workDir,
          paths: { installPrefix: this.options.installPrefix, rootfs: this.options.rootfs },
        });

    const literalEnv: Record<string, string> = {};
    for (const entry of spec.env.entries) {
      if (entry.source === "literal" && entry.value !== undefined) {
        literalEnv[entry.name] = entry.value;
      }
    }

    let cgroupHandle: CgroupHandle | undefined;
    if (this.options.cgroupManager) {
      try {
        cgroupHandle = await this.options.cgroupManager.create(
          spec.attemptId ?? spec.runId,
          createCgroupConfigFromLimits(spec.limits),
        );
      } catch {
        cgroupHandle = undefined;
      }
    }

    let resolveWait!: (result: WorkerResult) => void;
    const waitPromise = new Promise<WorkerResult>((resolve) => {
      resolveWait = resolve;
    });

    const cap = spec.limits.outputBytes;
    const graceMs = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

    const run: RootlessRun = {
      spec,
      scratchDir,
      state: "starting",
      cgroupHandle,
      cancelled: false,
      timedOut: false,
      truncated: false,
      finished: false,
      bytes: 0,
      tail: "",
      resolveWait,
    };

    const finish = (result: WorkerResult) => {
      if (run.finished) return;
      run.finished = true;
      if (run.wallTimer) clearTimeout(run.wallTimer);
      run.state = "finished";
      run.resolveWait(result);
    };

    const settle = (result: WorkerResult) => {
      void writeFile(join(scratchDir, OUTPUT_LOG), run.tail, { mode: 0o600 })
        .catch(() => undefined)
        .then(() => finish(result));
    };

    // Signal the whole process group: `unshare --fork` grandchildren (the
    // chrooted command) outlive their parent, and as pid-namespace init they
    // ignore SIGTERM, so only a group SIGKILL reaps them (EXEC-10/EXEC-13).
    const signalGroup = (signal: NodeJS.Signals) => {
      const pid = run.process?.pid;
      if (!pid) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // The group is already gone.
      }
    };

    const killProcess = () => {
      if (!run.process || run.finished) return;
      signalGroup("SIGTERM");
      if (run.killTimer) return;
      // The escalation timer is deliberately not cleared by finish/cleanup:
      // the ns-init grandchild survives SIGTERM, so the group SIGKILL must
      // still land after the parent process has already closed.
      run.killTimer = setTimeout(() => {
        run.killTimer = undefined;
        signalGroup("SIGKILL");
      }, graceMs);
    };

    const proc = spawn(invocation.file, invocation.args, {
      env: { ...process.env, ...literalEnv },
      cwd: scratchDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    run.process = proc;

    const onData = (chunk: Buffer) => {
      run.bytes += chunk.length;
      run.tail = (run.tail + chunk.toString("utf8")).slice(-MAX_TAIL_BYTES);
      if (!run.truncated && !run.finished && run.bytes > cap) {
        run.truncated = true;
        killProcess();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("spawn", () => {
      if (!run.finished && run.state === "starting") run.state = "running";
    });

    proc.on("error", (error) => {
      settle({
        runId: spec.runId,
        backendRunId: scratchDir,
        status: "infrastructure_error",
        exitCode: null,
        outputBytes: Math.min(run.bytes, cap),
        error: error.message,
      });
    });

    proc.on("close", (code) => {
      let status: WorkerTerminalStatus;
      let exitCode: number | null;
      if (run.cancelled) {
        status = "cancelled";
        exitCode = null;
      } else if (run.timedOut) {
        status = "timed_out";
        exitCode = null;
      } else if (code === 0) {
        status = "succeeded";
        exitCode = 0;
      } else {
        status = "failed";
        exitCode = code ?? null;
      }
      settle({
        runId: spec.runId,
        backendRunId: scratchDir,
        status,
        exitCode,
        outputBytes: Math.min(run.bytes, cap),
        error: status === "failed" ? run.tail.slice(-4096) || undefined : undefined,
      });
    });

    if (run.cgroupHandle && proc.pid) {
      try {
        await run.cgroupHandle.enter(proc.pid);
      } catch {
        await run.cgroupHandle.cleanup().catch(() => undefined);
        run.cgroupHandle = undefined;
      }
    }

    run.wallTimer = setTimeout(() => {
      if (run.finished) return;
      run.timedOut = true;
      killProcess();
      settle({
        runId: spec.runId,
        backendRunId: scratchDir,
        status: "timed_out",
        exitCode: null,
        outputBytes: Math.min(run.bytes, cap),
      });
    }, spec.limits.wallClockMs);

    return {
      runId: spec.runId,
      backendRunId: scratchDir,
      state: () => run.state,
      cancel: async (_reason: TeardownReason) => {
        if (run.finished || run.cancelled) return;
        run.cancelled = true;
        run.state = "cancel_requested";
        killProcess();
      },
      cleanup: async (): Promise<CleanupReport> => {
        if (run.wallTimer) clearTimeout(run.wallTimer);

        let scratchRemoved = false;
        try {
          await rm(scratchDir, { recursive: true, force: true });
          scratchRemoved = true;
        } catch {
          scratchRemoved = false;
        }

        let cgroupRemoved = false;
        if (run.cgroupHandle) {
          try {
            await run.cgroupHandle.cleanup();
            cgroupRemoved = true;
          } catch {
            cgroupRemoved = false;
          }
        }

        return {
          scratchRemoved,
          tempCredsRevoked: false,
          cgroupRemoved,
          networkRulesRemoved: false,
          imageLayersCleaned: false,
        };
      },
      wait: () => waitPromise,
    };
  }
}
