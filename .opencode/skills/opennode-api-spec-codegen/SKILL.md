---
name: opennode-api-spec-codegen
description: Regenerate and review OpenNode's OpenAPI contract pipeline by editing lib/api-spec/openapi.yaml and running the orval codegen script that clean-rewrites the lib/api-client-react and lib/api-zod generated trees, and use it when adding, changing, or removing an endpoint or schema in openapi.yaml, when a typecheck failure names a generated hook or zod type, or when reviewing a diff that touches lib/api-client-react/src/generated or lib/api-zod/src/generated.
---

# OpenNode API spec codegen

`lib/api-spec/openapi.yaml` (24 paths) is the single source of truth for the
HTTP contract (`API-08`). One orval run fans it out into two generated trees,
and each tree has exactly one consumer. Nothing about the contract is written
anywhere else.

## 1. The contract-change loop

1. Edit `lib/api-spec/openapi.yaml` — paths, schemas, parameters, responses.
2. Regenerate:
   ```bash
   pnpm --filter @workspace/api-spec run codegen
   ```
3. Both generated trees change together, because both orval targets in
   `lib/api-spec/orval.config.ts` read the same `./openapi.yaml`:
   - `lib/api-client-react/src/generated/` — `api.ts` (react-query hooks) and
     `api.schemas.ts`, re-exported by `lib/api-client-react/src/index.ts`.
   - `lib/api-zod/src/generated/` — `api.ts` and `types/`, re-exported by
     `lib/api-zod/src/index.ts`.
4. Update whichever consumer drifted:

   | Generated tree | Consumer |
   |---|---|
   | `lib/api-zod` | `artifacts/api-server/src/routes/` — `cluster.ts`, `runs.ts`, `membership.ts`, `health.ts` import schema and response types from `@workspace/api-zod` |
   | `lib/api-client-react` | `artifacts/opennode/src/App.tsx` — imports `use*` hooks, `get*QueryKey` helpers, and types from `@workspace/api-client-react` |

   Consumers import the **package barrel** (`@workspace/api-zod`,
   `@workspace/api-client-react`), never a `generated/` path directly. A new
   operation reaches a consumer only via the barrel, so a rename in the spec is
   a compile error in the consumer, not a silent break.

Never change the two consumers and the spec in separate steps — the generated
trees are the only place the contract is expressed as code.

## 2. `clean: true` + `prettier: true` make the diff lie

Both orval targets set `clean: true` and `prettier: true`
(`lib/api-spec/orval.config.ts:30-31` and `:56-57`). Consequences:

- **`clean: true` wipes the output directory before writing.** Removing an
  operation from `openapi.yaml` deletes its generated file outright — expect
  whole-file deletions, not surgical edits. Conversely, a generated file that
  "came back" unchanged is a real signal that the spec entry is gone.
- **`prettier: true` reformats everything it emits.** The generated trees are
  Prettier-formatted; hand-written repo code is not (`artifacts/opennode/src/App.tsx`
  and `artifacts/api-server/src/routes/*.ts` both use their own formatting).
  Any openapi.yaml change produces whitespace churn across the whole tree
  alongside the real change. Read the diff semantically; do not comment on
  formatting in a generated file.

One trap in the config: `titleTransformer` forces `info.title = "Api"`
(`lib/api-spec/orval.config.ts:9-14`) because the exports assume `api.ts`.
Renaming the title in `openapi.yaml` will **not** rename the output, and a
hand-renamed `api.ts` is deleted by the next `clean: true` run.

## 3. Never hand-edit generated files

`lib/api-client-react/src/generated/**` and `lib/api-zod/src/generated/**` are
orval output. A hand edit is erased by the next `clean: true` run, and it hides
the fact that the contract and the code disagree. Change
`lib/api-spec/openapi.yaml` and regenerate.

The one hand-written file near the generated tree is
`lib/api-client-react/src/custom-fetch.ts`. It sits in `src/`, outside
`generated/`, survives `clean: true`, and is the configured mutator
(`override.mutator`, `orval.config.ts:36-39`). Edit it directly.

## 4. When typecheck fails after codegen

The codegen script is `orval --config ./orval.config.ts && pnpm -w run typecheck:libs`
(`lib/api-spec/package.json`), so a broken consumer **fails the codegen command
itself** — this is the early-warning signal, not a separate step.

It means a consumer drifted from the contract. Fix the consumer. Do not weaken
`openapi.yaml` to make a consumer compile, and do not revert the generated tree.

`typecheck:libs` is `tsc --build`, which covers the libs but **not** the
artifacts. Narrow the artifact failures with their own per-package scripts:

```bash
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/opennode run typecheck
```

`lib/api-spec` is deliberately absent from the root `tsconfig.json` references
— it is codegen-only, with no `src/` and no `tsconfig.json`. Do not add it; a
missing project reference for `@workspace/api-spec` is expected, not a bug.

Note that codegen is a destructive, repo-wide operation: it clean-rewrites both
generated trees. Do not run it while other agents or editors are working in this
repo.

## 5. Verification

Commands that exist in this repo:

```bash
# Regenerate both clients from openapi.yaml (also runs tsc --build)
pnpm --filter @workspace/api-spec run codegen

# Confirm both generated trees exist
ls lib/api-client-react/src/generated lib/api-zod/src/generated

# Full gate: tsc --build (18 libs) + per-package checks
pnpm run typecheck
pnpm test
pnpm run check:ci
```

Before claiming a contract change is complete, confirm the spec and the
implementation still agree in **both** directions (`API-08` requires CI to fail
if the Express route table and the document's `paths` differ in either
direction). Known drift today, per `README.md:280`: `GET /api/peer-status` is
declared but not implemented, and `GET /api/metrics` is implemented but not
declared. Adding a path to `openapi.yaml` does not implement it, and
regenerating does not detect either direction of drift.
