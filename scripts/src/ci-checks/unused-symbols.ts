import type { GuardResult } from './guard';
import { isTestFile, toPosix, walkSourceFiles, type SourceFile } from './source';

export interface RequiredSymbol {
  readonly requirement: string;
  readonly symbol: string;
  readonly definingFile: string;
  readonly callPattern: RegExp;
}

export interface UnusedSymbolAnalysis {
  readonly unused: readonly RequiredSymbol[];
  readonly untracked: readonly RequiredSymbol[];
  readonly stale: readonly RequiredSymbol[];
}

export function symbolKey(symbol: RequiredSymbol): string {
  return `${symbol.requirement}:${symbol.symbol}`;
}

/**
 * Pure matcher for PROV-03. A required symbol is "unused" when no production
 * (non-test) file other than its defining file matches its call pattern.
 * An unused symbol is "untracked" when it is missing from the allowlist; an
 * allowlisted symbol that now has a call site is "stale".
 */
export function analyzeUnusedSymbols(
  symbols: readonly RequiredSymbol[],
  files: readonly SourceFile[],
  allowlist: readonly string[],
): UnusedSymbolAnalysis {
  const allowed = new Set(allowlist);
  const production = files.filter((file) => !isTestFile(file.path));

  const unused: RequiredSymbol[] = [];
  const stale: RequiredSymbol[] = [];

  for (const symbol of symbols) {
    const defining = toPosix(symbol.definingFile);
    const hasCallSite = production.some((file) => {
      if (toPosix(file.path) === defining) return false;
      symbol.callPattern.lastIndex = 0;
      return symbol.callPattern.test(file.content);
    });

    if (!hasCallSite) {
      unused.push(symbol);
    } else if (allowed.has(symbolKey(symbol))) {
      stale.push(symbol);
    }
  }

  const untracked = unused.filter((symbol) => !allowed.has(symbolKey(symbol)));
  return { unused, untracked, stale };
}

function required(
  symbol: string,
  definingFile: string,
  callPattern: RegExp,
): RequiredSymbol {
  return { requirement: 'PROV-03', symbol, definingFile, callPattern };
}

/**
 * Symbols that PROV-03 names as load-bearing but that currently have no call
 * site outside their defining file or tests. The call pattern is intentionally
 * narrow to avoid matching unrelated members (e.g. `Map.get`).
 */
export const REQUIRED_SYMBOLS: readonly RequiredSymbol[] = [
  required('runCatchUp', 'lib/sync-engine/src/catchup.ts', /\brunCatchUp\s*\(/),
  required(
    'MembershipService.reconcile',
    'lib/opennode-domain/src/membership-service.ts',
    /\b(?:membershipService|service)\.reconcile\s*\(/,
  ),
  required('MembershipLog.reconcilePeer', 'lib/membership-log/src/core.ts', /\breconcilePeer\s*\(/),
  required('authorizePeerAccess', 'lib/peernet/src/membership.ts', /\bauthorizePeerAccess\s*\(/),
  required('isQuarantined', 'lib/node-lifecycle/src/controller.ts', /\bisQuarantined\s*\(/),
  required(
    'fenceOnMembershipChange',
    'lib/run-coordinator/src/coordinator.ts',
    /\bfenceOnMembershipChange\s*\(/,
  ),
  required(
    'issueMembershipCredential',
    'lib/membership-log/src/core.ts',
    /\bissueMembershipCredential\s*\(/,
  ),
  required('ensureNodeIdentity', 'lib/opennode-domain/src/identity.ts', /\bensureNodeIdentity\s*\(/),
  required(
    'assertNoNodeIdCollision',
    'lib/opennode-domain/src/identity.ts',
    /\bassertNoNodeIdCollision\s*\(/,
  ),
  required(
    'isCommittedLeaseUsable',
    'lib/run-coordinator/src/leases.ts',
    /\bisCommittedLeaseUsable\s*\(/,
  ),
  required(
    'compareFencingTokens',
    'lib/run-coordinator/src/leases.ts',
    /\bcompareFencingTokens\s*\(/,
  ),
  required('isFreshFencingToken', 'lib/run-coordinator/src/leases.ts', /\bisFreshFencingToken\s*\(/),
  // Excludes `this.leases.get`, which reaches the class's private Map rather
  // than the registry's public `get` method.
  required(
    'LeaseRegistry.get',
    'lib/membership-log/src/leases.ts',
    /(?<!this\.)\bleases\.get\s*\(/,
  ),
  required('LeaseRegistry.list', 'lib/membership-log/src/leases.ts', /\bleases\.list\s*\(/),
  required(
    'ChunkStore.delete',
    'lib/content-store/src/chunk.ts',
    /\b(?:chunkStore|contentStore)\.delete\s*\(/,
  ),
  required('createNonceCache', 'lib/peernet/src/replayProtection.ts', /\bcreateNonceCache\s*\(/),
  required(
    'createDefaultHarness',
    'lib/failure-injection/src/harness.ts',
    /\bcreateDefaultHarness\s*\(/,
  ),
  required(
    'registerAllFaultPoints',
    'lib/failure-injection/src/registry.ts',
    /\bregisterAllFaultPoints\s*\(/,
  ),
  required(
    'setFeatureFlagsInstance',
    'artifacts/api-server/src/routes/flags.ts',
    /\bsetFeatureFlagsInstance\s*\(/,
  ),
];

/**
 * Explicit, requirement-tracked allowlist. Every entry is a known-unwired
 * mechanism that PROV-03 requires us to wire; removing an entry is how we
 * record that it became reachable. A symbol that becomes used while it is
 * still listed here fails CI as a stale allowlist entry.
 *
 * Tracking ids: PROV-03 (unused mechanism) is the governing requirement; the
 * named requirement in each comment is the specific gap that keeps it unwired.
 */
export const KNOWN_UNWIRED_ALLOWLIST: readonly string[] = [
  'PROV-03:runCatchUp', // SYNC-05
  'PROV-03:MembershipService.reconcile', // SYNC-10
  'PROV-03:MembershipLog.reconcilePeer', // SYNC-10
  'PROV-03:authorizePeerAccess', // NET-01
  'PROV-03:isQuarantined', // RUN-18
  'PROV-03:fenceOnMembershipChange', // RUN-19
  'PROV-03:issueMembershipCredential', // NET-06
  'PROV-03:ensureNodeIdentity', // NET-02
  'PROV-03:assertNoNodeIdCollision', // NET-02
  'PROV-03:isCommittedLeaseUsable', // RUN-19
  'PROV-03:compareFencingTokens', // RUN-19
  'PROV-03:isFreshFencingToken', // RUN-19
  'PROV-03:LeaseRegistry.get', // RUN-19
  'PROV-03:LeaseRegistry.list', // RUN-19
  'PROV-03:ChunkStore.delete', // EXEC-17
  'PROV-03:createNonceCache', // NET-05
  'PROV-03:createDefaultHarness', // OPS-07
  'PROV-03:registerAllFaultPoints', // OPS-07
  'PROV-03:setFeatureFlagsInstance', // OPS-13
];

export function checkUnusedSymbols(root: string): GuardResult {
  const files = walkSourceFiles(root, (path) => path.startsWith('scripts/src/ci-checks/'));
  const analysis = analyzeUnusedSymbols(REQUIRED_SYMBOLS, files, KNOWN_UNWIRED_ALLOWLIST);

  const failures = [
    ...analysis.untracked.map(
      (symbol) =>
        `unwired required symbol not on allowlist: ${symbolKey(symbol)} ` +
        `(${symbol.definingFile}) — wire it or add it to KNOWN_UNWIRED_ALLOWLIST with a tracking id`,
    ),
    ...analysis.stale.map(
      (symbol) =>
        `stale allowlist entry: ${symbolKey(symbol)} now has a call site — remove it from KNOWN_UNWIRED_ALLOWLIST`,
    ),
  ];

  return {
    name: 'PROV-03 unused mechanism',
    ok: failures.length === 0,
    failures,
    summary:
      `${REQUIRED_SYMBOLS.length} required symbols: ` +
      `${analysis.unused.length - analysis.untracked.length} tracked-unwired, ` +
      `${analysis.untracked.length} untracked, ${analysis.stale.length} stale`,
  };
}
