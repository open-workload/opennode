import { describe, expect, it } from 'vitest';
import {
  analyzeMetricProducers,
  extractAlertMetricNames,
} from './metric-producers';
import type { SourceFile } from './source';

const file = (path: string, content: string): SourceFile => ({ path, content });

describe('extractAlertMetricNames', () => {
  it('extracts the unique metricNames referenced by alert rules', () => {
    const source = `
      const a = { condition: { metricName: "sync.catchup_lag", operator: "gt" } };
      const b = { condition: { metricName: "sync.error_rate" } };
      const dup = { condition: { metricName: "sync.catchup_lag" } };
    `;
    expect(extractAlertMetricNames(source)).toEqual(['sync.catchup_lag', 'sync.error_rate']);
  });
});

describe('analyzeMetricProducers (OPS-03 matcher)', () => {
  const metrics = ['sync.catchup_lag'];

  it('counts a real increment/set call site in a production file as produced', () => {
    const analysis = analyzeMetricProducers(
      metrics,
      [file('lib/sync-engine/src/catchup.ts', 'metricsRegistry.set("sync.catchup_lag", 4);\n')],
      [],
    );

    expect(analysis.unproduced).toEqual([]);
    expect(analysis.untracked).toEqual([]);
    expect(analysis.stale).toEqual([]);
  });

  it('does not treat the alert-rule definition or a test file as a producer', () => {
    const analysis = analyzeMetricProducers(
      metrics,
      [
        file(
          'lib/observability/src/alertRules.ts',
          'condition: { metricName: "sync.catchup_lag", threshold: 1000 },\n',
        ),
        file('lib/sync-engine/src/catchup.test.ts', 'metricsRegistry.increment("sync.catchup_lag");\n'),
      ],
      [],
    );

    expect(analysis.unproduced).toEqual(['sync.catchup_lag']);
    expect(analysis.untracked).toEqual(['sync.catchup_lag']);
  });

  it('suppresses allowlisted unproduced metrics but reports untracked ones', () => {
    const analysis = analyzeMetricProducers(['allowlisted', 'untracked'], [], ['OPS-03:allowlisted']);

    expect(analysis.unproduced).toEqual(['allowlisted', 'untracked']);
    expect(analysis.untracked).toEqual(['untracked']);
    expect(analysis.stale).toEqual([]);
  });

  it('reports an allowlisted metric that has since gained a producer as stale', () => {
    const analysis = analyzeMetricProducers(
      metrics,
      [file('lib/sync-engine/src/catchup.ts', 'metricsRegistry.set("sync.catchup_lag", 1);\n')],
      ['OPS-03:sync.catchup_lag'],
    );

    expect(analysis.unproduced).toEqual([]);
    expect(analysis.untracked).toEqual([]);
    expect(analysis.stale).toEqual(['sync.catchup_lag']);
  });

  it('only matches metric names passed as the literal name argument of an emit call', () => {
    const analysis = analyzeMetricProducers(
      metrics,
      [
        file('lib/x/src/a.ts', 'const name = "sync.catchup_lag";\n'),
        file('lib/x/src/b.ts', 'logger.info({ metric: "sync.catchup_lag" });\n'),
      ],
      [],
    );

    expect(analysis.untracked).toEqual(['sync.catchup_lag']);
  });
});