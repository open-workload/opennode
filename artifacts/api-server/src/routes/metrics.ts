import { Router, type IRouter } from "express";
import { renderMetrics } from "@workspace/observability";

const router: IRouter = Router();

// OPS-03: the production binding is renderMetrics, the real Prometheus text
// exporter driven by the in-process metricsRegistry singleton. The no-op
// MetricsExporter is never bound into this path.
const exporter = renderMetrics;

router.get("/metrics", (_req, res): void => {
  res.setHeader("Content-Type", "text/plain");
  res.send(exporter());
});

export default router;
