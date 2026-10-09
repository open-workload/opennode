import { describe, expect, it } from 'vitest';
import {
  analyzeUnusedSymbols,
  symbolKey,
  type RequiredSymbol,
  type SourceFile,
} from './unused-symbols';

const required = (over: Partial<RequiredSymbol> = {}): RequiredSymbol => ({
  requirement: 'PROV-03',
  symbol: 'probe',
  definingFile: 'lib/probe.ts',
  callPattern: /\bprobe\s*\(/,
  ...over,
});

const file = (path: string, content: string): SourceFile => ({ path, content });

describe('analyzeUnusedSymbols (PROV-03 matcher)', () => {
  it('counts a call site in another production file as used', () => {
    const analysis = analyzeUnusedSymbols(
      [required()],
      [
        file('lib/probe.ts', 'export function probe() {}\n'),
        file('lib/consumer.ts', 'probe();\n'),
      ],
      [],
    );

    expect(analysis.unused).toHaveLength(0);
    expect(analysis.untracked).toHaveLength(0);
    expect(analysis.stale).toHaveLength(0);
  });

  it('treats a call only inside the defining file as unused', () => {
    const analysis = analyzeUnusedSymbols(
      [required()],
      [file('lib/probe.ts', 'export function probe() {}\nfunction caller() { probe(); }\n')],
      [],
    );

    expect(analysis.unused.map((s) => s.symbol)).toEqual(['probe']);
    expect(analysis.untracked.map((s) => s.symbol)).toEqual(['probe']);
  });

  it('treats a call only inside a test file as unused', () => {
    const analysis = analyzeUnusedSymbols(
      [required()],
      [
        file('lib/probe.ts', 'export function probe() {}\n'),
        file('lib/probe.test.ts', 'probe();\n'),
      ],
      [],
    );

    expect(analysis.untracked.map((s) => s.symbol)).toEqual(['probe']);
  });

  it('does not treat a type-only import as a call site', () => {
    const analysis = analyzeUnusedSymbols(
      [required()],
      [
        file('lib/probe.ts', 'export function probe() {}\n'),
        file('lib/consumer.ts', "import type { probe } from './probe';\n"),
      ],
      [],
    );

    expect(analysis.untracked.map((s) => s.symbol)).toEqual(['probe']);
  });

  it('suppresses allowlisted unused symbols but reports untracked ones', () => {
    const tracked = required({ symbol: 'tracked' });
    const untracked = required({ symbol: 'untracked' });

    const analysis = analyzeUnusedSymbols(
      [tracked, untracked],
      [file('lib/probe.ts', 'export function tracked() {}\nexport function untracked() {}\n')],
      [symbolKey(tracked)],
    );

    expect(analysis.unused.map((s) => s.symbol).sort()).toEqual(['tracked', 'untracked']);
    expect(analysis.untracked.map((s) => s.symbol)).toEqual(['untracked']);
    expect(analysis.stale).toHaveLength(0);
  });

  it('reports an allowlisted symbol that has since become used as stale', () => {
    const wired = required({ symbol: 'wired', callPattern: /\bwired\s*\(/ });

    const analysis = analyzeUnusedSymbols(
      [wired],
      [
        file('lib/probe.ts', 'export function wired() {}\n'),
        file('lib/consumer.ts', 'wired();\n'),
      ],
      [symbolKey(wired)],
    );

    expect(analysis.unused).toHaveLength(0);
    expect(analysis.stale.map((s) => s.symbol)).toEqual(['wired']);
  });
});
