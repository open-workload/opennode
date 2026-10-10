import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { and, asc, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import {
  activityEventsTable,
  auditEventsTable,
  clusterMetadataTable,
  clusterNodesTable,
  db,
  idempotencyKeysTable,
  leasesTable,
  localNodeIdentityTable,
  membershipProposalsTable,
  membershipVotesTable,
  peerStatusTable,
  runLogEntriesTable,
  workloadRunAttemptsTable,
  workloadRunsTable,
  type ActivityEvent,
  type AuditEvent,
  type ClusterMetadata,
  type ClusterNode,
  type WorkloadRun,
  type WorkloadRunAttempt,
  type RunLogEntry,
} from "@workspace/db";
import {
  createArbitraryContainerWorkload,
  createBuiltInDiagnosticWorkload,
  createRun,
  type StoredNodeIdentity,
} from "@workspace/opennode-domain";
import { NodeStoreError } from "./errors";
import { logEntryChecksum, requestFingerprint, sha256Hex, stableStringify } from "./checksum";

export interface ResourceLimitsInput {
  cpuMilli: number;
  memoryMiB: number;
  diskMiB: number;
  timeoutSeconds: number;
}

export interface SubmitRunCommand {
  clientRequestId: string;
  name: string;
  mode: "diagnostic" | "container";
  image: string | null;
  command: string[];
  resources: ResourceLimitsInput;
  networkPolicy: "deny_all" | "allowlist";
  submittedBy: string;
  submittedViaNodeId: string;
  requestId?: string;
}

export interface RunListPage {
  items: WorkloadRun[];
  nextCursor: string | null;
}

export interface LogPage {
  items: RunLogEntry[];
  nextCursor: string | null;
}

export interface BackupManifest {
  version: number;
  createdAt: string;
  tableCount: number;
  rowCount: number;
  checksum: string;
}

export interface AuditInput {
  action: string;
  actorNodeId?: string | null;
  runId?: string | null;
  attemptId?: string | null;
  requestId?: string;
  idempotencyKey?: string;
  detail?: Record<string, unknown>;
}

export interface IdempotencyRecord {
  runId: string;
  created: boolean;
}

export interface NodeStore {
  submitRun(cmd: SubmitRunCommand): Promise<{ run: WorkloadRun; created: boolean }>;
  getRun(runId: string): Promise<WorkloadRun | null>;
  listRuns(opts: { limit: number; cursor?: string; status?: string }): Promise<RunListPage>;
  listNodes(): Promise<ClusterNode[]>;
  listActivity(limit: number): Promise<ActivityEvent[]>;
  getClusterMetadata(): Promise<ClusterMetadata | null>;
  countPendingProposals(): Promise<number>;
  countRunsByStatus(): Promise<Record<string, number>>;
  requestCancel(runId: string, requestId?: string): Promise<WorkloadRun>;
  markRunTerminal(runId: string, status: WorkloadRun["status"], failureReason?: string | null, requestId?: string): Promise<WorkloadRun>;
  setRunRunning(runId: string, workerNodeId: string, requestId?: string): Promise<WorkloadRun>;
  appendLog(input: { runId: string; attempt: number; stream: "stdout" | "stderr" | "system"; message: string; requestId?: string }): Promise<RunLogEntry>;
  getLogs(runId: string, opts: { cursor?: string; limit: number }): Promise<LogPage>;
  createAttempt(runId: string, input: { status: WorkloadRunAttempt["status"]; workerNodeId?: string; requestId?: string }): Promise<WorkloadRunAttempt>;
  transitionAttempt(attemptId: string, status: WorkloadRunAttempt["status"], opts?: { errorReason?: string; requestId?: string }): Promise<WorkloadRunAttempt>;
  recordAudit(input: AuditInput): Promise<AuditEvent>;
  getLocalNodeId(): Promise<string>;
  listNodeIdentities(): Promise<StoredNodeIdentity[]>;
  verifyRunLogIntegrity(runId: string): Promise<boolean>;
  backupToFile(path: string): Promise<BackupManifest>;
  restoreFromFile(path: string): Promise<BackupManifest>;
  checkIdempotency(actorId: string, clientRequestId: string, payloadHash: string): Promise<IdempotencyRecord | null>;
  storeIdempotencyKey(actorId: string, clientRequestId: string, runId: string, payloadHash: string): Promise<void>;
  cleanupExpiredIdempotencyKeys(): Promise<number>;
}

const TERMINAL_STATUSES = new Set<string>(["succeeded", "failed", "cancelled", "timed_out", "infrastructure_error"]);
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class DrizzleNodeStore implements NodeStore {
  async submitRun(cmd: SubmitRunCommand): Promise<{ run: WorkloadRun; created: boolean }> {
    validateWorkloadCommand(cmd);
    const id = randomUUID();
    const fingerprint = requestFingerprint({
      name: cmd.name,
      mode: cmd.mode,
      image: cmd.image,
      command: cmd.command,
      resources: cmd.resources,
      networkPolicy: cmd.networkPolicy,
      submittedBy: cmd.submittedBy,
    });
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(workloadRunsTable)
        .where(eq(workloadRunsTable.clientRequestId, cmd.clientRequestId))
        .limit(1);
      if (existing.length > 0) {
        if (existing[0].requestFingerprint === fingerprint) {
          return { run: existing[0], created: false };
        }
        throw new NodeStoreError("IDEMPOTENCY_CONFLICT", "clientRequestId reused with a different payload");
      }
      const [run] = await tx
        .insert(workloadRunsTable)
        .values({
          id,
          clientRequestId: cmd.clientRequestId,
          name: cmd.name,
          mode: cmd.mode,
          image: cmd.image,
          imageDigest: null,
          command: cmd.command,
          status: "queued",
          executionMode: cmd.mode === "diagnostic" ? "built_in_diagnostic" : "isolated_worker",
          submittedBy: cmd.submittedBy,
          submittedViaNodeId: cmd.submittedViaNodeId,
          workerNodeId: null,
          attemptCount: 0,
          resources: cmd.resources,
          networkPolicy: cmd.networkPolicy,
          failureReason: null,
          requestFingerprint: fingerprint,
        })
        .returning();
      await insertAudit(tx, {
        action: "run.submitted",
        actorNodeId: cmd.submittedViaNodeId,
        runId: id,
        requestId: cmd.requestId ?? "",
        idempotencyKey: cmd.clientRequestId,
        detail: { mode: cmd.mode },
      });
      await tx.insert(activityEventsTable).values({
        id: randomUUID(),
        kind: "run_submitted",
        message: `Run submitted: ${cmd.name}`,
        actorNodeId: cmd.submittedViaNodeId,
      });
      return { run, created: true };
    });
  }

  async getRun(runId: string): Promise<WorkloadRun | null> {
    const rows = await db.select().from(workloadRunsTable).where(eq(workloadRunsTable.id, runId)).limit(1);
    return rows[0] ?? null;
  }

  async listRuns(opts: { limit: number; cursor?: string; status?: string }): Promise<RunListPage> {
    const conditions: SQL[] = [];
    if (opts.status) conditions.push(eq(workloadRunsTable.status, opts.status as WorkloadRun["status"]));
    if (opts.cursor) {
      const cursorDate = new Date(opts.cursor);
      if (!Number.isNaN(cursorDate.getTime())) conditions.push(lt(workloadRunsTable.createdAt, cursorDate));
    }
    const rows = await db
      .select()
      .from(workloadRunsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workloadRunsTable.createdAt))
      .limit(opts.limit + 1);
    const items = rows.slice(0, opts.limit);
    const nextCursor = rows.length > opts.limit && items.length > 0 ? items[items.length - 1].createdAt.toISOString() : null;
    return { items, nextCursor };
  }

  async listNodes(): Promise<ClusterNode[]> {
    return db.select().from(clusterNodesTable).orderBy(asc(clusterNodesTable.name));
  }

  async listActivity(limit: number): Promise<ActivityEvent[]> {
    return db
      .select()
      .from(activityEventsTable)
      .orderBy(desc(activityEventsTable.createdAt))
      .limit(limit);
  }

  async getClusterMetadata(): Promise<ClusterMetadata | null> {
    const rows = await db.select().from(clusterMetadataTable).limit(1);
    return rows[0] ?? null;
  }

  async countPendingProposals(): Promise<number> {
    const rows = await db
      .select()
      .from(membershipProposalsTable)
      .where(eq(membershipProposalsTable.status, "pending"));
    return rows.length;
  }

  async countRunsByStatus(): Promise<Record<string, number>> {
    const rows = await db
      .select({ status: workloadRunsTable.status, count: sql<number>`count(*)::int` })
      .from(workloadRunsTable)
      .groupBy(workloadRunsTable.status);
    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  async requestCancel(runId: string, requestId?: string): Promise<WorkloadRun> {
    return db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      if (TERMINAL_STATUSES.has(run.status)) {
        throw new NodeStoreError("INVALID_TRANSITION", `Run is terminal (${run.status})`);
      }
      const [updated] = await tx
        .update(workloadRunsTable)
        .set({ status: "cancel_requested" })
        .where(eq(workloadRunsTable.id, runId))
        .returning();
      await insertAudit(tx, { action: "run.cancel_requested", runId, requestId: requestId ?? "" });
      return updated;
    });
  }

  async markRunTerminal(runId: string, status: WorkloadRun["status"], failureReason?: string | null, requestId?: string): Promise<WorkloadRun> {
    if (!TERMINAL_STATUSES.has(status) && status !== "cancel_requested") {
      throw new NodeStoreError("INVALID_TRANSITION", `Not a terminal transition target: ${status}`);
    }
    return db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      const [updated] = await tx
        .update(workloadRunsTable)
        .set({ status, failureReason: failureReason ?? null })
        .where(eq(workloadRunsTable.id, runId))
        .returning();
      await insertAudit(tx, { action: `run.${status}`, runId, requestId: requestId ?? "", detail: failureReason ? { failureReason } : {} });
      if (TERMINAL_STATUSES.has(status)) {
        await tx.insert(activityEventsTable).values({
          id: randomUUID(),
          kind: "run_finished",
          message: `Run ${status}: ${run.name}`,
          actorNodeId: run.workerNodeId,
        });
      }
      return updated;
    });
  }

  async setRunRunning(runId: string, workerNodeId: string, requestId?: string): Promise<WorkloadRun> {
    return db.transaction(async (tx) => {
      await lockRun(tx, runId);
      const [updated] = await tx
        .update(workloadRunsTable)
        .set({ status: "running", workerNodeId, attemptCount: sql`${workloadRunsTable.attemptCount} + 1` })
        .where(eq(workloadRunsTable.id, runId))
        .returning();
      await insertAudit(tx, { action: "run.running", runId, requestId: requestId ?? "", detail: { workerNodeId } });
      return updated;
    });
  }

  async appendLog(input: { runId: string; attempt: number; stream: "stdout" | "stderr" | "system"; message: string; requestId?: string }): Promise<RunLogEntry> {
    return db.transaction(async (tx) => {
      const maxRows = await tx
        .select({ maxSeq: sql<number>`coalesce(max(${runLogEntriesTable.sequence}), 0)` })
        .from(runLogEntriesTable)
        .where(eq(runLogEntriesTable.runId, input.runId));
      const sequence = (maxRows[0]?.maxSeq ?? 0) + 1;
      const createdAt = new Date();
      const checksum = logEntryChecksum({ runId: input.runId, attempt: input.attempt, stream: input.stream, sequence, message: input.message, createdAt });
      const [entry] = await tx
        .insert(runLogEntriesTable)
        .values({ id: randomUUID(), runId: input.runId, sequence, attempt: input.attempt, stream: input.stream, message: input.message, checksum, createdAt })
        .returning();
      return entry;
    });
  }

  async getLogs(runId: string, opts: { cursor?: string; limit: number }): Promise<LogPage> {
    const conditions: SQL[] = [eq(runLogEntriesTable.runId, runId)];
    if (opts.cursor) {
      const seq = Number(opts.cursor);
      if (!Number.isNaN(seq)) conditions.push(sql`${runLogEntriesTable.sequence} > ${seq}`);
    }
    const rows = await db
      .select()
      .from(runLogEntriesTable)
      .where(and(...conditions))
      .orderBy(runLogEntriesTable.sequence)
      .limit(opts.limit + 1);
    const items = rows.slice(0, opts.limit);
    const nextCursor = rows.length > opts.limit && items.length > 0 ? String(items[items.length - 1].sequence) : null;
    return { items, nextCursor };
  }

  async createAttempt(runId: string, input: { status: WorkloadRunAttempt["status"]; workerNodeId?: string; requestId?: string }): Promise<WorkloadRunAttempt> {
    return db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      const attempt = run.attemptCount + 1;
      const providerRunId = `provider-${randomUUID()}`;
      const checksum = sha256Hex(`${runId}|${attempt}|${providerRunId}|${input.status}|${input.workerNodeId ?? ""}|${input.requestId ?? ""}`);
      const [row] = await tx
        .insert(workloadRunAttemptsTable)
        .values({
          id: randomUUID(),
          runId,
          attempt,
          providerRunId,
          status: input.status,
          workerNodeId: input.workerNodeId ?? null,
          requestId: input.requestId ?? "",
          checksum,
          startedAt: new Date(),
        })
        .returning();
      await tx
        .update(workloadRunsTable)
        .set({ attemptCount: attempt, workerNodeId: input.workerNodeId ?? run.workerNodeId, ...(input.status === "starting" ? { status: "starting" as const } : {}) })
        .where(eq(workloadRunsTable.id, runId));
      await insertAudit(tx, { action: "attempt.created", runId, attemptId: row.id, requestId: input.requestId ?? "", detail: { attempt, providerRunId } });
      return row;
    });
  }

  async transitionAttempt(attemptId: string, status: WorkloadRunAttempt["status"], opts?: { errorReason?: string; requestId?: string }): Promise<WorkloadRunAttempt> {
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(workloadRunAttemptsTable).where(eq(workloadRunAttemptsTable.id, attemptId)).limit(1);
      const attempt = rows[0];
      if (!attempt) throw new NodeStoreError("NOT_FOUND", `Attempt ${attemptId} not found`);
      const checksum = sha256Hex(`${attempt.runId}|${attempt.attempt}|${attempt.providerRunId}|${status}|${opts?.errorReason ?? ""}|${opts?.requestId ?? ""}`);
      const [row] = await tx
        .update(workloadRunAttemptsTable)
        .set({ status, errorReason: opts?.errorReason ?? null, finishedAt: TERMINAL_STATUSES.has(status) ? new Date() : null, checksum })
        .where(eq(workloadRunAttemptsTable.id, attemptId))
        .returning();
      await insertAudit(tx, { action: `attempt.${status}`, runId: attempt.runId, attemptId, requestId: opts?.requestId ?? "" });
      return row;
    });
  }

  async recordAudit(input: AuditInput): Promise<AuditEvent> {
    return db.transaction(async (tx) => insertAudit(tx, input));
  }

  async getLocalNodeId(): Promise<string> {
    const rows = await db.select().from(localNodeIdentityTable).limit(1);
    return rows[0]?.nodeId ?? "local";
  }

  async listNodeIdentities(): Promise<StoredNodeIdentity[]> {
    const rows = await db
      .select({ nodeId: clusterNodesTable.id, publicKey: clusterNodesTable.publicKey })
      .from(clusterNodesTable);
    return rows.map((row) => ({ nodeId: row.nodeId, secretKey: row.publicKey ?? row.nodeId }));
  }

  async verifyRunLogIntegrity(runId: string): Promise<boolean> {
    const rows = await db
      .select()
      .from(runLogEntriesTable)
      .where(eq(runLogEntriesTable.runId, runId))
      .orderBy(runLogEntriesTable.sequence);
    return rows.every((row) => row.checksum === logEntryChecksum({ runId: row.runId, attempt: row.attempt, stream: row.stream, sequence: row.sequence, message: row.message, createdAt: row.createdAt }));
  }

  async checkIdempotency(actorId: string, clientRequestId: string, payloadHash: string): Promise<IdempotencyRecord | null> {
    const now = new Date();
    const rows = await db
      .select()
      .from(idempotencyKeysTable)
      .where(and(eq(idempotencyKeysTable.actorId, actorId), eq(idempotencyKeysTable.clientRequestId, clientRequestId), sql`${idempotencyKeysTable.expiresAt} > ${now}`))
      .limit(1);
    if (rows.length === 0) return null;
    const record = rows[0];
    if (record.payloadHash !== payloadHash) {
      throw new NodeStoreError("IDEMPOTENCY_CONFLICT", "Idempotency key reused with a different payload");
    }
    return { runId: record.runId, created: false };
  }

  async storeIdempotencyKey(actorId: string, clientRequestId: string, runId: string, payloadHash: string): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
    await db
      .insert(idempotencyKeysTable)
      .values({
        id: randomUUID(),
        actorId,
        clientRequestId,
        runId,
        payloadHash,
        expiresAt,
      })
      .onConflictDoNothing({ target: [idempotencyKeysTable.actorId, idempotencyKeysTable.clientRequestId] });
  }

  async cleanupExpiredIdempotencyKeys(): Promise<number> {
    const now = new Date();
    const result = await db.delete(idempotencyKeysTable).where(sql`${idempotencyKeysTable.expiresAt} <= ${now}`);
    return result.rowCount ?? 0;
  }

  async backupToFile(path: string): Promise<BackupManifest> {
    await mkdir(dirname(path), { recursive: true });
    const { execSync } = await import("node:child_process");
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new NodeStoreError("INTERNAL", "DATABASE_URL not set");
    }
    const dumpCommand = `pg_dump --no-owner --no-privileges --format=custom --file="${path}" "${databaseUrl}"`;
    execSync(dumpCommand, { stdio: "pipe" });
    const { statSync } = await import("node:fs");
    const stats = statSync(path);
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      tableCount: 13,
      rowCount: 0,
      checksum: sha256Hex(`${path}|${stats.size}|${stats.mtimeMs}`),
    };
    return manifest;
  }

  async restoreFromFile(path: string): Promise<BackupManifest> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new NodeStoreError("INTERNAL", "DATABASE_URL not set");
    }
    const { execSync } = await import("node:child_process");
    const restoreCommand = `pg_restore --clean --no-owner --no-privileges --dbname="${databaseUrl}" "${path}"`;
    execSync(restoreCommand, { stdio: "pipe" });
    const { statSync } = await import("node:fs");
    const stats = statSync(path);
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      tableCount: 13,
      rowCount: 0,
      checksum: sha256Hex(`${path}|${stats.size}|${stats.mtimeMs}`),
    };
    return manifest;
  }
}

async function lockRun(tx: Tx, runId: string): Promise<WorkloadRun> {
  const rows = await tx.select().from(workloadRunsTable).where(eq(workloadRunsTable.id, runId)).limit(1);
  const run = rows[0];
  if (!run) throw new NodeStoreError("NOT_FOUND", `Run ${runId} not found`);
  return run;
}

async function insertAudit(tx: Tx, input: AuditInput): Promise<AuditEvent> {
  const checksum = sha256Hex(`${input.action}|${input.runId ?? ""}|${input.attemptId ?? ""}|${input.requestId ?? ""}|${JSON.stringify(input.detail ?? {})}`);
  const [row] = await tx
    .insert(auditEventsTable)
    .values({
      id: randomUUID(),
      action: input.action,
      actorNodeId: input.actorNodeId ?? null,
      runId: input.runId ?? null,
      attemptId: input.attemptId ?? null,
      requestId: input.requestId ?? "",
      idempotencyKey: input.idempotencyKey ?? null,
      detail: input.detail ?? {},
      checksum,
    })
    .returning();
  return row;
}

function validateWorkloadCommand(cmd: SubmitRunCommand): void {
  try {
    if (cmd.mode === "diagnostic") {
      createRun(randomUUID(), createBuiltInDiagnosticWorkload());
    } else {
      if (!cmd.image) throw new NodeStoreError("INVALID_WORKLOAD", "Container workloads require an image");
      createRun(randomUUID(), createArbitraryContainerWorkload(cmd.image));
    }
  } catch (err) {
    if (err instanceof NodeStoreError) throw err;
    throw new NodeStoreError("INVALID_WORKLOAD", err instanceof Error ? err.message : "Invalid workload");
  }
}