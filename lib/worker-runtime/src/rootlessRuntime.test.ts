import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { WorkerRuntimeError } from './errors';
import {
  udockerBinary,
  buildRootlessInvocation,
  detectRootlessRuntime,
  type RootlessRuntimeKind,
} from './rootlessRuntime';

const prefix = '/opt/rootless';

describe('udockerBinary', () => {
  it('resolves the udocker launcher inside the install prefix', () => {
    expect(udockerBinary(prefix)).toBe(join(prefix, 'udocker-venv', 'bin', 'udocker'));
  });
});

describe('buildRootlessInvocation', () => {
  const image = 'ghcr.io/example/scratch@sha256:abc';
  const command = ['/bin/sh', '-c', 'echo hi'];

  it('builds the udocker argv with hostauth and the workspace bind', () => {
    const invocation = buildRootlessInvocation({
      kind: 'udocker',
      image,
      command,
      workDir: '/srv/runs/run-1/workspace',
      paths: { installPrefix: prefix },
    });

    expect(invocation).toEqual({
      file: join(prefix, 'udocker-venv', 'bin', 'udocker'),
      args: [
        'run',
        '--hostauth',
        '--rm',
        '-v',
        '/srv/runs/run-1/workspace:/workspace',
        '--workdir',
        '/workspace',
        image,
        ...command,
      ],
    });
  });

  it('builds the userns argv with unshare and chroot', () => {
    const rootfs = '/var/lib/rootless/rootfs-1';
    const invocation = buildRootlessInvocation({
      kind: 'userns',
      image,
      command,
      workDir: '/srv/runs/run-1/workspace',
      paths: { installPrefix: prefix, rootfs },
    });

    expect(invocation).toEqual({
      file: 'unshare',
      args: [
        '--user',
        '--map-root-user',
        '--pid',
        '--fork',
        '--mount',
        '--net',
        'chroot',
        rootfs,
        ...command,
      ],
    });
  });

  it('throws missing_rootfs when userns has no rootfs', () => {
    const build = () =>
      buildRootlessInvocation({
        kind: 'userns',
        image,
        command,
        workDir: '/srv/runs/run-1/workspace',
        paths: { installPrefix: prefix },
      });

    let caught: unknown;
    try {
      build();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkerRuntimeError);
    expect((caught as WorkerRuntimeError).code).toBe('missing_rootfs');
  });

  it('throws missing_rootfs when userns rootfs is empty', () => {
    expect(() =>
      buildRootlessInvocation({
        kind: 'userns',
        image,
        command,
        workDir: '/srv/runs/run-1/workspace',
        paths: { installPrefix: prefix, rootfs: '' },
      }),
    ).toThrowError(WorkerRuntimeError);
  });

  it('throws unsupported_runtime for an unexpected kind', () => {
    let caught: unknown;
    try {
      buildRootlessInvocation({
        kind: 'podman' as RootlessRuntimeKind,
        image,
        command,
        workDir: '/srv/runs/run-1/workspace',
        paths: { installPrefix: prefix },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkerRuntimeError);
    expect((caught as WorkerRuntimeError).code).toBe('unsupported_runtime');
  });
});

describe('detectRootlessRuntime', () => {
  it('reports udocker as unavailable when the launcher is missing', () => {
    expect(detectRootlessRuntime('udocker', { installPrefix: '/nonexistent-rootless' })).toBe(false);
  });

  it('reports userns as unavailable when rootfs is absent', () => {
    expect(detectRootlessRuntime('userns', { installPrefix: prefix })).toBe(false);
  });

  it('reports userns as unavailable when rootfs is empty', () => {
    expect(detectRootlessRuntime('userns', { installPrefix: prefix, rootfs: '' })).toBe(false);
  });

  it('reports userns as unavailable when rootfs does not exist', () => {
    expect(detectRootlessRuntime('userns', { installPrefix: prefix, rootfs: '/nonexistent-rootfs' })).toBe(false);
  });
});
