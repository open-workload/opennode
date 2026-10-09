import { Router, type IRouter, type Response, type Request } from "express";
import {
  CancelRunResponse,
  GetRunLogsQueryParams,
  GetRunLogsResponse,
  GetRunResponse,
  ListRunsQueryParams,
  ListRunsResponse,
  PreflightRunBody,
  PreflightRunResponse,
  SubmitRunBody,
  SubmitRunResponse,
} from "@workspace/api-zod";
import {
  createArbitraryContainerWorkload,
  createBuiltInDiagnosticWorkload,
  createRun,
} from "@workspace/opennode-domain";
import { NodeStoreError } from "@workspace/node-store";
import { RunCoordinatorError, type RunSpec } from "@workspace/run-coordinator";
import { metricsRegistry } from "@workspace/observability";
import { executionProvider, nodeStore, acceptsNewAssignments, getRunCoordinator, subscribeToLogStream, emitLogEntry } from "../lib/runtime";
import { requestId, actorId } from "../middlewares/correlation";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function toRunSpec(body: {
  readonly name: string;
  readonly mode: "diagnostic" | "container";
  readonly image: string | null;
  readonly resources: RunSpec["resources"];
  readonly networkPolicy: RunSpec["networkPolicy"];
}): RunSpec {
  return {
    name: body.name,
    mode: body.mode === "diagnostic" ? "built-in-diagnostic" : "container",
    image: body.image,
    resources: body.resources,
    expectedOutputBytes: 0,
    secretRefs: [],
    requiredCapabilities: [],
    networkPolicy: body.networkPolicy,
    sideEffectClass: "at-least-once",
    tenantId: "default",
    projectId: "default",
  };
}

function handleCoordinatorError(res: Response, err: unknown, rid: string, clientKey?: string): boolean {
  if (!(err instanceof RunCoordinatorError)) return false;
  switch (err.code) {
    case "IDEMPOTENCY_CONFLICT":
      void nodeStore
        .recordAudit({ action: "run.submit.conflict", requestId: rid, idempotencyKey: clientKey, detail: { clientKey } })
        .catch(() => undefined);
      logger.warn({ requestId: rid, clientKey }, "idempotency conflict");
      res.status(409).json({ error: "Idempotency key reused with a different payload", code: "IDEMPOTENCY_CONFLICT" });
      return true;
    case "QUOTA_EXCEEDED":
      res.status(429).json({ error: err.message, code: "QUOTA_EXCEEDED" });
      return true;
    case "RUN_NOT_FOUND":
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return true;
    case "RUN_TERMINAL":
    case "RUN_NOT_RETRYABLE":
    case "INVALID_TRANSITION":
    case "LEASE_CONFLICT":
      res.status(409).json({ error: err.message, code: err.code });
      return true;
    case "INVALID_RUN_SPEC":
    case "IMAGE_POLICY_VIOLATION":
    case "SECRET_REF_VIOLATION":
    case "INVALID_SUBMISSION":
      res.status(400).json({ error: err.message, code: err.code });
      return true;
    default:
      res.status(409).json({ error: err.message, code: err.code });
      return true;
  }
}

router.get("/runs", async (req, res) => {
  const parsed = ListRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const page = await nodeStore.listRuns({ limit: parsed.data.limit, cursor: parsed.data.cursor, status: parsed.data.status });
    res.json(ListRunsResponse.parse({ items: page.items, nextCursor: page.nextCursor }));
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/runs", async (req, res) => {
  const parsed = SubmitRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workload specification", code: parsed.error.issues[0]?.message });
    return;
  }
  const rid = requestId(res);
  const actor = actorId(res) ?? await nodeStore.getLocalNodeId();
  const idempotencyKey = `${actor}:${parsed.data.clientRequestId}`;
  if (parsed.data.mode === "container") {
    logger.warn(
      { requestId: rid, actor, image: parsed.data.image },
      "container run rejected because no isolated worker backend is configured",
    );
    res.status(503).json({
      error: "Container execution is unavailable on this node. Only the safe diagnostic test runner is enabled.",
      code: "CONTAINER_BACKEND_UNAVAILABLE",
    });
    return;
  }
  try {
    if (!acceptsNewAssignments()) {
      res.status(409).json({ error: "This node is draining; new assignments are stopped.", code: "DRAINING" });
      return;
    }
    const coordinator = await getRunCoordinator();
    const { run, created } = await coordinator.submit({
      clientKey: idempotencyKey,
      actorId: actor,
      spec: toRunSpec(parsed.data),
      correlationId: rid,
      now: Date.now(),
    });
    metricsRegistry.increment("run_coordinator_submissions_total");
    logger.info({ requestId: rid, runId: run.runId, created, actor }, "run accepted");
    if (created) {
      try {
        const lease = await coordinator.acquireLease({ runId: run.runId, correlationId: rid, now: Date.now() });
        metricsRegistry.increment("run_coordinator_lease_grants_total");
        logger.info({ requestId: rid, runId: run.runId, leaseId: lease.leaseId, workerNodeId: lease.workerNodeId }, "lease acquired");
        const committed = (await coordinator.getState()).runs.find((r) => r.runId === run.runId);
        const dbRun = committed?.dbRunId ? await nodeStore.getRun(committed.dbRunId) : null;
        if (dbRun) {
          void executionProvider.startRun(dbRun, { requestId: rid }).catch((err) => logger.error({ err, runId: dbRun.id, requestId: rid }, "execution provider failed"));
        }
      } catch (leaseErr) {
        if (handleCoordinatorError(res, leaseErr, rid, idempotencyKey)) return;
        throw leaseErr;
      }
    }
    const committed = (await coordinator.getState()).runs.find((r) => r.runId === run.runId);
    const dbRun = committed?.dbRunId ? await nodeStore.getRun(committed.dbRunId) : null;
    if (!dbRun) {
      res.status(500).json({ error: "Run mirror unavailable", code: "INTERNAL" });
      return;
    }
    res.status(202).json(SubmitRunResponse.parse(dbRun));
  } catch (err) {
    if (err instanceof NodeStoreError && err.code === "IDEMPOTENCY_CONFLICT") {
      await nodeStore
        .recordAudit({ action: "run.submit.conflict", requestId: rid, idempotencyKey, detail: { name: parsed.data.name } })
        .catch(() => undefined);
      logger.warn({ requestId: rid, idempotencyKey }, "idempotency conflict");
      res.status(409).json({ error: "Idempotency key reused with a different payload", code: "IDEMPOTENCY_CONFLICT" });
      return;
    }
    if (handleCoordinatorError(res, err, rid, idempotencyKey)) return;
    handleError(res, err);
  }
});

router.post("/runs/preflight", async (req, res) => {
  const parsed = PreflightRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid workload specification", code: parsed.error.issues[0]?.message });
    return;
  }
  const checks: { id: string; label: string; status: "pass" | "warning" | "blocked"; detail: string }[] = [];

  let workloadValid = false;
  try {
    if (parsed.data.mode === "diagnostic") {
      createRun("preflight", createBuiltInDiagnosticWorkload());
    } else {
      if (!parsed.data.image) throw new Error("Container image is required");
      createRun("preflight", createArbitraryContainerWorkload(parsed.data.image));
    }
    workloadValid = true;
    checks.push({ id: "workload", label: "Workload specification", status: "pass", detail: "Workload validates against the domain contract." });
  } catch (err) {
    checks.push({ id: "workload", label: "Workload specification", status: "blocked", detail: err instanceof Error ? err.message : "Invalid" });
  }

  if (parsed.data.mode === "diagnostic") {
    checks.push({
      id: "execution",
      label: "Execution backend",
      status: "pass",
      detail: "The safe diagnostic test harness is available. It does not execute a user-supplied command or container.",
    });
    if (parsed.data.command.length > 0) {
      checks.push({ id: "command", label: "Command", status: "warning", detail: "Command is ignored for built-in diagnostic workloads." });
    }
    res.json(PreflightRunResponse.parse({ canSubmit: workloadValid, executionAvailable: true, executionMode: "built_in_diagnostic", checks }));
    return;
  }

  checks.push({
    id: "execution",
    label: "Execution backend",
    status: "blocked",
    detail: "Container runs are disabled because this deployment has no verified isolated worker backend.",
  });
  res.json(PreflightRunResponse.parse({
    canSubmit: false,
    executionAvailable: false,
    executionMode: "unavailable",
    checks,
  }));
});

router.get("/runs/logs", async (req, res) => {
  const parsed = GetRunLogsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const run = await nodeStore.getRun(parsed.data.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return;
    }
    const page = await nodeStore.getLogs(parsed.data.runId, { cursor: parsed.data.cursor, limit: parsed.data.limit });
    res.json(GetRunLogsResponse.parse({ items: page.items, nextCursor: page.nextCursor }));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/runs/logs/stream", async (req: Request, res: Response) => {
  const parsed = GetRunLogsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const run = await nodeStore.getRun(parsed.data.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return;
    }
    const follow = req.query.follow === "true";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let cancelled = false;

    const cleanup = subscribeToLogStream(parsed.data.runId, (entry) => {
      if (cancelled) return;
      const data = JSON.stringify({
        sequence: entry.sequence,
        attempt: entry.attempt,
        stream: entry.stream,
        message: entry.message,
        timestamp: entry.timestamp,
      });
      res.write(`data: ${data}\n\n`);
    });

    req.on("close", () => {
      cancelled = true;
      cleanup();
    });
  } catch (err) {
    handleError(res, err);
  }
});

const artifactStore = new Map<string, { data: Uint8Array; metadata: { runId: string; attemptId?: string; name: string; size: number } }>();

router.get("/runs/artifacts", async (req, res) => {
  const { runId, attemptId } = req.query;
  if (!runId || typeof runId !== "string") {
    res.status(400).json({ error: "runId is required", code: "INVALID_QUERY" });
    return;
  }
  try {
    const run = await nodeStore.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return;
    }
    const chunks = Array.from(artifactStore.entries())
      .filter(([, v]) => v.metadata.runId === runId)
      .map(([chunkId, v]) => ({ chunkId, ...v.metadata }));
    res.json({ items: chunks, nextCursor: null });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/runs/artifacts/:chunkId", async (req, res) => {
  try {
    const entry = artifactStore.get(req.params.chunkId);
    if (!entry) {
      res.status(404).json({ error: "Artifact not found", code: "NOT_FOUND" });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.chunkId}"`);
    res.send(Buffer.from(entry.data));
  } catch (err) {
    handleError(res, err);
  }
});

export function storeArtifact(runId: string, attemptId: string | undefined, name: string, data: Uint8Array): string {
  const chunkId = `artifact-${runId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  artifactStore.set(chunkId, { data, metadata: { runId, attemptId, name, size: data.length } });
  return chunkId;
}

router.get("/runs/:runId", async (req, res) => {
  try {
    const run = await nodeStore.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return;
    }
    res.json(GetRunResponse.parse(run));
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/runs/:runId/cancel", async (req, res) => {
  const rid = requestId(res);
  try {
    const coordinator = await getRunCoordinator();
    const state = await coordinator.getState();
    const coordRun = state.runs.find(
      (r) => r.dbRunId === req.params.runId || r.runId === req.params.runId,
    );
    if (coordRun !== undefined) {
      await coordinator.cancel({
        runId: coordRun.runId,
        cancelledBy: "local",
        correlationId: rid,
        now: Date.now(),
      });
      logger.info({ requestId: rid, runId: coordRun.runId }, "run cancel requested");
      const committed = (await coordinator.getState()).runs.find((r) => r.runId === coordRun.runId);
      const dbRun = committed?.dbRunId ? await nodeStore.getRun(committed.dbRunId) : null;
      if (dbRun) {
        void executionProvider.cancelRun(dbRun.id, { requestId: rid }).catch((err) => logger.error({ err, runId: dbRun.id, requestId: rid }, "provider cancel failed"));
        res.status(202).json(CancelRunResponse.parse(dbRun));
        return;
      }
    }
    const updated = await nodeStore.requestCancel(req.params.runId, rid);
    logger.info({ requestId: rid, runId: updated.id }, "run cancel requested");
    void executionProvider.cancelRun(updated.id, { requestId: rid }).catch((err) => logger.error({ err, runId: updated.id, requestId: rid }, "provider cancel failed"));
    res.status(202).json(CancelRunResponse.parse(updated));
  } catch (err) {
    if (err instanceof NodeStoreError && err.code === "NOT_FOUND") {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return;
    }
    if (err instanceof NodeStoreError && err.code === "INVALID_TRANSITION") {
      res.status(409).json({ error: "Run is already terminal", code: "INVALID_TRANSITION" });
      return;
    }
    if (handleCoordinatorError(res, err, rid)) return;
    handleError(res, err);
  }
});

router.post("/runs/:runId/retry", async (req, res) => {
  const rid = requestId(res);
  try {
    const coordinator = await getRunCoordinator();
    const state = await coordinator.getState();
    const coordRun = state.runs.find(
      (r) => r.dbRunId === req.params.runId || r.runId === req.params.runId,
    );
    if (coordRun === undefined) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND" });
      return;
    }
    await coordinator.retry({
      runId: coordRun.runId,
      retryBy: "local",
      correlationId: rid,
      now: Date.now(),
    });
    logger.info({ requestId: rid, runId: coordRun.runId }, "run retry requested");
    const lease = await coordinator.acquireLease({
      runId: coordRun.runId,
      correlationId: rid,
      now: Date.now(),
    });
    metricsRegistry.increment("run_coordinator_lease_grants_total");
    logger.info({ requestId: rid, runId: coordRun.runId, leaseId: lease.leaseId, workerNodeId: lease.workerNodeId }, "lease acquired");
    const committed = (await coordinator.getState()).runs.find((r) => r.runId === coordRun.runId);
    const dbRun = committed?.dbRunId ? await nodeStore.getRun(committed.dbRunId) : null;
    if (!dbRun) {
      res.status(500).json({ error: "Run mirror unavailable", code: "INTERNAL" });
      return;
    }
    void executionProvider.startRun(dbRun, { requestId: rid }).catch((err) => logger.error({ err, runId: dbRun.id, requestId: rid }, "execution provider failed"));
    res.status(202).json(GetRunResponse.parse(dbRun));
  } catch (err) {
    if (handleCoordinatorError(res, err, rid)) return;
    handleError(res, err);
  }
});

router.post("/runs/reconcile", async (req, res) => {
  const rid = requestId(res);
  try {
    const body = (req.body ?? {}) as {
      now?: unknown;
      lostWorkers?: unknown;
      providerOutageWorkers?: unknown;
    };
    const now = typeof body.now === "number" && Number.isFinite(body.now) ? body.now : Date.now();
    const toWorkerList = (value: unknown): readonly string[] | undefined =>
      Array.isArray(value) && value.every((v) => typeof v === "string")
        ? (value as string[])
        : undefined;
    const lostWorkers = toWorkerList(body.lostWorkers);
    const providerOutageWorkers = toWorkerList(body.providerOutageWorkers);
    const coordinator = await getRunCoordinator();
    const summary = await coordinator.reconcile({
      now,
      ...(lostWorkers !== undefined ? { lostWorkers } : {}),
      ...(providerOutageWorkers !== undefined ? { providerOutageWorkers } : {}),
    });
    const state = await coordinator.sync();
    logger.info({ requestId: rid, fencedAttemptCount: summary.fencedAttemptCount }, "run state reconciled");
    res.json({
      fencedAttemptCount: summary.fencedAttemptCount,
      fencedAttempts: summary.fencedAttempts,
      appliedSequence: state.appliedSequence,
      runCount: state.runs.length,
      attemptCount: state.attempts.length,
    });
  } catch (err) {
    if (handleCoordinatorError(res, err, rid)) return;
    handleError(res, err);
  }
});

function handleError(res: Response, err: unknown): void {
  logger.error({ err }, "request failed");
  res.status(500).json({ error: "Internal error", code: "INTERNAL" });
}

export default router;
