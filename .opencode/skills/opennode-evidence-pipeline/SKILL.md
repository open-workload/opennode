---
name: opennode-evidence-pipeline
description: Run and extend the OpenNode verification pipeline — pnpm run typecheck, pnpm test (vitest), and pnpm run check:ci guards — and add release-gate evidence. Use when a todo.md requirement needs a named runnable test, when CI fails, when adding a test, or when wiring a PROV-03/RUN-22/OPS-20 guard.
---

# OpenNode evidence pipeline

The repo's rule (`todo.md` "Gate evidence", `docs/release-gates.md`) is: a gate
is VERIFIED only with a named runnable test, the command to reproduce it, and a
commit SHA. Source-code reading is not evidence. This skill is the exact
procedure for producing that evidence.

## The three commands

```bash
pnpm run typecheck   # tsc --build for libs, then leaf artifact/script tsc --noEmit
pnpm test            # vitest run at the workspace root
pnpm run check:ci    # tsx scripts/src/ci-checks/index.ts (PROV-03 / RUN-22 / OPS-20)
```

All three must exit 0 before a slice is reported done. CI runs the same three in
that order (`.github/workflows/ci.yml`).

## Test layout and runner

- Runner: `vitest` (declared at the root). Config: `vitest.config.ts`.
- Test files are **colocated** and named `*.test.ts`:
  `lib/*/src/**/*.test.ts`, `artifacts/*/src/**/*.test.ts`,
  `scripts/**/*.test.ts`.
- `tsconfig.base.json` has `"exclude": ["**/*.test.ts", ...]` so composite
  `tsc --build` does not emit declarations for tests. **Caveat:** a package
  tsconfig that declares its own `exclude` replaces the inherited base exclude.
  If you add a test file to such a package and typecheck complains, either scope
  the package `exclude` to also drop `**/*.test.ts` or move the test.
- Run one file fast: `pnpm exec vitest run <path/to/file.test.ts>`.

## CI guards (`scripts/src/ci-checks/`)

`pnpm run check:ci` runs three deterministic, network-free source guards:

- `unused-symbols.ts` — PROV-03. A registry of required symbols (identifier +
  defining file + call pattern). Fails when a required symbol has zero non-test
  call sites, when a new required symbol is not allowlisted, or when an
  allowlisted symbol becomes used (stale allowlist). To wire a mechanism and
  clear its allowlist entry in the same change.
- `join-encoding.ts` — RUN-22. Fails on `.join("")` used in a comparison or
  digest. `lib/peernet/src/membership.ts` hex encoding is a documented
  exemption.
- `fault-injection.ts` — OPS-20. Fails if a `fault-injection` fault type is
  silently passed through instead of acted on.

When you intentionally leave a mechanism unwired, add it to the guard's
`KNOWN_UNWIRED_ALLOWLIST` with the requirement ID and a reason. An allowlist
entry is a tracking marker, not a fix.

## Gotchas that will waste your time

- **Stale `tsconfig.tsbuildinfo` with missing `dist/`** produces bogus
  `error TS6305: Output file ... has not been built from source file`. This is
  not a code bug. Fix:
  `find lib artifacts scripts -name '*.tsconfig.tsbuildinfo' -delete`
  (or `npx tsc -b --force`), then re-run `pnpm run typecheck`.
- **`lib/peernet` and `lib/raft-log` must be in the root `tsconfig.json`
  references** and each must reference the libs it imports, or `tsc --build`
  silently skips them. `lib/api-spec` has no `tsconfig.json` (codegen only) and
  must NOT be referenced.
- **`PORT` and `DATABASE_URL` are both mandatory** for `pnpm --filter
  @workspace/api-server run start`. There is no default port.
- **Never set `OPENNODE_LOCAL_SECRET_KEY`** — it falls back to a published
  literal that makes signatures forgeable (NET-02).
- **Metrics endpoint is authenticated.** `GET /api/metrics` is mounted only on
  the `/api` router. Do NOT add routes to `artifacts/api-server/src/routes/index.ts`
  unless they are safe unauthenticated: that router is also mounted at
  `/api/healthz` without `authMiddleware`. Emit metrics via the singleton
  `metricsRegistry` with only the OPS-05 allowlisted labels (`nodeId`,
  `clusterId`, `status`, `reason`, `subsystem`).
- **No `console.*` in server code** — use `logger`/`req.log` (OPS-08).

## Closure order

Do not jump ahead of `docs/release-gates.md`'s order:
PROV-03 (wire unused mechanisms) → OPS-01 (test runner, done) →
OPS-02 (CI, done) → OPS-03 (metrics emission, done). Stage 4 (the evidence
pipeline) unblocks every gate; behavioural work after it is Stage 5+.
