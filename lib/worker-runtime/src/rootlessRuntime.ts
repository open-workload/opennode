import { existsSync } from "node:fs";
import { join } from "node:path";
import { WorkerRuntimeError } from "./errors";

export type RootlessRuntimeKind = "udocker" | "userns";

export interface RootlessPaths {
  readonly installPrefix: string;
  readonly rootfs?: string;
}

export interface RootlessInvocationSpec {
  readonly kind: RootlessRuntimeKind;
  readonly image: string;
  readonly command: readonly string[];
  readonly workDir: string;
  readonly paths: RootlessPaths;
}

export interface RootlessInvocation {
  readonly file: string;
  readonly args: readonly string[];
}

export function udockerBinary(prefix: string): string {
  return join(prefix, "udocker-venv", "bin", "udocker");
}

export function buildRootlessInvocation(spec: RootlessInvocationSpec): RootlessInvocation {
  switch (spec.kind) {
    case "udocker":
      return {
        file: udockerBinary(spec.paths.installPrefix),
        args: [
          "run",
          "--hostauth",
          "--rm",
          "-v",
          `${spec.workDir}:/workspace`,
          "--workdir",
          "/workspace",
          spec.image,
          ...spec.command,
        ],
      };
    case "userns": {
      const rootfs = spec.paths.rootfs;
      if (!rootfs) {
        throw new WorkerRuntimeError("userns runtime requires a rootfs path", "missing_rootfs");
      }
      return {
        file: "unshare",
        args: [
          "--user",
          "--map-root-user",
          "--pid",
          "--fork",
          "--mount",
          "--net",
          "chroot",
          rootfs,
          ...spec.command,
        ],
      };
    }
    default:
      throw new WorkerRuntimeError(`unsupported rootless runtime: ${String(spec.kind)}`, "unsupported_runtime");
  }
}

export function detectRootlessRuntime(kind: RootlessRuntimeKind, paths: RootlessPaths): boolean {
  switch (kind) {
    case "udocker":
      return existsSync(udockerBinary(paths.installPrefix));
    case "userns":
      return existsSync("/usr/bin/unshare") && !!paths.rootfs && existsSync(paths.rootfs);
    default:
      throw new WorkerRuntimeError(`unsupported rootless runtime: ${String(kind)}`, "unsupported_runtime");
  }
}
