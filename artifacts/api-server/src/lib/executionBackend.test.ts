import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutionBackend, resolveRepoRoot } from "./executionBackend";

const temps: string[] = [];

function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "exec-backend-"));
  temps.push(dir);
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'lib/*'\n  - 'artifacts/*'\n");
  return dir;
}

function makeUDockerBinary(prefix: string): void {
  const dir = join(prefix, "udocker-venv", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "udocker"), "#!/bin/sh\necho udocker\n", { mode: 0o755 });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveRepoRoot", () => {
  it("walks up from a nested package cwd to the repo root", () => {
    const root = makeRepoRoot();
    const nested = join(root, "artifacts", "api-server");
    mkdirSync(nested, { recursive: true });
    expect(resolveRepoRoot(root)).toBe(root);
    expect(resolveRepoRoot(nested)).toBe(root);
  });
});

describe("resolveExecutionBackend", () => {
  it("maps an explicit userns override to the userns backend", () => {
    const root = makeRepoRoot();
    const selected = resolveExecutionBackend({ OPENNODE_EXECUTION_BACKEND: "userns" }, { repoRoot: root });
    expect(selected).toEqual({ kind: "userns", installPrefix: join(root, ".local", "rootless"), rootfs: join(root, ".local", "rootless", "rootfs") });
  });

  it("maps an explicit udocker override to the udocker backend", () => {
    const root = makeRepoRoot();
    const selected = resolveExecutionBackend({ OPENNODE_EXECUTION_BACKEND: "udocker" }, { repoRoot: root });
    expect(selected).toEqual({ kind: "udocker", installPrefix: join(root, ".local", "rootless") });
  });

  it("honors OPENNODE_ROOTLESS_PREFIX over the repo-root default", () => {
    const root = makeRepoRoot();
    const prefix = join(root, "custom-rootless");
    mkdirSync(join(prefix, "rootfs"), { recursive: true });
    const selected = resolveExecutionBackend(
      { OPENNODE_ROOTLESS_PREFIX: prefix },
      { repoRoot: root },
    );
    expect(selected).toEqual({ kind: "userns", installPrefix: prefix, rootfs: join(prefix, "rootfs") });
  });

  it("auto-detects userns when the rootfs exists and the backend is unset", () => {
    const root = makeRepoRoot();
    mkdirSync(join(root, ".local", "rootless", "rootfs"), { recursive: true });
    const selected = resolveExecutionBackend({}, { repoRoot: root });
    expect(selected).toEqual({
      kind: "userns",
      installPrefix: join(root, ".local", "rootless"),
      rootfs: join(root, ".local", "rootless", "rootfs"),
    });
  });

  it("falls back to udocker when no rootfs exists but the udocker binary is present", () => {
    const root = makeRepoRoot();
    makeUDockerBinary(join(root, ".local", "rootless"));
    const selected = resolveExecutionBackend({}, { repoRoot: root });
    expect(selected).toEqual({ kind: "udocker", installPrefix: join(root, ".local", "rootless") });
  });

  it("falls back to the isolated-process stub when no backend is present", () => {
    const root = makeRepoRoot();
    const selected = resolveExecutionBackend({}, { repoRoot: root });
    expect(selected).toEqual({ kind: "isolated_process" });
  });

  it("auto-detects from a nested cwd exactly as from the repo root", () => {
    const root = makeRepoRoot();
    mkdirSync(join(root, ".local", "rootless", "rootfs"), { recursive: true });
    expect(resolveExecutionBackend({}, { cwd: root })).toEqual(
      resolveExecutionBackend({}, { repoRoot: root }),
    );
  });
});

describe("host rootless availability at the repo prefix", () => {
  it("finds the configured rootless runtime or the stub fallback without throwing", () => {
    const repoRoot = resolveRepoRoot(process.cwd());
    const selected = resolveExecutionBackend(process.env, { repoRoot });
    if (selected.kind === "isolated_process") {
      expect(existsSync(join(repoRoot, ".local", "rootless", "rootfs"))).toBe(false);
    } else {
      expect(["userns", "udocker"]).toContain(selected.kind);
    }
  });
});