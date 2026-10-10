---
name: opennode-db-schema-change
description: Handles an OpenNode schema change on drizzle-kit push — the DATABASE_URL gate for lib/db, the interactive prompt that breaks post-merge.sh, and the DATA-01 migration gap. Use when editing lib/db/src/schema/*.ts, adding or altering a pgTable, column, or pgEnum, running or repairing a drizzle-kit push, or backing up before a destructive change.
---

# OpenNode DB schema change

Procedure for changing `lib/db` schema. This repo has **no migration files and no
`schema_migrations` table** — there is no `*.sql` anywhere in the tree and no
`migrations/` folder. Schema reaches the database *only* by `drizzle-kit push`,
which diffs the TypeScript schema against the live database and applies the diff
directly. That is a known violation of `todo.md` DATA-01; see §4 before you push.

## 1. Edit the schema files

All schema lives in `lib/db/src/schema/`. One `pgTable` per file, plus
`enums.ts` for the 10 `pgEnum`s. There are **13 tables** today:

```
activity-events  attempts  audit-events  cluster-metadata  cluster-nodes
idempotency-keys  leases  local-node-identity  membership-proposals
membership-votes  peer-status  run-log-entries  workload-runs
```

Follow the shape in `lib/db/src/schema/leases.ts`: a `pgTable` whose third
argument is an array of `uniqueIndex` / `index` / `check` constraints, followed
by `createInsertSchema(...).omit({ createdAt: true })` and the `Insert*` /
`*` exported types. Snake_case in the DB, camelCase in TS (`expiresAt` →
`expires_at`).

**Add the export to the barrel.** `lib/db/src/schema/index.ts` is the schema
entrypoint that `drizzle.config.ts` points at (`schema: path.join(__dirname,
"./src/schema/index.ts")`). A new file that is not re-exported there is
invisible to drizzle-kit — the push will silently apply nothing. Every new
`export * from "./<file>";` line is required:

```
lib/db/src/schema/index.ts
```

Enums need no barrel edit beyond the existing `export * from "./enums";`.

## 2. The pre-push gate

Two things block a push, both at *module load*, before any diff is computed:

- `lib/db/drizzle.config.ts` throws `DATABASE_URL, ensure the database is
  provisioned` if `DATABASE_URL` is unset.
- `lib/db/src/index.ts` throws on import for the same reason. This is why the
  vitest suite passes with no database:
  `artifacts/api-server/src/test-setup.ts` sets
  `postgresql://opennode:opennode@localhost:5432/opennode_test` when unset. That
  URL is a placeholder for import-time only — it is not a usable target.

So: export `DATABASE_URL` pointing at a database you are willing to lose, and
confirm what it actually is before doing anything else.

```bash
cd /home/runner/workspace && node -e "
const p = new URL(process.env.DATABASE_URL);
console.log('target host=' + p.hostname + ' port=' + p.port + ' db=' + p.pathname);
"
```

Installed versions: `drizzle-kit v0.31.10`, `drizzle-orm v0.45.2`.

Apply the diff with statements printed and confirmation required — this is the
inspection step, and it changes nothing until you answer the prompt:

```bash
cd /home/runner/workspace/lib/db && \
  ./node_modules/.bin/drizzle-kit push --config ./drizzle.config.ts --strict --verbose
```

`--strict` = "Always ask for confirmation"; `--verbose` = "Print all statements
for each push". Both are real flags in `drizzle-kit push --help` for v0.31.10.
Read every statement it prints. Anything that looks like `DROP TABLE`,
`ALTER TABLE ... DROP COLUMN`, or `TRUNCATE` is destructive — stop and take a
backup (§5) before proceeding.

Package-script equivalents (both exist verbatim in `lib/db/package.json`):

```bash
pnpm --filter @workspace/db run push        # drizzle-kit push --config ./drizzle.config.ts
pnpm --filter @workspace/db run push-force  # drizzle-kit push --force --config ./drizzle.config.ts
```

`push-force` auto-approves all data-loss statements and truncates tables. Use it
**only** against a throwaway local database, never against a node's durable
store.

## 3. The interactive-prompt hazard

`scripts/post-merge.sh` runs on **every merge**:

```bash
#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push
```

`.replit` wires it up with a 20-second ceiling:

```
[postMerge]
path = "scripts/post-merge.sh"
timeoutMs = 20000
```

`drizzle-kit push` is **interactive** — on any schema diff it prompts for
confirmation. Post-merge runs with no TTY, so it hangs on the prompt until the
20s timeout kills it, or aborts. `set -e` plus the timeout means a merge that
touches `lib/db/src/schema/` produces a half-applied database. Every other
library merge is unaffected, which makes this look intermittent.

Corollary: **a push is not a deploy.** Never rely on post-merge to carry a
schema change. Apply it deliberately (§2) and treat the post-merge run as a
thing that will fight you.

## 4. What DATA-01 actually requires (fix direction, not current state)

`todo.md:1160`:

> **DATA-01 — Versioned migrations, no destructive push.** Every schema change
> MUST be accompanied by a committed, reviewed SQL migration and a `migrate`
> deploy path; `push` MUST be restricted to ephemeral local development
> databases and MUST NOT run against a node's durable store. A
> `schema_migrations` ledger MUST record the applied version, and a node MUST
> refuse to advertise capacity when its binary's schema version is newer than
> the ledger. Destructive DDL MUST NOT be issued by an automated post-merge step.

None of that exists yet. The gap is four things, all still open:

1. Committed `.sql` migrations. `drizzle-kit generate` exists in the installed
   v0.31.10 and takes `--schema`, `--out`, `--name`; it emits SQL from the same
   TypeScript schema without touching the database. Nothing in the repo runs it
   and no output is committed.
2. A `migrate` deploy path replacing `push` in `scripts/post-merge.sh`.
3. A `schema_migrations` ledger table plus a schema-version check that gates
   capacity advertisement.
4. An explicit advisory lock + compatibility-window abort (DATA-02), so a
   rolling upgrade cannot half-apply.

`todo.md:140` records the same finding: *"No migration artifacts exist; schema is
applied by destructive `push`."* When you land a schema change, you are moving
these from open to done — commit the generated SQL, not just the `.ts`.

## 5. Backup before anything destructive

Take a backup before any `DROP` / `DROP COLUMN` / `TRUNCATE` / type change.
`lib/node-store/src/nodeStore.ts` already does this — `backupToFile` shells out
to:

```
pg_dump --no-owner --no-privileges --format=custom --file="<path>" "<DATABASE_URL>"
```

and `restoreFromFile` mirrors it:

```
pg_restore --clean --no-owner --no-privileges --dbname="<DATABASE_URL>" "<path>"
```

Use `pg_dump` directly for a one-off; do not hand-roll a backup. `pg_dump` and
`pg_restore` come from the Nix Postgres channel in `.replit` and are on `PATH`.
If `which pg_dump` is empty, the backup is impossible and the push must not
happen:

```bash
which pg_dump pg_restore
```

Note the known round-trip defect (DATA-03): backups currently destroy every
timestamp. Treat a dump as a schema-safety net, not as a data-fidelity
guarantee.

### The `tableCount: 13` coupling

`lib/node-store/src/nodeStore.ts` hardcodes `tableCount: 13` in **both** backup
and restore manifests (`backupToFile` and `restoreFromFile`, the two
`BackupManifest` literals around lines 455 and 475). The current schema really
does have 13 `pgTable`s. **Adding a 14th table without bumping both literals
makes every backup manifest report a wrong table count**, and the manifest
checksum covers it. Grep and fix both sites in the same commit as the new table:

```bash
cd /home/runner/workspace && grep -n "tableCount" lib/node-store/src/nodeStore.ts
```

Removing a table makes the count too high, with the same effect.

## 6. Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error: DATABASE_URL, ensure the database is provisioned` | `lib/db/drizzle.config.ts` loads with `DATABASE_URL` unset | Export `DATABASE_URL`; confirm it is a scratch DB first |
| Same throw while running tests | `lib/db/src/index.ts` throws on import; `artifacts/api-server/src/test-setup.ts` normally stubs it | Do not "fix" this by exporting a real URL into the test env |
| Push reports no changes after you added a table | Missing `export * from "./<file>";` in `lib/db/src/schema/index.ts` | Add the barrel export — the config loads *only* the barrel |
| Push is silent / merge times out at 20s | `push` is interactive; post-merge has no TTY (§3) | Apply deliberately with `--strict`; remove the push from post-merge per DATA-01 |
| Tables dropped that you did not intend | `push-force` auto-approves data loss | Use plain `push`; never `push-force` against durable state |
| `BackupManifest.tableCount` wrong | New table, literals at `nodeStore.ts:455` and `:475` still say 13 | Bump both literals |
| `pg_dump: command not found` | Postgres client binaries absent from PATH | Nix channel in `.replit` supplies them; `which pg_dump` to check |

## Verification

```bash
cd /home/runner/workspace && node -e "const p=require('./lib/db/package.json');console.log(JSON.stringify(p.scripts,null,2))"
```

Expected — these are the only two scripts, and §2 quotes them verbatim:

```json
{
  "push": "drizzle-kit push --config ./drizzle.config.ts",
  "push-force": "drizzle-kit push --force --config ./drizzle.config.ts"
}
```

Then `cd lib/db && ./node_modules/.bin/drizzle-kit push --help` to confirm
`--strict`, `--verbose`, and `--force` exist in the installed version before
relying on any flag in this skill.
