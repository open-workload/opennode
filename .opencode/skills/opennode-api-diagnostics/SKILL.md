---
name: opennode-api-diagnostics
description: Debug OpenNode API failures on the Replit preview (404/401/500, "Failed to fetch", blank UI panels, "Preflight request failed"). Use when the browser shows a fetch/network error or empty dashboard, when a route returns 404 even though it exists in openapi.yaml, or when correlating api-server workflow logs with the live Postgres.
---

# OpenNode API diagnostics

Procedure for finding why the OpenNode web app (`artifacts/opennode`) shows
errors or blank panels against the Express API (`artifacts/api-server`).

## 1. Read the live API logs first (do not guess)

Replit writes each workflow's stdout here:

```
.local/state/workflow-logs/<logId>/artifacts_api-server__api_server.shell.exec.0
.local/state/workflow-logs/<logId>/artifacts_opennode__web.shell.exec.0
```

Find the newest api-server log and summarise it — the status/URL histogram is
usually enough to name the bug:

```bash
L=$(ls -t .local/state/workflow-logs/*/artifacts_api-server__api_server.shell.exec.0 | head -1)
grep -o '"statusCode": [0-9]*' "$L" | sort | uniq -c
grep -o '"url": "[^"]*"' "$L" | sort | uniq -c
grep -n -B18 "request errored" "$L"   # 5xx blocks with the req id/url
```

- `pino-http` logs `request completed` for every response and `request errored`
  for 5xx. A 500 that does **not** log `request failed` came from a direct
  `res.status(500)` in a route, not from `handleError`.
- **401 vs 404 tells you where it failed.** `app.ts` mounts `authMiddleware`
  *before* the routers, so an unauthenticated request to ANY `/api/*` route
  returns 401. A **404 from an authenticated browser** means the Clerk session
  passed and no route matched → the route is missing/not registered.
- An authenticated actor in the log (e.g. `actor: "user_..."`) confirms the
  browser session works; do not go down the CORS/cookie path.

## 2. Detect OpenAPI-spec vs implemented-routes drift

The web client is generated from `lib/api-spec/openapi.yaml`, so the UI can call
endpoints the server never implemented. Compare the spec paths to the registered
routes:

```bash
grep -nE '^  /' lib/api-spec/openapi.yaml                       # spec paths
grep -rn 'router\.\(get\|post\|put\|delete\)(' artifacts/api-server/src/routes/
```

If a spec path is absent from `routes/`, it will 404 for authenticated users.
Implement it, then register the router in `artifacts/api-server/src/routes/index.ts`
(`router.use(...)`). That aggregate router is mounted at `/api` **behind auth**
(`app.ts:61`); `healthRouter` is the only unauthenticated mount. Register route
paths WITHOUT the `/api` prefix.

## 3. Correlate with the live database (read-only smoke)

The unit suite has no Postgres, so DB SQL is only truly proven against the live
`DATABASE_URL` (already set in this host's shell). Write a throwaway `.ts` at the
repo root, run with `pnpm exec tsx`, then delete it:

```ts
// .tmp-smoke.ts  — run: pnpm exec tsx .tmp-smoke.ts
import { DrizzleNodeStore } from "@workspace/node-store";
import { ListNodesResponse } from "@workspace/api-zod";
async function main() {
  const store = new DrizzleNodeStore();
  console.log(ListNodesResponse.parse(await store.listNodes()).length);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

**Gotcha:** `pnpm exec tsx` compiles to CJS here — **top-level `await` fails** with
`Top-level await is currently not supported with the "cjs" output format`. Always
wrap in an `async main()`.

Validate the real rows through the generated zod validators (`@workspace/api-zod`)
so you prove the response contract, not just that the query ran.

## 4. Restart is required after server changes

The api-server workflow runs `dev` = `build && start` (a one-shot process). Editing
source does NOT reload it — the preview keeps serving the old build until the
api-server workflow is restarted.

## Known repo-specific traps

- `GET /api/dashboard/summary`, `/api/nodes`, `/api/activity` were defined in the
  spec and generated client but never implemented (fixed 2026-10-09).
- `POST /api/runs` returns `500 {"error":"Run mirror unavailable"}` when
  `RunCoordinator.mirrorNodeStore()` no-ops because `getRunCoordinator()` in
  `artifacts/api-server/src/lib/runtime.ts` did not pass the `nodeStore` dependency
  (fixed by adding `nodeStore,` to the coordinator deps).
- `cluster_nodes` can be empty even though a local identity exists; the Peer
  network panel then renders its empty state, not an error.
- No DB test harness exists; route tests mock `../lib/runtime`. A root
  `vitest.config.ts` `setupFiles` (`artifacts/api-server/src/test-setup.ts`) sets a
  dummy `DATABASE_URL` so importing `@workspace/db` does not throw.
