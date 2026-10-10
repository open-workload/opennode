/**
 * Express app assembly. Order is the contract: logging, the Clerk proxy,
 * parsers, then Clerk session resolution, then the guarded API surface.
 *
 *   req ─▶ pino-http ─▶ CLERK_PROXY_PATH (raw body, pre-parser) ─▶ helmet
 *     ─▶ correlation ─▶ json/urlencoded ─▶ clerkMiddleware (publishable key
 *        chosen per Host) ─▶ /api/health (public) or
 *        authMiddleware ─▶ sameOriginWriteGuard ─▶ correlation ─▶ metrics ─▶ router
 *
 *   Any guard that answers ─▶ 401 / 403 and stops here; no route ever runs.
 */

import express, { type Express } from "express";
import helmet from "helmet";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import healthRouter from "./routes/health";
import metricsRouter from "./routes/metrics";
import { logger } from "./lib/logger";
import { correlationMiddleware } from "./middlewares/correlation";
import { authMiddleware } from "./middlewares/auth";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { sameOriginWriteGuard } from "./middlewares/sameOriginWriteGuard";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Clerk's Frontend API proxy must run before parsers, which may consume its raw
// request body. It is a no-op in development and enabled by the canonical
// middleware in production.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(correlationMiddleware);
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "32kb", parameterLimit: 100 }));
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// The user interface and API share the artifact's origin, so credentialed
// wildcard CORS is unnecessary. Health is public; every other API route uses
// Clerk session-cookie or Clerk-verified bearer authentication.
app.use("/api", healthRouter);
app.use("/api", authMiddleware, sameOriginWriteGuard, correlationMiddleware, metricsRouter, router);

export default app;
