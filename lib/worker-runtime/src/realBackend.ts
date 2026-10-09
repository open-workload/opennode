import { spawn, SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupReport, TeardownReason, WorkerBackend, WorkerHandle, WorkerLifecycleState, WorkerResult } from "./backend";
import type { WorkerSpec } from "./spec";
import { CgroupManager, createCgroupConfigFromLimits, CgroupHandle } from "./cgroup";
import { NftablesManager } from "./nftables";
import { OciPuller, ImagePullResult } from "./oci";
import { SecretBrokerClient, ResolvedSecret } from "./secretBroker";
import { ContentStoreClient, MasterKey, ChunkEncryptionResult } from "./contentStore";
import { NodeId, ClusterId, createClusterId } from "@workspace/opennode-domain";
import { WorkerRuntimeError } from "./errors";

export interface RealBackendOptions {
  readonly scratchRoot?: string;
  readonly cgroupManager?: CgroupManager;
  readonly nftablesConfig?: {
    allowedEgressHosts: readonly string[];
    blockMetadataEndpoints: boolean;
    blockControlPlane: boolean;
  };
  readonly ociPuller?: OciPuller;
  readonly secretBrokerClient?: SecretBrokerClient;
  readonly contentStoreClient?: ContentStoreClient;
  readonly masterKey?: MasterKey;
  readonly workerNodeId?: NodeId;
  readonly authorizedBy?: NodeId;
  readonly defaultTtlMs?: number;
  readonly runtimePath?: string;
}

interface RealRun {
  spec: WorkerSpec;
  scratchDir: string;
  cgroupHandle?: CgroupHandle;
  nftablesManager?: NftablesManager;
  imagePullResult?: ImagePullResult;
  resolvedSecrets: ResolvedSecret[];
  state: WorkerLifecycleState;
  process?: ReturnType<typeof spawn>;
  resolveWait?: (result: WorkerResult) => void;
  waitPromise: Promise<WorkerResult>;
  cancelled: boolean;
  finished: boolean;
}

export class RealWorkerBackend implements WorkerBackend {
  readonly kind = "real_isolated";
  private readonly runs = new Map<string, RealRun>();

  constructor(private readonly options: RealBackendOptions = {}) {}

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    const attemptId = spec.attemptId ?? `attempt-${Date.now()}`;
    const scratchRoot = this.options.scratchRoot ?? tmpdir();
    const scratchDir = await mkdtemp(join(scratchRoot, "worker-runtime-"));
    await mkdir(join(scratchDir, "work"), { recursive: true }).catch(() => undefined);
    await mkdir(join(scratchDir, "output"), { recursive: true }).catch(() => undefined);

    let cgroupHandle: CgroupHandle | undefined;
    let nftablesManager: NftablesManager | undefined;
    let imagePullResult: ImagePullResult | undefined;
    let resolvedSecrets: ResolvedSecret[] = [];

    try {
      if (this.options.cgroupManager) {
        const cgroupConfig = createCgroupConfigFromLimits(spec.limits);
        cgroupHandle = await this.options.cgroupManager.create(attemptId, cgroupConfig);
      }

      if (this.options.nftablesConfig && cgroupHandle) {
        nftablesManager = new NftablesManager(cgroupHandle.path, this.options.nftablesConfig);
        await nftablesManager.apply();
      }

      if (this.options.ociPuller) {
        imagePullResult = await this.options.ociPuller.pull(spec.image.ref, spec.image.digest);
      }

      if (this.options.secretBrokerClient && spec.secretRefs && spec.secretRefs.length > 0 && spec.leaseToken) {
        const jobId = spec.jobId ?? spec.runId;
        const clusterId = spec.clusterId ? createClusterId(spec.clusterId) : createClusterId("default");
        resolvedSecrets = await this.options.secretBrokerClient.resolveSecrets(
          spec.secretRefs,
          jobId,
          attemptId,
          clusterId,
          spec.leaseToken,
        );
      }

      const envFile = join(scratchDir, "env.json");
      const envEntries = spec.env.entries.map((e) => {
        if (e.source === "secret_ref") {
          const resolved = resolvedSecrets.find((s) => s.name === e.name);
          return { name: e.name, value: resolved?.value ?? "" };
        }
        return { name: e.name, value: e.value ?? "" };
      });
      await writeFile(envFile, JSON.stringify(envEntries, null, 2), { mode: 0o600 });

      const command = spec.command?.length ? spec.command : ["sleep", "infinity"];
      const runtimePath = this.options.runtimePath ?? "docker";
      const args = ["run", "--rm", "--init", "--cgroupns=host", "--network=none"];
      
      if (cgroupHandle) {
        args.push("--cgroup", cgroupHandle.path.replace("/sys/fs/cgroup/", ""));
      }
      
      args.push("-v", `${scratchDir}/work:/workspace`);
      args.push("-v", `${envFile}:/workspace/.env:ro`);
      args.push("--workdir", "/workspace");
      args.push("--memory", `${spec.limits.memoryBytes}b`);
      args.push("--cpus", `${spec.limits.cpuMilli / 1000}`);
      args.push("--pids-limit", `${spec.limits.pidLimit}`);
      args.push(spec.image.ref);

      args.push(...command);

      let waitResolve!: (result: WorkerResult) => void;
      const waitPromise = new Promise<WorkerResult>((resolve) => {
        waitResolve = resolve;
      });

      const run: RealRun = {
        spec,
        scratchDir,
        cgroupHandle,
        nftablesManager,
        imagePullResult,
        resolvedSecrets,
        state: "starting",
        waitPromise,
        resolveWait: waitResolve,
        cancelled: false,
        finished: false,
      };

      const key = `${spec.runId}:${attemptId}`;
      this.runs.set(key, run);

      const proc = spawn(runtimePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: process.env.PATH },
      } as SpawnOptions);

      run.process = proc;

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));

      proc.on("error", (err) => {
        if (!run.finished) {
          run.finished = true;
          run.state = "finished";
          run.resolveWait?.({
            runId: spec.runId,
            backendRunId: scratchDir,
            status: "infrastructure_error",
            exitCode: null,
            outputBytes: 0,
            error: err.message,
          });
        }
      });

      proc.on("close", (code) => {
        if (!run.finished) {
          run.finished = true;
          run.state = "finished";
          const status = code === 0 ? "succeeded" : "failed";
          run.resolveWait?.({
            runId: spec.runId,
            backendRunId: scratchDir,
            status,
            exitCode: code,
            outputBytes: Buffer.byteLength(stdout + stderr, "utf8"),
            error: code !== 0 ? stderr.slice(0, 4096) : undefined,
          });
        }
      });

      run.state = "running";

      return {
        runId: spec.runId,
        backendRunId: scratchDir,
        state: () => run.state,
        cancel: async (reason: TeardownReason) => {
          run.cancelled = true;
          if (run.process && !run.finished) {
            run.process.kill("SIGTERM");
            setTimeout(() => {
              if (run.process && !run.finished) run.process.kill("SIGKILL");
            }, 5000);
          }
          if (!run.finished) {
            run.finished = true;
            run.state = "finished";
            run.resolveWait?.({
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
            await rm(run.scratchDir, { recursive: true, force: true });
            scratchRemoved = true;
          } catch {
          }

          try {
            if (run.cgroupHandle) {
              await run.cgroupHandle.cleanup();
              cgroupRemoved = true;
            }
          } catch {
          }

          try {
            if (run.nftablesManager) {
              await run.nftablesManager.remove();
              networkRulesRemoved = true;
            }
          } catch {
          }

          this.runs.delete(key);
          return { scratchRemoved, tempCredsRevoked, cgroupRemoved, networkRulesRemoved, imageLayersCleaned };
        },
        wait: () => run.waitPromise,
      };
    } catch (error) {
      if (nftablesManager) await nftablesManager.remove().catch(() => undefined);
      if (cgroupHandle) await cgroupHandle.cleanup().catch(() => undefined);
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}