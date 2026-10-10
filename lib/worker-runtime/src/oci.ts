/**
 * Pulls an OCI image with skopeo, pins the digest, then verifies with cosign.
 *
 *   imageRef ─▶ skopeo copy ─▶ stdout digest ─┬─ mismatch ─▶ throw digest_mismatch
 *                                             └─ match
 *   expectedDigest ─────────────────────────▶│
 *                                             ▼
 *   ref@digest ─▶ cosign verify ─▶ policyResult (verified | error; never throws)
 *
 *   pull timeout (default 300s) ─▶ SIGKILL ─▶ reject timeout
 */

import { WorkerRuntimeError } from "./errors";

export interface ImagePullResult {
  readonly digest: string;
  readonly policyResult: PolicyVerificationResult;
  readonly pulledAt: number;
}

export interface PolicyVerificationResult {
  readonly verified: boolean;
  readonly policyName?: string;
  readonly error?: string;
}

export interface OciPullerOptions {
  readonly registryAuth?: { username: string; password: string };
  readonly cosignPublicKey?: string;
  readonly insecureSkipVerify?: boolean;
  readonly timeoutMs?: number;
}

export class OciPuller {
  private readonly options: OciPullerOptions;

  constructor(options: OciPullerOptions = {}) {
    this.options = options;
  }

  async pull(imageRef: string, expectedDigest: string): Promise<ImagePullResult> {
    const digest = await this.pullImage(imageRef);
    if (digest !== expectedDigest) {
      throw new WorkerRuntimeError(
        `Image digest mismatch: expected ${expectedDigest}, got ${digest}`,
        "digest_mismatch",
      );
    }

    const policyResult = await this.verifySignature(imageRef, digest);
    return {
      digest,
      policyResult,
      pulledAt: Date.now(),
    };
  }

  private async pullImage(ref: string): Promise<string> {
    const { spawn } = await import("node:child_process");
    const args = ["copy", "--all", `docker://${ref}`, "dir:/dev/null"];
    if (this.options.registryAuth) {
      args.unshift("--src-creds", `${this.options.registryAuth.username}:${this.options.registryAuth.password}`);
    }
    if (this.options.insecureSkipVerify) {
      args.unshift("--src-tls-verify=false");
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("skopeo", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          const match = stdout.match(/sha256:[a-f0-9]{64}/);
          if (match) resolve(match[0]);
          else reject(new WorkerRuntimeError("Failed to parse digest from skopeo output", "parse_error"));
        } else {
          reject(new WorkerRuntimeError(`skopeo pull failed: ${stderr}`, "pull_failed"));
        }
      });
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new WorkerRuntimeError("skopeo pull timeout", "timeout"));
      }, this.options.timeoutMs ?? 300000);
      proc.on("close", () => clearTimeout(timeout));
    });
  }

  private async verifySignature(ref: string, digest: string): Promise<PolicyVerificationResult> {
    if (!this.options.cosignPublicKey) {
      return { verified: false, error: "No cosign public key configured" };
    }

    const { spawn } = await import("node:child_process");
    const args = [
      "verify",
      "--key", this.options.cosignPublicKey,
      `${ref}@${digest}`,
    ];

    return new Promise((resolve) => {
      const proc = spawn("cosign", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      proc.on("error", () => resolve({ verified: false, error: "cosign not available" }));
      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ verified: true, policyName: "cosign" });
        } else {
          resolve({ verified: false, error: stderr.trim() || "cosign verification failed" });
        }
      });
    });
  }
}

export async function isSkopeoAvailable(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn("skopeo", ["--version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

export async function isCosignAvailable(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const proc = spawn("cosign", ["version"], { stdio: "ignore" });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}