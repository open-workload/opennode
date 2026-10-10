import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";

vi.mock("../lib/runtime", async () => {
  const { FeatureFlags } = await import("@workspace/feature-flags");
  const featureFlags = new FeatureFlags({ enableKillSwitch: true });
  return {
    featureFlags,
    getFeatureFlags: () => featureFlags,
  };
});

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { getFeatureFlags } = await import("../lib/runtime");
const flagsRouter = (await import("./flags")).default;

let server: Server;
let baseUrl: string;

async function postFlags(flags: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/flags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flags }),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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
    const activated = await fetch(`${baseUrl}/flags/kill-switch/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "incident", activatedBy: "operator" }),
    });
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
});
