/**
 * EXEC-01 guard: the worker backend must be a real backend, never a stub.
 *
 *   source tree ──▶ walkSourceFiles ──▶ non-test files
 *                                            │
 *                     findStubKinds ──▶ kind = "..._stub" findings
 *                                            │
 *              KNOWN_STUB_KIND_ALLOWLIST ────┴──▶ GuardResult
 *
 * A `kind = "..._stub"` / `kind: "..._stub"` assignment in production source
 * means the run path can only construct a placeholder backend. Every found
 * stub kind must be a tracked allowlist entry documenting the known gap; a
 * stub kind that is not allowlisted fails CI.
 */
import type { GuardResult } from './guard';
import { isTestFile, walkSourceFiles, type SourceFile } from './source';

export interface StubKindFinding {
  readonly kind: string;
  readonly path: string;
}

export interface WorkerKindAnalysis {
  readonly findings: readonly StubKindFinding[];
  readonly untracked: readonly StubKindFinding[];
}

const STUB_KIND_PATTERN = /\bkind\s*[:=]\s*["'`]([A-Za-z0-9_]+_stub)["'`]/g;

/**
 * One finding per stub kind per file: `kind = "x_stub"` or `kind: "x_stub"`
 * in a non-test file. A repeated mention (code plus its doc comment) is the
 * same gap, not two.
 */
export function findStubKinds(files: readonly SourceFile[]): StubKindFinding[] {
  const findings: StubKindFinding[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (isTestFile(file.path)) continue;
    for (const match of file.content.matchAll(STUB_KIND_PATTERN)) {
      const key = `${match[1]}\u0000${file.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind: match[1], path: file.path });
    }
  }
  return findings;
}

/**
 * Pure matcher for EXEC-01. A stub kind is "untracked" when it is missing
 * from the allowlist; the guard passes when every found stub kind is
 * allowlisted.
 */
export function analyzeWorkerKinds(
  files: readonly SourceFile[],
  allowlist: readonly string[],
): WorkerKindAnalysis {
  const allowed = new Set(allowlist);
  const findings = findStubKinds(files);
  return {
    findings,
    untracked: findings.filter((finding) => !allowed.has(`EXEC-01:${finding.kind}`)),
  };
}

/**
 * Explicit, requirement-tracked allowlist for EXEC-01. Every entry is a stub
 * backend kind that production code can still construct; replacing the stub
 * with a real backend is how we remove the entry.
 *
 * Tracking ids are `EXEC-01:<kind>`; each comment names the defining file.
 */
export const KNOWN_STUB_KIND_ALLOWLIST: readonly string[] = [
  // EXEC-01:isolated_process_stub — lib/worker-runtime/src/isolatedProcess.ts.
  // The stub is the only worker backend the run path can construct today; the
  // real backends are rootless_isolated / real_isolated.
  'EXEC-01:isolated_process_stub',
];

export function checkWorkerKind(root: string): GuardResult {
  const files = walkSourceFiles(root, (path) => path.startsWith('scripts/src/ci-checks/'));
  const analysis = analyzeWorkerKinds(files, KNOWN_STUB_KIND_ALLOWLIST);

  const failures = analysis.untracked.map(
    (finding) =>
      `stub worker backend kind not on allowlist: EXEC-01:${finding.kind} ` +
      `(${finding.path}) — replace it with a real backend or add it to ` +
      `KNOWN_STUB_KIND_ALLOWLIST with a tracking id`,
  );

  return {
    name: 'EXEC-01 worker backend kind',
    ok: failures.length === 0,
    failures,
    summary:
      `${analysis.findings.length} stub kind(s): ` +
      `${analysis.findings.length - analysis.untracked.length} allowlisted, ` +
      `${analysis.untracked.length} untracked`,
  };
}
