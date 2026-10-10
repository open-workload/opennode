import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWorkerKind } from './worker-kind';

const created: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'worker-kind-'));
  created.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkWorkerKind (EXEC-01 guard)', () => {
  it('fails when a non-test file declares a stub worker backend kind', () => {
    const root = fixture({
      'lib/worker/src/backend.ts': 'export const backend = { kind: "object_form_stub" };\n',
    });

    const result = checkWorkerKind(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toContain('object_form_stub');
    expect(result.failures.join('\n')).toContain('lib/worker/src/backend.ts');
  });

  it('passes when the only stub kind found is on the known-gap allowlist', () => {
    const root = fixture({
      'lib/worker-runtime/src/isolatedProcess.ts':
        'export class IsolatedProcessBackend {\n  readonly kind = "isolated_process_stub";\n}\n',
    });

    const result = checkWorkerKind(root);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('passes for a non-stub worker backend kind', () => {
    const root = fixture({
      'lib/worker/src/rootless.ts': 'export const backend = { kind: "rootless_isolated" };\n',
    });

    const result = checkWorkerKind(root);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('ignores stub kinds declared in *.test.ts files', () => {
    const root = fixture({
      'lib/worker/src/backend.test.ts': 'const kind = "test_only_stub";\n',
    });

    const result = checkWorkerKind(root);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('ignores the ci-checks guard sources themselves', () => {
    const root = fixture({
      'scripts/src/ci-checks/example.ts': 'const kind = "guard_source_stub";\n',
    });

    const result = checkWorkerKind(root);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });
});
