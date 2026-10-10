import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const BUSYBOX_URL =
  'https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox';

export const BUSYBOX_SHA256 =
  '6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348';

const ROOTFS_DIRS = ['bin', 'dev', 'proc', 'sys', 'tmp', 'etc', 'root', 'work'] as const;

export interface RootlessInstallPaths {
  readonly prefix: string;
  readonly busybox: string;
  readonly rootfs: string;
  readonly udockerBin: string;
}

export function rootlessPaths(prefix: string): RootlessInstallPaths {
  const resolved = resolve(prefix);
  return {
    prefix: resolved,
    busybox: join(resolved, 'busybox'),
    rootfs: join(resolved, 'rootfs'),
    udockerBin: join(resolved, 'udocker-venv', 'bin', 'udocker'),
  };
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export async function fetchBusybox(
  paths: RootlessInstallPaths,
  fetchImpl: FetchLike = fetch,
): Promise<{ sha256: string; bytes: number }> {
  const response = await fetchImpl(BUSYBOX_URL);
  if (!response.ok) {
    throw new Error(`failed to download busybox: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== BUSYBOX_SHA256) {
    throw new Error(
      `busybox checksum mismatch: expected ${BUSYBOX_SHA256}, got ${sha256}`,
    );
  }

  await mkdir(dirname(paths.busybox), { recursive: true });
  await writeFile(paths.busybox, bytes);
  await chmod(paths.busybox, 0o755);
  return { sha256, bytes: bytes.byteLength };
}

export interface BusyboxRootfsFsOps {
  mkdir(path: string): Promise<unknown>;
  copyFile(src: string, dest: string): Promise<unknown>;
  symlink(target: string, linkPath: string): Promise<unknown>;
  runBusybox(file: string, args: readonly string[]): Promise<string>;
}

const defaultBusyboxFsOps: BusyboxRootfsFsOps = {
  mkdir: (path) => mkdir(path, { recursive: true }),
  copyFile: (src, dest) => copyFile(src, dest),
  symlink: (target, linkPath) => symlink(target, linkPath),
  runBusybox: async (file, args) => {
    const { stdout } = await execFileAsync(file, [...args]);
    return stdout;
  },
};

export async function buildBusyboxRootfs(
  paths: RootlessInstallPaths,
  fsOps: BusyboxRootfsFsOps = defaultBusyboxFsOps,
): Promise<void> {
  for (const dir of ROOTFS_DIRS) {
    await fsOps.mkdir(join(paths.rootfs, dir));
  }

  const binBusybox = join(paths.rootfs, 'bin', 'busybox');
  await fsOps.copyFile(paths.busybox, binBusybox);

  const listing = await fsOps.runBusybox(paths.busybox, ['--list']);
  const applets = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((applet) => applet.length > 0 && applet !== 'busybox');

  for (const applet of applets) {
    const linkPath = join(paths.rootfs, 'bin', applet);
    try {
      await fsOps.symlink('busybox', linkPath);
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }
}

export type RunCommand = (command: string, args: readonly string[]) => Promise<void>;

const defaultRunCommand: RunCommand = async (command, args) => {
  await execFileAsync(command, [...args]);
};

export async function installUdocker(
  paths: RootlessInstallPaths,
  run: RunCommand = defaultRunCommand,
): Promise<void> {
  const venv = join(paths.prefix, 'udocker-venv');
  await run('python3', ['-m', 'venv', venv]);
  await run(join(venv, 'bin', 'python'), ['-m', 'pip', 'install', 'udocker']);
  await run(paths.udockerBin, ['install']);
}

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

export interface InstallRootlessOptions {
  readonly prefix?: string;
  readonly withUdocker?: boolean;
}

export async function installRootlessRuntime(
  opts: InstallRootlessOptions = {},
): Promise<RootlessInstallPaths> {
  const prefix = opts.prefix ?? join(repoRoot(), '.local', 'rootless');
  const paths = rootlessPaths(prefix);

  await mkdir(paths.prefix, { recursive: true });
  await fetchBusybox(paths);
  await buildBusyboxRootfs(paths);
  if (opts.withUdocker ?? true) {
    await installUdocker(paths);
  }
  return paths;
}

export async function main(): Promise<void> {
  const paths = await installRootlessRuntime();
  console.log(`rootless runtime installed at ${paths.prefix}`);
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
