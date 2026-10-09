import { WorkerRuntimeError } from "./errors";

export interface NetworkRule {
  readonly chain: string;
  readonly rule: string;
}

export interface NftablesConfig {
  tableName: string;
  chainName: string;
  allowedEgressHosts: readonly string[];
  blockMetadataEndpoints: boolean;
  blockControlPlane: boolean;
  controlPlaneCidrs: readonly string[];
}

const DEFAULT_CONFIG: NftablesConfig = {
  tableName: "worker_isolation",
  chainName: "egress_filter",
  allowedEgressHosts: [],
  blockMetadataEndpoints: true,
  blockControlPlane: true,
  controlPlaneCidrs: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
};

const METADATA_IPS = ["169.254.169.254", "169.254.169.253"];

export class NftablesManager {
  private readonly config: NftablesConfig;
  private readonly cgroupPath: string;
  private applied = false;

  constructor(cgroupPath: string, config: Partial<NftablesConfig> = {}) {
    this.cgroupPath = cgroupPath;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async apply(): Promise<void> {
    if (this.applied) return;

    const rules = this.buildRules();
    for (const rule of rules) {
      await this.execNft(rule);
    }
    this.applied = true;
  }

  async remove(): Promise<void> {
    if (!this.applied) return;
    try {
      await this.execNft(`delete chain inet ${this.config.tableName} ${this.config.chainName}`);
      await this.execNft(`delete table inet ${this.config.tableName}`);
    } catch {
    }
    this.applied = false;
  }

  private buildRules(): string[] {
    const rules: string[] = [];
    const { tableName, chainName, allowedEgressHosts, blockMetadataEndpoints, blockControlPlane, controlPlaneCidrs } = this.config;
    const cgroupEscaped = this.cgroupPath.replace(/\//g, "\\/");

    rules.push(`add table inet ${tableName}`);
    rules.push(`add chain inet ${tableName} ${chainName} { type filter hook output priority filter ; policy drop ; }`);
    rules.push(`add rule inet ${tableName} ${chainName} meta cgroup ${cgroupEscaped} counter accept`);

    if (blockMetadataEndpoints) {
      for (const ip of METADATA_IPS) {
        rules.push(`add rule inet ${tableName} ${chainName} ip daddr ${ip} counter drop`);
      }
    }

    if (blockControlPlane) {
      for (const cidr of controlPlaneCidrs) {
        rules.push(`add rule inet ${tableName} ${chainName} ip daddr ${cidr} counter drop`);
      }
    }

    for (const host of allowedEgressHosts) {
      rules.push(`add rule inet ${tableName} ${chainName} ip daddr ${host} counter accept`);
    }

    rules.push(`add rule inet ${tableName} ${chainName} counter drop`);

    return rules;
  }

  private async execNft(args: string): Promise<void> {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const proc = spawn("nft", ["-f", "-"], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new WorkerRuntimeError(`nft failed: ${stderr}`, "nftables_error"));
      });
      proc.stdin?.write(args);
      proc.stdin?.end();
    });
  }
}

export async function isNftablesAvailable(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn("nft", ["--version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}