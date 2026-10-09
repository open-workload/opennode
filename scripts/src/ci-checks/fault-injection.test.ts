import { describe, expect, it } from 'vitest';
import { analyzeInjectorPassThrough, type FaultTypePassThrough } from './fault-injection';

const fixture = `
export enum FaultType {
  Latency = "latency",
  Error = "error",
  Partition = "partition",
  Timeout = "timeout",
  ClockSkew = "clock_skew",
}

export class FailureInjector {
  async inject<T>(faultPointName: string, operation: () => Promise<T>): Promise<T> {
    switch (config.type) {
      case FaultType.Latency: {
        await sleep();
        return operation();
      }
      case FaultType.Error: {
        throw new Error("Injected fault");
      }
      default:
        return operation();
    }
  }

  injectSync<T>(faultPointName: string, operation: () => T): T {
    switch (config.type) {
      case FaultType.Latency: {
        return operation();
      }
      default:
        return operation();
    }
  }
}
`;

const keys = (rows: readonly FaultTypePassThrough[]): string[] =>
  rows.map((row) => `${row.method}:${row.type}`).sort();

describe('analyzeInjectorPassThrough (OPS-20 matcher)', () => {
  it('detects fault types silently swallowed by the default branch', () => {
    const analysis = analyzeInjectorPassThrough(fixture, []);
    expect(keys(analysis.passThrough)).toEqual([
      'inject:ClockSkew',
      'inject:Partition',
      'inject:Timeout',
      'injectSync:ClockSkew',
      'injectSync:Error',
      'injectSync:Partition',
      'injectSync:Timeout',
    ]);
  });

  it('reports untracked pass-through types not on the allowlist', () => {
    const analysis = analyzeInjectorPassThrough(fixture, ['inject:Partition']);
    expect(keys(analysis.passThrough)).toHaveLength(7);
    expect(keys(analysis.untracked)).toEqual([
      'inject:ClockSkew',
      'inject:Timeout',
      'injectSync:ClockSkew',
      'injectSync:Error',
      'injectSync:Partition',
      'injectSync:Timeout',
    ]);
  });

  it('is green when every pass-through type is tracked', () => {
    const analysis = analyzeInjectorPassThrough(
      fixture,
      keys(analyzeInjectorPassThrough(fixture, []).passThrough),
    );
    expect(analysis.untracked).toEqual([]);
    expect(analysis.stale).toEqual([]);
  });

  it('reports an allowlisted type that is now explicitly handled as stale', () => {
    const analysis = analyzeInjectorPassThrough(fixture, ['inject:Error']);
    expect(keys(analysis.untracked)).not.toContain('inject:Error');
    expect(analysis.stale).toEqual(['inject:Error']);
  });
});
