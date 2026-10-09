# @workspace/node-store

Durable, node-local state behind the small `NodeStore` interface. All callers
(API, CLI, UI) go through `NodeStore`, never through Drizzle tables directly.

## Migrations

Schema lives in `@workspace/db` (`lib/db/src/schema`). Apply changes with:

    pnpm --filter @workspace/db run push        # dev only
    drizzle-kit generate                        # produce SQL migrations for review/CI

There is no migration file committed yet; slice 1 relies on `drizzle-kit push`.
Any schema change (new table, new column, new index) must be paired with a
push and a note here.

## Transaction boundaries

Every `NodeStore` write runs inside `db.transaction`: run submit (insert run +
audit row + activity row), cancel request, terminal transition, attempt
create/transition, log append (sequence computation + insert), and audit
inserts. Reads are single-row or paginated selects outside transactions.

## Checksums

- `run_log_entries.checksum` = sha256 of `runId|attempt|stream|sequence|message|createdAt`.
- `workload_run_attempts.checksum` = sha256 of `runId|attempt|providerRunId`.
- `audit_events.checksum` = sha256 of `action|runId|requestId`.
- Idempotency fingerprint: `workload_runs.request_fingerprint` = sha256 of the
  canonical (stable-stringify) submission payload.

`verifyRunLogIntegrity(runId)` recomputes every entry checksum.

## Backup / restore

`backupToFile(path)` writes a JSON manifest line plus a canonical-JSON payload
of all tables with a sha256 checksum. `restoreFromFile(path)` verifies the
checksum, then truncates and re-inserts every table inside one transaction.
Entrypoints are intentionally simple; production hardening (slice 6) will add
signed, encrypted off-node backups.

## Idempotency

`client_request_id` is the idempotency key (unique index). Same key + same
fingerprint returns the existing run; same key + different fingerprint is an
`IDEMPOTENCY_CONFLICT` error (API maps it to 409).
