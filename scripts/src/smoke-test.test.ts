import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./smoke-test.ts', import.meta.url)),
  'utf8',
);

describe('OPS-01 smoke-test assertion mechanism', () => {
  it('imports strict node:assert for its assertions', () => {
    expect(source).toMatch(/import\s+assert\s+from\s+['"]node:assert\/strict['"]/);
  });

  it('never uses console.assert', () => {
    expect(source).not.toMatch(/\bconsole\.assert\b/);
  });

  it('fails the process with a non-zero exit code on error', () => {
    expect(source).toContain('process.exit(1)');
  });
});
