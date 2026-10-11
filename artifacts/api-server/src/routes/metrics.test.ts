import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { metricsRegistry } from "@workspace/observability";

const metricsRouter = (await import("./metrics")).default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(metricsRouter);
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

describe("metrics route", () => {
  it("GET /metrics serves Prometheus text/plain containing an emitted alert-rule metric", async () => {
    metricsRegistry.set("content_store.orphan_cleanup_errors", 3);

    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("# TYPE content_store.orphan_cleanup_errors gauge");
    expect(body).toContain("content_store.orphan_cleanup_errors 3");
  });

  it("GET /metrics always exposes the registry's label-drop counter", async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# TYPE metric_label_dropped_total counter");
  });
});