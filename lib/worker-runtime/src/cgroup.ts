import { mkdtemp, writeFile, readFile, rm, mkdir, stat, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRuntimeError } from "./errors";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CgroupConfig {
  cpuMax?: string;
  memoryMax?: string;
  pidsMax?: string;
  ioMax?: string;
}

export interface CgroupHandle {
  path: string;
  enter(pid: number): Promise<void>;
  cleanup(): Promise<void>;
}

export class CgroupManager {
  private readonly root: string;
  private readonly basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? "/sys/fs/cgroup";
    this.root = join(this.basePath, "worker-runtime");
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });

    let available: string;
    try {
      available = await readFile(join(this.root, "cgroup.controllers"), "utf8");
    } catch {
      return;
    }
    let enabled = "";
    try {
      enabled = await readFile(join(this.root, "cgroup.subtree_control"), "utf8");
    } catch {
      // subtree_control is not readable yet; treat as nothing enabled
    }
    const have = new Set(available.split(/\s+/).filter(Boolean));
    const on = new Set(enabled.split(/\s+/).filter(Boolean));
    const missing = ["cpu", "memory", "pids"].filter((c) => have.has(c) && !on.has(c));
    if (missing.length > 0) {
      await writeFile(
        join(this.root, "cgroup.subtree_control"),
        missing.map((c) => `+${c}`).join(" "),
      );
    }
  }

  async create(attemptId: string, config: CgroupConfig): Promise<CgroupHandle> {
    await this.ensureRoot();
    const cgroupPath = join(this.root, attemptId);
    await mkdir(cgroupPath, { recursive: true });

    const tasks: Array<Promise<void>> = [];
    if (config.cpuMax) {
      tasks.push(writeFile(join(cgroupPath, "cpu.max"), config.cpuMax));
    }
    if (config.memoryMax) {
      tasks.push(writeFile(join(cgroupPath, "memory.max"), config.memoryMax));
    }
    if (config.pidsMax) {
      tasks.push(writeFile(join(cgroupPath, "pids.max"), config.pidsMax));
    }
    try {
      await Promise.all(tasks);
    } catch (err) {
      try {
        await rmdir(cgroupPath);
      } catch {
      }
      throw err;
    }

    if (config.ioMax) {
      try {
        await writeFile(join(cgroupPath, "io.max"), config.ioMax);
      } catch {
        // io.max may not be available/enabled on some rootless cgroup v2 setups
      }
    }

    return {
      path: cgroupPath,
      enter: async (pid: number) => {
        await writeFile(join(cgroupPath, "cgroup.procs"), String(pid));
      },
      cleanup: async () => {
        try {
          try {
            await writeFile(join(cgroupPath, "cgroup.kill"), "1");
          } catch {
            // ignore
          }
          const attempts = 10;
          let removed = false;
          for (let i = 0; i < attempts; i++) {
            try {
              await rmdir(cgroupPath);
              removed = true;
              break;
            } catch {
              await delay(100);
            }
          }
          if (!removed) {
            await rm(cgroupPath, { recursive: true, force: true });
          }
        } catch {
        }
      },
    };
  }

  static async isV2Available(): Promise<boolean> {
    try {
      const st = await stat("/sys/fs/cgroup/cgroup.controllers");
      return st.isFile();
    } catch {
      return false;
    }
  }
}

function formatCpuMax(milli: number): string {
  const period = 100000;
  const quota = Math.max(1, Math.floor((milli / 1000) * period));
  return `${quota} ${period}`;
}

function formatMemoryMax(bytes: number): string {
  return String(bytes);
}

function formatPidsMax(limit: number): string {
  return String(limit);
}

function formatIoMax(bytes: number): string {
  return `rbps=${bytes} wbps=${bytes}`;
}

export function createCgroupConfigFromLimits(limits: {
  cpuMilli: number;
  memoryBytes: number;
  pidLimit: number;
  diskBytes: number;
}): CgroupConfig {
  return {
    cpuMax: formatCpuMax(limits.cpuMilli),
    memoryMax: formatMemoryMax(limits.memoryBytes),
    pidsMax: formatPidsMax(limits.pidLimit),
    ioMax: formatIoMax(limits.diskBytes),
  };
}