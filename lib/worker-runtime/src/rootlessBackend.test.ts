import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RootlessBackend } from './rootlessBackend';
import { detectRootlessRuntime } from './rootlessRuntime';
import type { WorkerSpec } from './spec';
import type { RootlessInvocation } from './rootlessRuntime';

type Limits = WorkerSpec['limits'];

function limits(overrides: Partial<Limits> = {}): Limits {
  return {
    cpuMilli: 1000,
    memoryBytes: 64 * 1024 * 1024,
    pidLimit: 64,
    diskBytes: 64 * 1024 * 1024,
    wallClockMs: 5000,
    outputBytes: 65536,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<WorkerSpec> = {}): WorkerSpec {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    image: { ref: 'busybox:1.35', digest: `sha256:${'a'.repeat(64)}` },
    command: ['/bin/true'],
    env: { entries: [] },
    limits: limits(),
    network: {
      mode: 'deny_all',
      allowedEgressHosts: [],
      blockMetadataEndpoints: true,
      blockControlPlane: true,
    },
    ...overrides,
  };
}

const sh = (script: string) => (): RootlessInvocation => ({ file: '/bin/sh', args: ['-c', script] });

describe('RootlessBackend unit behavior (via invocationFactory seam)', () => {
  it('reports success with exit code 0 and captured output bytes', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: sh('echo hello-from-worker; exit 0'),
    });
    const handle = await backend.start(makeSpec());
    const result = await handle.wait();

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.outputBytes).toBeGreaterThan(0);
    await handle.cleanup();
  });

  it('reports failure with the numeric exit code', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: sh('exit 7'),
    });
    const handle = await backend.start(makeSpec());
    const result = await handle.wait();

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(7);
    await handle.cleanup();
  });

  it('enforces the wall clock externally and resolves timed_out', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: sh('exec sleep 5'),
    });
    const started = Date.now();
    const handle = await backend.start(makeSpec({ limits: limits({ wallClockMs: 150 }) }));
    const result = await handle.wait();

    expect(result.status).toBe('timed_out');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
    await handle.cleanup();
  });

  it('cancels a running workload and resolves cancelled', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: sh('exec sleep 5'),
    });
    const handle = await backend.start(makeSpec());
    await handle.cancel('cancelled');
    const result = await handle.wait();

    expect(result.status).toBe('cancelled');
    await handle.cleanup();
  });

  it('bounds captured output to the configured cap and stops the process', async () => {
    const work = `echo $$ > PIDFILE; while true; do printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done`;
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: (_spec, workDir) => ({
        file: '/bin/sh',
        args: ['-c', work.replace('PIDFILE', `${workDir}/pid`)],
      }),
    });
    const handle = await backend.start(makeSpec({ limits: limits({ outputBytes: 1024 }) }));
    const result = await handle.wait();

    expect(result.outputBytes).toBeLessThanOrEqual(1024);
    expect(handle.state()).toBe('finished');
    const pid = Number(readFileSync(join(handle.backendRunId, 'work', 'pid'), 'utf8').trim());
    expect(() => process.kill(pid, 0)).toThrow();
    await handle.cleanup();
  });

  it('injects literal env entries by name', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: sh('test "$FOO" = bar && exit 0 || exit 1'),
    });
    const handle = await backend.start(
      makeSpec({ env: { entries: [{ name: 'FOO', source: 'literal', value: 'bar' }] } }),
    );
    const result = await handle.wait();

    expect(result.status).toBe('succeeded');
    await handle.cleanup();
  });

  it('removes the scratch directory on cleanup', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix: '/nonexistent',
      invocationFactory: sh('exit 0'),
    });
    const handle = await backend.start(makeSpec());
    await handle.wait();
    const scratchDir = handle.backendRunId;
    expect(existsSync(scratchDir)).toBe(true);

    const report = await handle.cleanup();
    expect(report.scratchRemoved).toBe(true);
    expect(existsSync(scratchDir)).toBe(false);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const installPrefix = join(repoRoot, '.local', 'rootless');
const rootfs = join(installPrefix, 'rootfs');

function hostPidsMatching(pattern: RegExp): number[] {
  const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m && pattern.test(m[2])) pids.push(Number(m[1]));
  }
  return pids;
}

const orphanSleepPids = () => hostPidsMatching(/^\/bin\/sleep 300$/);

async function until(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!condition()) throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!existsSync(rootfs))('RootlessBackend real userns integration (EXEC-01)', () => {
  it('runs a real rootless container and captures its output', async () => {
    expect(detectRootlessRuntime('userns', { installPrefix, rootfs })).toBe(true);

    const backend = new RootlessBackend({ kind: 'userns', installPrefix, rootfs, scratchRoot: tmpdir() });
    const handle = await backend.start(
      makeSpec({ command: ['/bin/sh', '-c', 'echo real-rootless-ok'] }),
    );
    const result = await handle.wait();

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);

    const captured = readFileSync(join(result.backendRunId, 'output.log'), 'utf8');
    expect(captured).toContain('real-rootless-ok');

    const report = await handle.cleanup();
    expect(report.scratchRemoved).toBe(true);
  });

  it('kills the whole process group on cancel: no orphaned sleep survives, scratch removed (EXEC-10)', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix,
      rootfs,
      scratchRoot: tmpdir(),
      killGraceMs: 500,
    });
    const handle = await backend.start(
      makeSpec({
        command: ['/bin/sh', '-c', 'exec /bin/sleep 300'],
        limits: limits({ wallClockMs: 60000 }),
      }),
    );
    await until(() => orphanSleepPids().length > 0, 5000, 'userns sleep workload to start');

    await handle.cancel('cancelled');
    const result = await handle.wait();
    expect(result.status).toBe('cancelled');

    await until(() => orphanSleepPids().length === 0, 5000, 'orphaned sleep to be reaped');
    expect(orphanSleepPids()).toEqual([]);

    const scratchDir = handle.backendRunId;
    const report = await handle.cleanup();
    expect(report.scratchRemoved).toBe(true);
    expect(existsSync(scratchDir)).toBe(false);
  }, 20000);

  it('kills the whole process group after a wall-clock timeout: no orphaned sleep survives, scratch removed (EXEC-13)', async () => {
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix,
      rootfs,
      scratchRoot: tmpdir(),
      killGraceMs: 500,
    });
    const handle = await backend.start(
      makeSpec({
        command: ['/bin/sh', '-c', 'exec /bin/sleep 300'],
        limits: limits({ wallClockMs: 500 }),
      }),
    );
    await until(() => orphanSleepPids().length > 0, 5000, 'userns sleep workload to start');

    const result = await handle.wait();
    expect(result.status).toBe('timed_out');

    await until(() => orphanSleepPids().length === 0, 5000, 'timed-out sleep to be reaped');
    expect(orphanSleepPids()).toEqual([]);

    const scratchDir = handle.backendRunId;
    const report = await handle.cleanup();
    expect(report.scratchRemoved).toBe(true);
    expect(existsSync(scratchDir)).toBe(false);
  }, 20000);

  it('caps output far above the limit on a real userns run and leaves no spinner running', async () => {
    const marker = 'OUTCAP-MARK';
    const loop = `while :; do printf '${marker}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done`;
    const backend = new RootlessBackend({
      kind: 'userns',
      installPrefix,
      rootfs,
      scratchRoot: tmpdir(),
      killGraceMs: 500,
    });
    const handle = await backend.start(
      makeSpec({
        command: ['/bin/sh', '-c', loop],
        limits: limits({ outputBytes: 1024, wallClockMs: 60000 }),
      }),
    );
    const result = await handle.wait();

    expect(result.outputBytes).toBeLessThanOrEqual(1024);
    expect(handle.state()).toBe('finished');

    await until(() => hostPidsMatching(new RegExp(marker)).length === 0, 5000, 'spinner to be killed');
    expect(hostPidsMatching(new RegExp(marker))).toEqual([]);

    await handle.cleanup();
  }, 20000);

  it('hides host files outside the rootfs and reports uid 0 inside', async () => {
    const markerPath = join('/tmp/opencode', `host-marker-${process.pid}`);
    await mkdir('/tmp/opencode', { recursive: true });
    await writeFile(markerPath, 'host-secret-marker', 'utf8');

    try {
      const backend = new RootlessBackend({ kind: 'userns', installPrefix, rootfs, scratchRoot: tmpdir() });
      const handle = await backend.start(
        makeSpec({
          command: [
            '/bin/sh',
            '-c',
            `/bin/cat ${markerPath} && echo LEAKED; /bin/id -u`,
          ],
          limits: limits({ wallClockMs: 15000 }),
        }),
      );
      const result = await handle.wait();

      expect(result.status).toBe('succeeded');
      const captured = readFileSync(join(result.backendRunId, 'output.log'), 'utf8');
      expect(captured).not.toContain('host-secret-marker');
      expect(captured).not.toContain('LEAKED');
      expect(captured.trim().split('\n').pop()).toBe('0');

      await handle.cleanup();
    } finally {
      rmSync(markerPath, { force: true });
    }
  }, 20000);

  it('injects literal env entries into a real userns run', async () => {
    const backend = new RootlessBackend({ kind: 'userns', installPrefix, rootfs, scratchRoot: tmpdir() });
    const handle = await backend.start(
      makeSpec({
        command: ['/bin/sh', '-c', 'test "$MARKER_ENV" = injected-42'],
        env: { entries: [{ name: 'MARKER_ENV', source: 'literal', value: 'injected-42' }] },
        limits: limits({ wallClockMs: 15000 }),
      }),
    );
    const result = await handle.wait();

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    await handle.cleanup();
  }, 20000);
});
