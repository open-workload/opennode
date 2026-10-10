import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildBusyboxRootfs,
  fetchBusybox,
  installUdocker,
  rootlessPaths,
} from './install';

const prefix = '/tmp/rootless-prefix';

describe('rootlessPaths', () => {
  it('derives busybox, rootfs, and udocker paths from the prefix', () => {
    const paths = rootlessPaths(prefix);
    const resolved = resolve(prefix);

    expect(paths).toEqual({
      prefix: resolved,
      busybox: join(resolved, 'busybox'),
      rootfs: join(resolved, 'rootfs'),
      udockerBin: join(resolved, 'udocker-venv', 'bin', 'udocker'),
    });
  });
});

describe('buildBusyboxRootfs', () => {
  it('creates the rootfs dirs, copies busybox, runs --list, and symlinks every applet', async () => {
    const paths = rootlessPaths(prefix);
    const mkdirs: string[] = [];
    const copies: Array<[string, string]> = [];
    const symlinks: Array<[string, string]> = [];
    const runs: Array<{ file: string; args: readonly string[] }> = [];

    await buildBusyboxRootfs(paths, {
      mkdir: async (path) => {
        mkdirs.push(path);
      },
      copyFile: async (src, dest) => {
        copies.push([src, dest]);
      },
      symlink: async (target, linkPath) => {
        symlinks.push([target, linkPath]);
      },
      runBusybox: async (file, args) => {
        runs.push({ file, args });
        return 'ls\ncat\nbusybox\n';
      },
    });

    expect(mkdirs).toEqual([
      join(paths.rootfs, 'bin'),
      join(paths.rootfs, 'dev'),
      join(paths.rootfs, 'proc'),
      join(paths.rootfs, 'sys'),
      join(paths.rootfs, 'tmp'),
      join(paths.rootfs, 'etc'),
      join(paths.rootfs, 'root'),
      join(paths.rootfs, 'work'),
    ]);
    expect(copies).toEqual([[paths.busybox, join(paths.rootfs, 'bin', 'busybox')]]);
    expect(runs).toEqual([{ file: paths.busybox, args: ['--list'] }]);
    expect(symlinks).toEqual([
      ['busybox', join(paths.rootfs, 'bin', 'ls')],
      ['busybox', join(paths.rootfs, 'bin', 'cat')],
    ]);
  });

  it('is idempotent when run twice', async () => {
    const paths = rootlessPaths(prefix);
    const mkdirs: string[] = [];
    const copies: Array<[string, string]> = [];
    const symlinks: Array<[string, string]> = [];
    const runs: Array<{ file: string; args: readonly string[] }> = [];

    const fsOps = {
      mkdir: async (path: string) => {
        mkdirs.push(path);
      },
      copyFile: async (src: string, dest: string) => {
        copies.push([src, dest]);
      },
      symlink: async (target: string, linkPath: string) => {
        symlinks.push([target, linkPath]);
      },
      runBusybox: async (file: string, args: readonly string[]) => {
        runs.push({ file, args });
        return 'ls\ncat\nbusybox\n';
      },
    };

    await buildBusyboxRootfs(paths, fsOps);
    await buildBusyboxRootfs(paths, fsOps);

    expect(runs).toHaveLength(2);
    expect(symlinks).toHaveLength(4);
  });
});

describe('fetchBusybox', () => {
  it('rejects when the downloaded sha256 does not match the pinned checksum', async () => {
    const paths = rootlessPaths(prefix);
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    });

    await expect(fetchBusybox(paths, fakeFetch)).rejects.toThrow(/checksum/i);
  });

  it('rejects a non-ok response', async () => {
    const paths = rootlessPaths(prefix);
    const fakeFetch = async () => ({
      ok: false,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(fetchBusybox(paths, fakeFetch)).rejects.toThrow(/503/);
  });
});

describe('installUdocker', () => {
  it('creates the venv, pip-installs udocker, then runs udocker install in order', async () => {
    const paths = rootlessPaths(prefix);
    const calls: Array<[string, readonly string[]]> = [];

    await installUdocker(paths, async (command, args) => {
      calls.push([command, args]);
    });

    expect(calls).toEqual([
      ['python3', ['-m', 'venv', join(paths.prefix, 'udocker-venv')]],
      [join(paths.prefix, 'udocker-venv', 'bin', 'python'), ['-m', 'pip', 'install', 'udocker']],
      [paths.udockerBin, ['install']],
    ]);
  });
});
