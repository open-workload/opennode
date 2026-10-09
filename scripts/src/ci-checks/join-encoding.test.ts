import { describe, expect, it } from 'vitest';
import { analyzeBareJoins, findBareJoins } from './join-encoding';
import type { SourceFile } from './source';

const file = (path: string, content: string): SourceFile => ({ path, content });

describe('findBareJoins (RUN-22 matcher)', () => {
  it('flags a double-quoted empty-string join', () => {
    const hits = findBareJoins([file('lib/x.ts', 'const a = ["a", "b"].join("");\n')]);
    expect(hits.map((h) => h.path)).toEqual(['lib/x.ts']);
  });

  it('flags a single-quoted empty-string join', () => {
    const hits = findBareJoins([file('lib/x.ts', "const a = list.join('');\n")]);
    expect(hits).toHaveLength(1);
  });

  it('reports the 1-based line and source text', () => {
    const hits = findBareJoins([file('lib/x.ts', 'const ok = 1;\nconst bad = ids.join("");\n')]);
    expect(hits).toEqual([
      { path: 'lib/x.ts', line: 2, text: 'const bad = ids.join("");' },
    ]);
  });

  it('ignores non-empty separators', () => {
    const hits = findBareJoins([
      file('lib/x.ts', 'const a = list.join("|");\nconst b = list.join(" ");\n'),
    ]);
    expect(hits).toEqual([]);
  });

  it('does not flag a variable separator', () => {
    const hits = findBareJoins([file('lib/x.ts', 'const a = list.join(sep);\n')]);
    expect(hits).toEqual([]);
  });
});

describe('analyzeBareJoins (RUN-22 allowlist)', () => {
  it('marks violations outside the exemption list', () => {
    const analysis = analyzeBareJoins(
      [file('lib/a.ts', 'const a = x.join("");\n')],
      [],
    );
    expect(analysis.violations.map((v) => v.path)).toEqual(['lib/a.ts']);
    expect(analysis.staleExemptions).toEqual([]);
  });

  it('exempts a documented file that has no bare join violation', () => {
    const analysis = analyzeBareJoins(
      [file('lib/hex.ts', 'return bytes.map((b) => b.toString(16)).join("");\n')],
      ['lib/hex.ts'],
    );
    expect(analysis.violations).toEqual([]);
    expect(analysis.staleExemptions).toEqual([]);
  });

  it('reports a stale exemption once the file no longer has a bare join', () => {
    const analysis = analyzeBareJoins(
      [file('lib/hex.ts', 'return createHash("sha256").update(bytes).digest("hex");\n')],
      ['lib/hex.ts'],
    );
    expect(analysis.violations).toEqual([]);
    expect(analysis.staleExemptions).toEqual(['lib/hex.ts']);
  });
});
