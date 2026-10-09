import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.local',
  'dist',
  'build',
  'coverage',
  '.turbo',
]);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|__test__|tests?)\//;

export function toPosix(path: string): string {
  return path.split('\\').join('/');
}

export function isTestFile(path: string): boolean {
  const p = toPosix(path);
  return TEST_FILE.test(p) || TEST_DIR.test(p);
}

/**
 * Recursively read every TypeScript source file under `root`, returning paths
 * relative to `root` using posix separators. `skip` receives each relative path
 * (file or directory) and may veto it. Generated/vendor directories are always
 * skipped.
 */
export function walkSourceFiles(
  root: string,
  skip: (relativePath: string) => boolean = () => false,
): SourceFile[] {
  const files: SourceFile[] = [];

  const visit = (dir: string, relative: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || skip(child)) continue;
        visit(join(dir, entry.name), child);
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !skip(child)) {
        files.push({ path: child, content: readFileSync(join(dir, entry.name), 'utf8') });
      }
    }
  };

  visit(root, '');
  return files;
}
