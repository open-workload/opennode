import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the post-merge hook against an unattended schema mutation.
 *
 *   scripts/post-merge.sh ──▶ read ──▶ unattended push? ──yes──▶ FAIL
 *                                     │no
 *                                     └──▶ ok
 *
 * `drizzle-kit push` prompts for confirmation and exposes no non-destructive
 * auto-approve flag, so running it from an automated hook either hangs under the
 * .replit `postMerge` timeout or gets "fixed" with `--force`, which truncates
 * tables. DATA-01 requires committed, reviewed migrations instead.
 */

const postMergePath = fileURLToPath(new URL("../post-merge.sh", import.meta.url));
const script = readFileSync(postMergePath, "utf8");

/** Lines the hook actually executes — comments and operator guidance are not execution. */
const executed = script
  .split("\n")
  .filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    if (/^(echo|printf)\b/.test(trimmed)) return false;
    return true;
  })
  .join("\n");

describe("scripts/post-merge.sh", () => {
  it("does not apply schema changes unattended", () => {
    expect(executed).not.toMatch(/drizzle-kit\s+push/);
    expect(executed).not.toMatch(/--filter\s+\S*\s*db\s+run\s+push(?:-force)?/);
    expect(executed).not.toMatch(/\bpnpm\b.*\bpush\b/);
  });

  it("never auto-approves data loss", () => {
    expect(executed).not.toMatch(/push[^\n]*--force/);
  });

  it("still fails fast rather than continuing on error", () => {
    expect(executed).toMatch(/set -[^\n]*e/);
  });

  it("tells the operator how to apply the schema deliberately", () => {
    expect(script).toMatch(/DATA-01/);
    expect(script).toMatch(/--filter\s+@workspace\/db\s+run\s+push/);
  });
});