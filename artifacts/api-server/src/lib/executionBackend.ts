import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectRootlessRuntime, type RootlessRuntimeKind } from "@workspace/worker-runtime";

export type ExecutionBackendSelection =
  | { readonly kind: RootlessRuntimeKind; readonly installPrefix: string; readonly rootfs?: string }
  | { readonly kind: "isolated_process"; readonly installPrefix?: string };

export interface BackendSelectionOptions {
  readonly cwd?: string;
  readonly repoRoot?: string;
}

export function resolveRepoRoot(cwd: string = process.cwd()): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate pnpm-workspace.yaml above ${cwd}`);
    }
    dir = parent;
  }
}

export function resolveExecutionBackend(
  env: NodeJS.ProcessEnv,
  opts: BackendSelectionOptions = {},
): ExecutionBackendSelection {
  const repoRoot = opts.repoRoot ?? resolveRepoRoot(opts.cwd ?? process.cwd());
  const installPrefix = env.OPENNODE_ROOTLESS_PREFIX ?? join(repoRoot, ".local", "rootless");
  const override = env.OPENNODE_EXECUTION_BACKEND;
  if (override === "udocker") return { kind: "udocker", installPrefix };
  if (override === "userns") return { kind: "userns", installPrefix, rootfs: join(installPrefix, "rootfs") };

  const rootfs = join(installPrefix, "rootfs");
  if (detectRootlessRuntime("userns", { installPrefix, rootfs })) {
    return { kind: "userns", installPrefix, rootfs };
  }
  if (detectRootlessRuntime("udocker", { installPrefix })) {
    return { kind: "udocker", installPrefix };
  }
  return { kind: "isolated_process" };
}