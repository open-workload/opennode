import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInjectorPassThrough } from './fault-injection';
import type { GuardResult } from './guard';
import { checkBareJoin } from './join-encoding';
import { checkMetricProducers } from './metric-producers';
import { checkUnusedSymbols } from './unused-symbols';
import { checkWorkerKind } from './worker-kind';

export function runCiChecks(root: string): GuardResult[] {
  return [
    checkUnusedSymbols(root),
    checkBareJoin(root),
    checkInjectorPassThrough(root),
    checkMetricProducers(root),
    checkWorkerKind(root),
  ];
}

export function formatCiChecks(results: readonly GuardResult[]): {
  readonly lines: readonly string[];
  readonly ok: boolean;
} {
  const lines: string[] = [];
  let ok = true;

  for (const result of results) {
    if (result.ok) {
      lines.push(`ok   ${result.name} — ${result.summary}`);
      continue;
    }
    ok = false;
    lines.push(`FAIL ${result.name} — ${result.summary}`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  }

  lines.push(ok ? `\ncheck:ci passed (${results.length} guards)` : '\ncheck:ci failed');
  return { lines, ok };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const { lines, ok } = formatCiChecks(runCiChecks(root));
  for (const line of lines) console.log(line);
  if (!ok) process.exitCode = 1;
}

main();
