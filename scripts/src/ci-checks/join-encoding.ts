import type { GuardResult } from './guard';
import { isTestFile, walkSourceFiles, type SourceFile } from './source';

export interface BareJoin {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface BareJoinAnalysis {
  readonly violations: readonly BareJoin[];
  readonly staleExemptions: readonly string[];
}

const BARE_JOIN = /\.join\s*\(\s*(['"])\1\s*\)/;

/**
 * RUN-22: `Array.prototype.join("")` is not injective, so concatenating a
 * committed identifier set can make distinct sets compare equal. This finds
 * every empty-separator join; the guard then flags any occurrence that is not
 * a documented exemption.
 */
export function findBareJoins(files: readonly SourceFile[]): BareJoin[] {
  const hits: BareJoin[] = [];
  for (const file of files) {
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (BARE_JOIN.test(lines[index])) {
        hits.push({ path: file.path, line: index + 1, text: lines[index].trim() });
      }
    }
  }
  return hits;
}

export function analyzeBareJoins(
  files: readonly SourceFile[],
  exemptions: readonly string[],
): BareJoinAnalysis {
  const exempt = new Set(exemptions);
  const violations = findBareJoins(files).filter((hit) => !exempt.has(hit.path));
  const withJoins = new Set(findBareJoins(files).map((hit) => hit.path));
  const staleExemptions = exemptions.filter((path) => !withJoins.has(path));
  return { violations, staleExemptions };
}

/**
 * Documented, requirement-tracked exemption. `lib/peernet/src/membership.ts:95`
 * encodes fixed-width hex bytes (`toString(16).padStart(2, "0")`), where every
 * element is exactly two characters, so concatenation is injective.
 */
export const BARE_JOIN_EXEMPTIONS: readonly string[] = ['lib/peernet/src/membership.ts'];

export function checkBareJoin(root: string): GuardResult {
  const files = walkSourceFiles(root, (path) =>
    // The guard's own source necessarily names the pattern it forbids.
    path.startsWith('scripts/src/ci-checks/'),
  ).filter((file) => !isTestFile(file.path));
  const analysis = analyzeBareJoins(files, BARE_JOIN_EXEMPTIONS);

  const failures = [
    ...analysis.violations.map(
      (hit) =>
        `bare join("") at ${hit.path}:${hit.line} — use length-prefixed encoding ` +
        `or JSON.stringify(sorted array); add an exemption only for fixed-width encodings`,
    ),
    ...analysis.staleExemptions.map(
      (path) =>
        `stale RUN-22 exemption: ${path} no longer contains join("") — remove it from BARE_JOIN_EXEMPTIONS`,
    ),
  ];

  return {
    name: 'RUN-22 bare join in comparison/digest',
    ok: failures.length === 0,
    failures,
    summary:
      `${analysis.violations.length} violation(s), ` +
      `${BARE_JOIN_EXEMPTIONS.length - analysis.staleExemptions.length} documented exemption(s)`,
  };
}
