---
name: opennode-local-dev-stack
description: Starts and verifies the OpenNode local dev stack — run locally by starting the api-server dev server on 8080, opennode on 20557, and mockup-sandbox on 8081 with the PORT, BASE_PATH, and DATABASE_URL each entrypoint throws on, then confirming each surface serves including the /api/healthz probe. Use when running the stack locally, restarting a dev server after an edit, or triaging a startup crash caused by a missing env var.
---

# OpenNode local dev stack

Procedure for bringing the three Replit artifacts up locally and proving each
surface is actually serving. For **why a running surface returns errors**
(401/404/500, "Failed to fetch", blank panels), use the separate
`opennode-api-diagnostics` skill.

Ports come from `.replit` `[[ports]]`: 8080 → external 80, 8081 → external 3000,
20557 → external 3001.

## 1. Set the env BEFORE starting anything

These throw at startup; they are not warnings. Set them in the same command that
starts the artifact.

| Artifact | Required | Exact throw if missing |
| --- | --- | --- |
| `artifacts/api-server` | `PORT`, `DATABASE_URL` | `PORT environment variable is required but was not provided.` (`src/index.ts:8`) |
| `artifacts/opennode` | `PORT`, `BASE_PATH` | `PORT environment variable is required but was not provided.` / `BASE_PATH environment variable is required but was not provided.` (`vite.config.ts:12,26`) |
| `artifacts/mockup-sandbox` | `PORT`, `BASE_PATH` | same two strings (`vite.config.ts:12,26`) |

Full strings, verbatim from source:

- `PORT environment variable is required but was not provided.`
- `BASE_PATH environment variable is required but was not provided.`
- `DATABASE_URL must be set. Did you forget to provision a database?` (`lib/db/src/index.ts:9`, thrown at import time)
- `DATABASE_URL, ensure the database is provisioned` (`lib/db/drizzle.config.ts:5`)

A non-numeric or non-positive value throws `Invalid PORT value: "<value>"`
(`artifacts/api-server/src/index.ts:15`, both vite configs).

**`DATABASE_URL` is a boot requirement for api-server, not just a request-time
one.** `app.ts` imports `routes/index.ts`, whose routers import `../lib/runtime`,
which imports `@workspace/node-store` → `@workspace/db` → `lib/db/src/index.ts`.
The throw happens during module load, so a missing `DATABASE_URL` crashes
`dev` before Express ever listens — even though only `/api/healthz` is public.
`.replit` loads `postgresql-16`, and `DATABASE_URL` is already exported in this
workspace's shell, so the commands below pass it through explicitly only to stay
correct if you run them somewhere else.

## 2. Start each artifact

The commands are exactly the `[services.development].run` values from each
`.replit-artifact/artifact.toml`.

```bash
# api-server -> http://localhost:8080/api
PORT=8080 DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/api-server run dev

# opennode web app -> http://localhost:20557/
PORT=20557 BASE_PATH=/ pnpm --filter @workspace/opennode run dev

# mockup-sandbox -> http://localhost:8081/__mockup/
PORT=8081 BASE_PATH=/__mockup pnpm --filter @workspace/mockup-sandbox run dev
```

Path prefixes come from `previewPath` in the same `artifact.toml` (`/api`,
`/`, `/__mockup`). They are not optional — `BASE_PATH` is what makes vite serve
assets under that prefix.

`mockup-sandbox`'s `dev` script is bare `vite dev`, so it relies on vite
auto-discovering `vite.config.ts` from the package directory (which
`pnpm --filter` sets as cwd). `opennode` passes `--config vite.config.ts`
explicitly.

## 3. Confirm each surface is serving

**api-server — the startup probe.** `/api/healthz` is mounted at `app.ts:60`
*before* `authMiddleware`, so it is the one public route:

```bash
curl -fsS http://localhost:8080/api/healthz   # -> {"status":"ok"}
```

The same path is the artifact's `[services.production.health.startup] path` in
`artifact.toml`. `HealthCheckResponse` is `{ status: string }`, so `{"status":"ok"}`
is the entire success body.

**api-server — `/metrics` is NOT a liveness probe.** `metricsRouter` is mounted
at `app.ts:61` *behind* `authMiddleware`:

```bash
curl -i http://localhost:8080/api/metrics
```

An unauthenticated 401 here is correct and proves auth is wired. Any other
`/api/*` path returning 401 instead of 404 is also expected for the same reason —
use `opennode-api-diagnostics` to interpret that.

**opennode:**

```bash
curl -fsSI http://localhost:20557/   # 200 + index.html
```

**mockup-sandbox** serves under `BASE_PATH`, so the bare root will not serve the app:

```bash
curl -fsSI http://localhost:8081/__mockup/   # 200
```

A blank page at `http://localhost:8081/` is the wrong URL, not a broken server.

## 4. api-server `dev` is a one-shot build-and-run, not a watcher

Confirmed in `artifacts/api-server/package.json`:

```json
"dev":   "export NODE_ENV=development && pnpm run build && pnpm run start",
"build": "node ./build.mjs",
"start": "node --enable-source-maps ./dist/index.mjs"
```

esbuild bundles once, then node runs the bundle. **Editing anything under
`artifacts/api-server/src/` has no effect until you restart the process** — the
served build is `dist/index.mjs`. There is no watch flag in this script.

To restart after an edit: `Ctrl-C` the running process and re-run the same
command. The build step is fast enough to just re-run `dev`; to skip the
`NODE_ENV=development` wrapper and loop tighter, run the two scripts that already
exist:

```bash
pnpm --filter @workspace/api-server run build && PORT=8080 DATABASE_URL="$DATABASE_URL" pnpm --filter @workspace/api-server run start
```

Only api-server is one-shot. `opennode` and `mockup-sandbox` run `vite dev`, which
does hot-reload — restart them only for `vite.config.ts` or dependency changes.

## 5. When it is up but still failing

If the ports answer and the env throws are gone but you are seeing 401/404/500,
`Failed to fetch`, empty panels, or spec-vs-route drift, switch to
`opennode-api-diagnostics`. This skill stops at "the surface is serving"; that
skill covers diagnosing what it returns.