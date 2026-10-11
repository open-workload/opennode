import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";

const mocks = vi.hoisted(() => ({
  containerExecutionAvailable: true,
  executionProvider: { startRun: vi.fn(), cancelRun: vi.fn() },
  nodeStore: {
    getRun: vi.fn(),
    getLocalNodeId: vi.fn(),
    recordAudit: vi.fn(),
  },
  acceptsNewAssignments: vi.fn(),
  getRunCoordinator: vi.fn(),
  subscribeToLogStream: vi.fn(),
  emitLogEntry: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  get containerExecutionAvailable() {
    return mocks.containerExecutionAvailable;
  },
  executionProvider: mocks.executionProvider,
  nodeStore: mocks.nodeStore,
  acceptsNewAssignments: mocks.acceptsNewAssignments,
  getRunCoordinator: mocks.getRunCoordinator,
  subscribeToLogStream: mocks.subscribeToLogStream,
  emitLogEntry: mocks.emitLogEntry,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import runsRouter from "./runs";

const IMAGE = `busybox:1.35@sha256:${"a".repeat(64)}`;

type Mode = "diagnostic" | "container";

function validBody(mode: Mode, image: string | null = mode === "container" ? IMAGE : null) {
  return {
    clientRequestId: "client-req-1",
    name: mode === "container" ? "container-run" : "diagnostic-run",
    mode,
    image,
    command: mode === "container" ? ["/bin/true"] : [],
    resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
    networkPolicy: "deny_all",
  };
}

const dbRun = {
  id: "r1",
  clientRequestId: "node-local:client-req-1",
  name: "container-run",
  mode: "container",
  image: IMAGE,
  imageDigest: `sha256:${"a".repeat(64)}`,
  command: ["/bin/true"],
  status: "queued",
  executionMode: "isolated_worker",
  submittedBy: "node-local",
  submittedViaNodeId: "node-local",
  workerNodeId: "node-local",
  attemptCount: 0,
  resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
  networkPolicy: "deny_all",
  failureReason: null,
  createdAt: new Date("2026-01-02T03:04:05.000Z"),
  updatedAt: new Date("2026-01-02T03:04:05.000Z"),
};

interface PreflightBody {
  canSubmit: boolean;
  executionAvailable: boolean;
  executionMode: string;
  checks: { id: string; label: string; status: string; detail: string }[];
}

let server: Server;
let baseUrl: string;

let coordinatorMock: {
  submit: ReturnType<typeof vi.fn>;
  acquireLease: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
};

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(runsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.containerExecutionAvailable = true;
  mocks.acceptsNewAssignments.mockReturnValue(true);
  mocks.nodeStore.getLocalNodeId.mockResolvedValue("node-local");
  mocks.nodeStore.getRun.mockResolvedValue(dbRun);
  mocks.nodeStore.recordAudit.mockResolvedValue({});
  mocks.executionProvider.startRun.mockResolvedValue(undefined);
  mocks.executionProvider.cancelRun.mockResolvedValue(undefined);
  coordinatorMock = {
    submit: vi.fn().mockResolvedValue({ run: { runId: "run-1" }, created: true }),
    acquireLease: vi.fn().mockResolvedValue({ leaseId: "lease-1", workerNodeId: "node-local" }),
    getState: vi.fn().mockResolvedValue({ runs: [{ runId: "run-1", dbRunId: "r1" }] }),
  };
  mocks.getRunCoordinator.mockResolvedValue(coordinatorMock);
});

describe("runs routes", () => {
  it("POST /runs accepts a container run and returns the mirrored run", async () => {
    const res = await post("/runs", validBody("container"));
    expect(res.status).toBe(202);

    const body = (await res.json()) as { id: string; mode: string; executionMode: string };
    expect(body.id).toBe("r1");
    expect(body.mode).toBe("container");
    expect(body.executionMode).toBe("isolated_worker");
    expect(coordinatorMock.submit).toHaveBeenCalledTimes(1);
    expect(mocks.executionProvider.startRun).toHaveBeenCalledTimes(1);
  });

  it("POST /runs accepts container mode even when no isolated backend is configured", async () => {
    mocks.containerExecutionAvailable = false;

    const res = await post("/runs", validBody("container"));
    expect(res.status).not.toBe(503);
    expect(res.status).toBe(202);
    expect(coordinatorMock.submit).toHaveBeenCalledTimes(1);
  });

  it("POST /runs still accepts the safe diagnostic mode", async () => {
    mocks.nodeStore.getRun.mockResolvedValue({
      ...dbRun,
      mode: "diagnostic",
      image: null,
      imageDigest: null,
      command: [],
      executionMode: "built_in_diagnostic",
    });

    const res = await post("/runs", validBody("diagnostic"));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { executionMode: string };
    expect(body.executionMode).toBe("built_in_diagnostic");
  });

  it("POST /runs/preflight reports an isolated worker when a rootless backend is configured", async () => {
    mocks.containerExecutionAvailable = true;

    const res = await post("/runs/preflight", validBody("container"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as PreflightBody;
    expect(body.executionAvailable).toBe(true);
    expect(body.executionMode).toBe("isolated_worker");
    expect(body.canSubmit).toBe(true);
    expect(body.checks.find((c) => c.id === "execution")?.status).toBe("pass");
  });

  it("POST /runs/preflight blocks container execution when no isolated backend is configured", async () => {
    mocks.containerExecutionAvailable = false;

    const res = await post("/runs/preflight", validBody("container"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as PreflightBody;
    expect(body.executionAvailable).toBe(false);
    expect(body.executionMode).toBe("unavailable");
    expect(body.canSubmit).toBe(false);
    expect(body.checks.find((c) => c.id === "execution")?.status).toBe("blocked");
  });

  it("POST /runs/preflight still blocks a container workload without an image", async () => {
    mocks.containerExecutionAvailable = true;

    const res = await post("/runs/preflight", validBody("container", null));
    expect(res.status).toBe(200);

    const body = (await res.json()) as PreflightBody;
    expect(body.canSubmit).toBe(false);
    expect(body.checks.find((c) => c.id === "workload")?.status).toBe("blocked");
  });

  it("POST /runs/preflight keeps the safe diagnostic verdict (regression)", async () => {
    const res = await post("/runs/preflight", validBody("diagnostic"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as PreflightBody;
    expect(body.executionAvailable).toBe(true);
    expect(body.executionMode).toBe("built_in_diagnostic");
    expect(body.canSubmit).toBe(true);
  });
});
