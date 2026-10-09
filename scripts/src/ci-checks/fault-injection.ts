import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuardResult } from './guard';

export interface FaultTypePassThrough {
  readonly method: 'inject' | 'injectSync';
  readonly type: string;
}

export interface InjectorPassThroughAnalysis {
  readonly passThrough: readonly FaultTypePassThrough[];
  readonly untracked: readonly FaultTypePassThrough[];
  readonly stale: readonly string[];
}

const INJECTOR_PATH = 'lib/failure-injection/src/injector.ts';

function extractMethodBody(source: string, name: string): string | undefined {
  const signature = new RegExp(`\\b${name}\\s*<[^>]*>\\s*\\(`).exec(source);
  if (!signature) return undefined;

  const open = source.indexOf('{', signature.index + signature[0].length);
  if (open < 0) return undefined;

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return undefined;
}

function enumMemberNames(source: string): string[] {
  const declaration = /export\s+enum\s+FaultType\s*\{([\s\S]*?)\}/.exec(source);
  if (!declaration) return [];
  return [...declaration[1].matchAll(/(\w+)\s*=\s*"/g)].map((match) => match[1]);
}

function handledTypes(methodBody: string): Set<string> {
  return new Set(
    [...methodBody.matchAll(/case\s+FaultType\.(\w+)\s*:/g)].map((match) => match[1]),
  );
}

/**
 * OPS-20: a fault type that reaches the `default:` branch of `inject()` /
 * `injectSync()` is silently swallowed — the fault scenario reports green while
 * injecting nothing. This finds every swallowed type so the guard can require
 * it to be documented (see `docs/release-gates.md` Gate 3).
 */
export function analyzeInjectorPassThrough(
  source: string,
  allowlist: readonly string[],
): InjectorPassThroughAnalysis {
  const allTypes = enumMemberNames(source);
  const passThrough: FaultTypePassThrough[] = [];

  for (const method of ['inject', 'injectSync'] as const) {
    const body = extractMethodBody(source, method);
    if (!body) continue;
    const handled = handledTypes(body);
    for (const type of allTypes) {
      if (!handled.has(type)) passThrough.push({ method, type });
    }
  }

  const tracked = new Set(allowlist);
  const untracked = passThrough.filter((row) => !tracked.has(`${row.method}:${row.type}`));
  const present = new Set(passThrough.map((row) => `${row.method}:${row.type}`));
  const stale = allowlist.filter((key) => !present.has(key));

  return { passThrough, untracked, stale };
}

/**
 * Documented, requirement-tracked allowlist. These types currently reach the
 * `default:` branch and inject nothing; `docs/release-gates.md` Gate 3 (OPS-20)
 * names them. Removing an entry is how we record that the type is now injected.
 */
export const KNOWN_PASS_THROUGH_ALLOWLIST: readonly string[] = [
  'inject:Partition',
  'inject:MessageLoss',
  'inject:MessageDuplication',
  'inject:MessageReordering',
  'injectSync:Timeout',
  'injectSync:Partition',
  'injectSync:ClockSkew',
  'injectSync:MessageLoss',
  'injectSync:MessageDuplication',
  'injectSync:MessageReordering',
];

export function checkInjectorPassThrough(root: string): GuardResult {
  const source = readFileSync(join(root, INJECTOR_PATH), 'utf8');
  const analysis = analyzeInjectorPassThrough(source, KNOWN_PASS_THROUGH_ALLOWLIST);

  const failures = [
    ...analysis.untracked.map(
      (row) =>
        `${row.method}() silently passes through fault type ${row.type} — ` +
        `inject it or add "${row.method}:${row.type}" to KNOWN_PASS_THROUGH_ALLOWLIST with a tracking id`,
    ),
    ...analysis.stale.map(
      (key) =>
        `stale OPS-20 allowlist entry: ${key} is now explicitly injected — remove it from KNOWN_PASS_THROUGH_ALLOWLIST`,
    ),
  ];

  return {
    name: 'OPS-20 fault injection pass-through',
    ok: failures.length === 0,
    failures,
    summary:
      `${analysis.passThrough.length} silently injected type(s), ` +
      `${analysis.untracked.length} untracked, ${analysis.stale.length} stale`,
  };
}
