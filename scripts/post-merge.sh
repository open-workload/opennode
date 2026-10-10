#!/bin/bash
#
# Post-merge hook, wired via .replit [postMerge] (timeoutMs = 20000).
#
#   merge ──▶ install deps ──▶ report ──▶ operator applies schema (deliberate)
#                  │              │
#                  fail            no schema mutation happens here
#
# Schema changes are NOT applied here. `drizzle-kit push` prompts for
# confirmation and exposes no non-destructive auto-approve flag: `--strict` asks
# more often, and `--force` auto-approves data-loss statements, truncating
# tables. Running it unattended therefore either hangs until the post-merge
# timeout, or gets "fixed" with --force and drops data on every merge.
#
# DATA-01 requires committed, reviewed SQL migrations with a schema_migrations
# ledger. Until that exists, a human runs:
#
#   pnpm --filter @workspace/db run push
#
# against a real DATABASE_URL, after reviewing the diff it reports.

set -euo pipefail

pnpm install --frozen-lockfile

echo "post-merge: dependencies installed."
echo "post-merge: schema NOT applied (DATA-01). Review drift, then run:"
echo "post-merge:   pnpm --filter @workspace/db run push"