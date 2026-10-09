import { Router, type IRouter } from "express";
import { renderMetrics } from "@workspace/observability";

const router: IRouter = Router();

router.get("/metrics", (_req, res): void => {
  res.setHeader("Content-Type", "text/plain");
  res.send(renderMetrics());
});

export default router;
