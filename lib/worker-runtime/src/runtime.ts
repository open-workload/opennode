/**
 * Orchestrates one worker attempt around a backend: validate, isolate, run, reap.
 *
 *   spec ─▶ validateWorkerSpec ─▶ cgroup ─▶ nftables ─▶ image pull ─▶ secrets ─▶ backend.start
 *     │             │ fail                                                  │
 *     │             └──▶ teardown + throw WorkerSpecError        active run + history
 *     └── runId already active ─▶ throw duplicate_run                           │
 *
 *   active run: setTimeout(wallClockMs) ─▶ cancel(timeout); evict/outage ─▶ cancel
 *   handle.wait ─▶ teardown ─▶ nft.remove + cgroup.cleanup + handle.cleanup ─▶ WorkerResult
 *
 *   waitForCompletion(runId) ─▶ last attempt has result ─▶ resolve now
 *              │ not active and no history ──▶ reject WorkerRuntimeError
 *              └▶ register waiter ─▶ watch records result ─▶ resolve
 *                                   watch throws ──────────▶ reject
 *
 * The wall-clock cap is a plain setTimeout; the injected `now` is never read.
 */

import type { WorkerBackend, WorkerHandle, CleanupReport } from "./backend";
import { WorkerSpecError, WorkerRuntimeError } from "./errors";
import { validateWorkerSpec, type PolicyResult, type WorkerSpec } from "./spec";
import type { TeardownReason, WorkerResult } from "./backend";
import { CgroupManager, createCgroupConfigFromLimits } from "./cgroup";
import { NftablesManager } from "./nftables";
import { OciPuller, ImagePullResult, PolicyVerificationResult } from "./oci";
import { SecretBrokerClient } from "./secretBroker";
import { ContentStoreClient, MasterKey } from "./contentStore";
import { NodeId, ClusterId, createClusterId } from "@workspace/opennode-domain";

export type WorkerEvent =
  | { readonly type: "policy_checked"; readonly runId: string; readonly policy: PolicyResult }
  | { readonly type: "submitted"; readonly runId: string }
  | { readonly type: "starting"; readonly runId: string }
  | { readonly type: "running"; readonly runId: string }
  | { readonly type: "cancel_requested"; readonly runId: string; readonly reason: TeardownReason }
  | { readonly type: "teardown"; readonly runId: string; readonly reason: TeardownReason }
  | { readonly type: "cleanup"; readonly runId: string; readonly report: CleanupReport }
  | { readonly type: "finished"; readonly runId: string; readonly result: WorkerResult }
  | { readonly type: "image_pulled"; readonly runId: string; readonly digest: string; readonly policy: PolicyVerificationResult }
  | { readonly type: "secrets_resolved"; readonly runId: string; readonly count: number }
  | { readonly type: "cgroup_created"; readonly runId: string; readonly path: string }
  | { readonly type: "network_rules_applied"; readonly runId: string; readonly rulesCount: number };

export interface AttemptRecord {
  readonly runId: string;
  readonly backendRunId: string;
  readonly digest: string;
  readonly policy: PolicyResult;
  readonly teardownReason?: TeardownReason;
  readonly result?: WorkerResult;
  readonly imagePullResult?: ImagePullResult;
  readonly secretsResolved?: number;
  readonly cgroupPath?: string;
  readonly networkRulesApplied?: boolean;
}

interface ActiveRun {
  readonly spec: WorkerSpec;
  readonly policy: PolicyResult;
  handle: WorkerHandle;
  cancelled: boolean;
  reason?: TeardownReason;
  wallClockTimer?: NodeJS.Timeout;
  cgroupHandle?: Awaited<ReturnType<CgroupManager["create"]>>;
  nftablesManager?: NftablesManager;
}

export interface WorkerRuntimeOptions {
  readonly onEvent?: (event: WorkerEvent) => void;
  readonly now?: () => number;
  readonly cgroupManager?: CgroupManager;
  readonly nftablesManager?: NftablesManager;
  readonly ociPuller?: OciPuller;
  readonly secretBrokerClient?: SecretBrokerClient;
  readonly contentStoreClient?: ContentStoreClient;
  readonly masterKey?: MasterKey;
  readonly workerNodeId?: NodeId;
  readonly authorizedBy?: NodeId;
  readonly defaultTtlMs?: number;
}

export class WorkerRuntime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly history = new Map<string, AttemptRecord[]>();
  private readonly waiters = new Map<string, { resolve: (result: WorkerResult) => void; reject: (error: unknown) => void }[]>();

  constructor(
    private readonly backend: WorkerBackend,
    private readonly options: WorkerRuntimeOptions = {},
  ) {}

  listActiveRunIds(): string[] {
    return [...this.active.keys()];
  }

  historyFor(runId: string): readonly AttemptRecord[] {
    return this.history.get(runId) ?? [];
  }

  async submit(spec: WorkerSpec): Promise<AttemptRecord> {
    const policy = validateWorkerSpec(spec);
    this.emit({ type: "policy_checked", runId: spec.runId, policy });
    if (!policy.ok) {
      this.emit({ type: "teardown", runId: spec.runId, reason: "failure" });
      throw new WorkerSpecError(policy.issues);
    }
    if (this.active.has(spec.runId)) throw new WorkerRuntimeError(`run ${spec.runId} is already active`, "duplicate_run");

    this.emit({ type: "submitted", runId: spec.runId });
    this.emit({ type: "starting", runId: spec.runId });

    const attemptId = spec.attemptId ?? `attempt-${Date.now()}`;
    const jobId = spec.jobId ?? spec.runId;
    const clusterId = spec.clusterId ? createClusterId(spec.clusterId) : createClusterId("default");

    let cgroupHandle: Awaited<ReturnType<CgroupManager["create"]>> | undefined;
    let nftablesManager: NftablesManager | undefined;
    let imagePullResult: ImagePullResult | undefined;
    let secretsResolved = 0;
    let cgroupPath: string | undefined;
    let networkRulesApplied = false;

    try {
      if (this.options.cgroupManager) {
        const cgroupConfig = createCgroupConfigFromLimits(spec.limits);
        cgroupHandle = await this.options.cgroupManager.create(attemptId, cgroupConfig);
        cgroupPath = cgroupHandle.path;
        this.emit({ type: "cgroup_created", runId: spec.runId, path: cgroupPath });
      }

      if (this.options.nftablesManager && cgroupPath) {
        nftablesManager = new NftablesManager(cgroupPath, {
          allowedEgressHosts: spec.network.allowedEgressHosts,
          blockMetadataEndpoints: spec.network.blockMetadataEndpoints,
          blockControlPlane: spec.network.blockControlPlane,
        });
        await nftablesManager.apply();
        networkRulesApplied = true;
        this.emit({ type: "network_rules_applied", runId: spec.runId, rulesCount: spec.network.allowedEgressHosts.length + 10 });
      }

      if (this.options.ociPuller) {
        imagePullResult = await this.options.ociPuller.pull(spec.image.ref, spec.image.digest);
        this.emit({ type: "image_pulled", runId: spec.runId, digest: imagePullResult.digest, policy: imagePullResult.policyResult });
      }

      if (this.options.secretBrokerClient && spec.secretRefs && spec.secretRefs.length > 0 && spec.leaseToken) {
        const resolved = await this.options.secretBrokerClient.resolveSecrets(
          spec.secretRefs,
          jobId,
          attemptId,
          clusterId,
          spec.leaseToken,
        );
        secretsResolved = resolved.length;
        this.emit({ type: "secrets_resolved", runId: spec.runId, count: secretsResolved });
      }

      const handle = await this.backend.start(spec);
      const run: ActiveRun = { spec, policy, handle, cancelled: false, cgroupHandle, nftablesManager };
      this.active.set(spec.runId, run);

      run.wallClockTimer = setTimeout(() => {
        void this.cancel(spec.runId, "timeout");
      }, spec.limits.wallClockMs);
      run.wallClockTimer.unref?.();

      this.recordHistory(spec.runId, {
        runId: spec.runId,
        backendRunId: handle.backendRunId,
        digest: policy.digest,
        policy,
        imagePullResult,
        secretsResolved,
        cgroupPath,
        networkRulesApplied,
      });

      void this.watch(spec.runId, run).catch((error: unknown) => this.rejectWaiters(spec.runId, error));
      return this.historyFor(spec.runId).at(-1)!;
    } catch (error) {
      if (nftablesManager) await nftablesManager.remove().catch(() => undefined);
      if (cgroupHandle) await cgroupHandle.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async waitForCompletion(runId: string): Promise<WorkerResult> {
    const last = this.history.get(runId)?.at(-1);
    if (last?.result !== undefined) return last.result;
    if (!this.active.has(runId) && !this.history.has(runId)) {
      throw new WorkerRuntimeError(`run ${runId} is not active and has no attempt history`, "run_not_found");
    }
    return new Promise<WorkerResult>((resolve, reject) => {
      const list = this.waiters.get(runId) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(runId, list);
    });
  }

  async cancel(runId: string, reason: TeardownReason = "cancelled"): Promise<void> {
    const run = this.active.get(runId);
    if (!run) return;
    if (run.cancelled) return;
    run.cancelled = true;
    run.reason = reason;
    this.emit({ type: "cancel_requested", runId, reason });
    await run.handle.cancel(reason);
    await this.teardown(runId, run, reason);
  }

  async evict(runId: string): Promise<void> {
    await this.cancel(runId, "eviction");
  }

  async markWorkerDisappeared(runId: string): Promise<void> {
    await this.cancel(runId, "worker_disappeared");
  }

  async handleControlPlaneOutage(): Promise<void> {
    for (const runId of [...this.active.keys()]) {
      await this.cancel(runId, "control_plane_outage");
    }
  }

  private async watch(runId: string, run: ActiveRun): Promise<void> {
    const result = await run.handle.wait();
    if (run.wallClockTimer) clearTimeout(run.wallClockTimer);
    if (!run.cancelled) {
      const reason: TeardownReason = result.status === "succeeded" ? "success" : result.status === "timed_out" ? "timeout" : "failure";
      await this.teardown(runId, run, reason);
      this.emit({ type: "finished", runId, result });
      this.recordHistory(runId, { ...this.historyFor(runId).at(-1)!, teardownReason: reason, result });
      this.resolveWaiters(runId, result);
      return;
    }
    this.emit({ type: "finished", runId, result });
    const last = this.historyFor(runId).at(-1)!;
    this.recordHistory(runId, { ...last, teardownReason: run.reason ?? "failure", result });
    this.resolveWaiters(runId, result);
  }

  private async teardown(runId: string, run: ActiveRun, reason: TeardownReason): Promise<void> {
    this.emit({ type: "teardown", runId, reason });
    if (run.wallClockTimer) clearTimeout(run.wallClockTimer);
    run.reason = reason;

    await run.nftablesManager?.remove().catch(() => undefined);
    await run.cgroupHandle?.cleanup().catch(() => undefined);

    const report = await run.handle.cleanup().catch(() => ({
      scratchRemoved: false,
      tempCredsRevoked: false,
      cgroupRemoved: false,
      networkRulesRemoved: false,
      imageLayersCleaned: false,
    }));
    this.emit({ type: "cleanup", runId, report });
    this.active.delete(runId);
  }

  private recordHistory(runId: string, record: AttemptRecord): void {
    const list = this.history.get(runId) ?? [];
    if (list.length > 0 && list.at(-1)!.result === undefined) {
      list[list.length - 1] = record;
    } else {
      list.push(record);
    }
    this.history.set(runId, list);
  }

  private resolveWaiters(runId: string, result: WorkerResult): void {
    const waiters = this.waiters.get(runId);
    if (!waiters) return;
    this.waiters.delete(runId);
    for (const waiter of waiters) waiter.resolve(result);
  }

  private rejectWaiters(runId: string, error: unknown): void {
    const waiters = this.waiters.get(runId);
    if (!waiters) return;
    this.waiters.delete(runId);
    for (const waiter of waiters) waiter.reject(error);
  }

  private emit(event: WorkerEvent): void {
    this.options.onEvent?.(event);
  }
}
