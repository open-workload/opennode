import { describe, it, expect } from "vitest";
import { CgroupManager } from "./cgroup";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

async function isCgroupV2Writable(): Promise<boolean> {
  try {
    if (!(await CgroupManager.isV2Available())) {
      return false;
    }
    const mgr = new CgroupManager();
    const attemptId = `test-writable-${process.pid}-${Date.now()}`;
    const handle = await mgr.create(attemptId, { pidsMax: "16" });
    await handle.cleanup();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!(await isCgroupV2Writable()))("CgroupManager rootless", () => {
  it("limits pids when pidsMax=16", async () => {
    const mgr = new CgroupManager();
    const attemptId = `pids-limit-${process.pid}-${Date.now()}`;
    const handle = await mgr.create(attemptId, { pidsMax: "16" });

    const child = spawn(
      "bash",
      [
        "-c",
        "sleep 0.2; for i in $(seq 1 200); do (sleep 30) & done; wait 2>/dev/null; sleep 0.5",
      ],
      { stdio: "ignore" },
    );

    await handle.enter(child.pid);

    // Give time for processes to spawn and be limited
    await new Promise((r) => setTimeout(r, 300));

    try {
      const pidsCurrent = await readFile(join(handle.path, "pids.current"), "utf8");
      const count = parseInt(pidsCurrent.trim());
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThanOrEqual(16);
      // Kill all processes in the cgroup before removal to avoid leaks
      try {
        await writeFile(join(handle.path, "cgroup.kill"), "1");
      } catch {
        child.kill("SIGKILL");
      }
    } finally {
      try {
        await writeFile(join(handle.path, "cgroup.kill"), "1");
      } catch {
        child.kill("SIGKILL");
      }
      await handle.cleanup();
    }
  }, 5000);

  it("cleanup removes the cgroup directory", async () => {
    const mgr = new CgroupManager();
    const attemptId = `cleanup-${process.pid}-${Date.now()}`;
    const handle = await mgr.create(attemptId, { pidsMax: "16" });

    const child = spawn("sleep", ["0.1"], { stdio: "ignore" });
    await handle.enter(child.pid);
    child.kill("SIGKILL");

    await handle.cleanup();

    // Directory should be gone
    expect(existsSync(handle.path)).toBe(false);
  }, 5000);
});
