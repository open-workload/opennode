import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";

const mocks = vi.hoisted(() => ({
  nodeStore: { recordAudit: vi.fn() },
  getGovernance: vi.fn(),
}));

vi.mock("../lib/runtime", async () => {
  const { FeatureFlags } = await import("@workspace/feature-flags");
  const featureFlags = new FeatureFlags({ enableKillSwitch: true });
  return {
    featureFlags,
    getFeatureFlags: () => featureFlags,
    nodeStore: mocks.nodeStore,
    getGovernance: mocks.getGovernance,
  };
});

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { getFeatureFlags } = await import("../lib/runtime");
const flagsRouter = (await import("./flags")).default;

let server: Server;
let baseUrl: string;
let currentRoles: string[] = ["admin"];

async function postFlags(flags: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/flags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flags }),
  });
}

async function postKillSwitch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/flags/kill-switch/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { auth?: unknown }).auth = {
      userId: "user_test",
      sessionId: "session_test",
      actorId: "user_test",
      claims: { roles: currentRoles },
    };
    next();
  });
  app.use(flagsRouter);
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
  currentRoles = ["admin"];
  mocks.nodeStore.recordAudit.mockReset();
  mocks.nodeStore.recordAudit.mockResolvedValue({});
  mocks.getGovernance.mockReset();
  mocks.getGovernance.mockResolvedValue({ eventLog: { getHeight: vi.fn(async () => 7) } });
  const flags = getFeatureFlags();
  flags.applyOverrides({ "execution.max_concurrent_runs": 8, "execution.new_runs_enabled": true });
  if (flags.getKillSwitch().isEnabled()) {
    flags.deactivateKillSwitch();
  }
});

describe("flags routes", () => {
  it("POST /flags override is observable through the shared runtime featureFlags", async () => {
    const res = await postFlags({ "execution.max_concurrent_runs": 4 });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { flags: Record<string, unknown> };
    expect(body.flags["execution.max_concurrent_runs"]).toBe(4);
    expect(getFeatureFlags().getMaxConcurrentRuns()).toBe(4);
  });

  it("GET /flags reflects a previously applied override", async () => {
    await postFlags({ "execution.new_runs_enabled": false });

    const res = await fetch(`${baseUrl}/flags`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flags: Record<string, unknown> };
    expect(body.flags["execution.new_runs_enabled"]).toBe(false);
    expect(getFeatureFlags().isNewExecutionAllowed()).toBe(false);
  });

  it("an override via POST /flags preserves kill-switch state", async () => {
    const activated = await postKillSwitch("activate", { reason: "incident", activatedBy: "operator" });
    expect(activated.status).toBe(200);

    const res = await postFlags({ "execution.max_concurrent_runs": 16 });
    expect(res.status).toBe(200);
    expect(getFeatureFlags().getKillSwitch().isEnabled()).toBe(true);
    expect(getFeatureFlags().isNewExecutionAllowed()).toBe(false);
  });

  it("rejects an override value outside the flag's allowed values", async () => {
    const res = await postFlags({ "execution.max_concurrent_runs": 5 });
    expect(res.status).toBe(400);
    expect(getFeatureFlags().getMaxConcurrentRuns()).toBe(8);
  });

  it("activation writes an audit row with actor, reason, timestamp, and committed log height", async () => {
    const res = await postKillSwitch("activate", { reason: "incident-42", activatedBy: "alice" });
    expect(res.status).toBe(200);

    expect(mocks.getGovernance).toHaveBeenCalledOnce();
    expect(mocks.nodeStore.recordAudit).toHaveBeenCalledTimes(1);
    expect(mocks.nodeStore.recordAudit).toHaveBeenCalledWith({
      action: "kill_switch.activated",
      actorNodeId: "user_test",
      requestId: expect.any(String),
      detail: {
        actor: "user_test",
        reason: "incident-42",
        activatedBy: "alice",
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        logHeight: 7,
      },
    });
  });

  it("deactivation writes an audit row with actor, reason, timestamp, and committed log height", async () => {
    const activated = await postKillSwitch("activate", { reason: "incident-42", activatedBy: "alice" });
    expect(activated.status).toBe(200);

    const res = await postKillSwitch("deactivate", { reason: "incident resolved" });
    expect(res.status).toBe(200);
    expect(getFeatureFlags().getKillSwitch().isEnabled()).toBe(false);

    expect(mocks.nodeStore.recordAudit).toHaveBeenCalledTimes(2);
    expect(mocks.nodeStore.recordAudit.mock.calls[1]?.[0]).toEqual({
      action: "kill_switch.deactivated",
      actorNodeId: "user_test",
      requestId: expect.any(String),
      detail: {
        actor: "user_test",
        reason: "incident resolved",
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        logHeight: 7,
      },
    });
  });

  it("denies flag mutation, kill-switch activation, and reads below the required role", async () => {
    currentRoles = ["operator"];
    const deniedOverride = await postFlags({ "execution.max_concurrent_runs": 4 });
    expect(deniedOverride.status).toBe(403);
    expect(await deniedOverride.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(getFeatureFlags().getMaxConcurrentRuns()).toBe(8);

    currentRoles = ["viewer"];
    const deniedActivate = await postKillSwitch("activate", { reason: "incident-42", activatedBy: "alice" });
    expect(deniedActivate.status).toBe(403);
    expect(await deniedActivate.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(getFeatureFlags().getKillSwitch().isEnabled()).toBe(false);

    currentRoles = [];
    const deniedRead = await fetch(`${baseUrl}/flags`);
    expect(deniedRead.status).toBe(403);
    expect(await deniedRead.json()).toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.nodeStore.recordAudit).not.toHaveBeenCalled();
  });
});
