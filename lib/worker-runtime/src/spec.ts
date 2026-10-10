/**
 * The worker submission contract and its validator. Pure: no I/O, no side effects.
 *
 *   WorkerSpec ─▶ validateWorkerSpec ─▶ PolicyResult { ok, digest, egress, issues }
 *
 *   image.digest ─▶ /^sha256:[a-f0-9]{64}$/ ─▶ must be immutable-pinned
 *   limits.* ─────▶ all six must be positive safe integers
 *   network ──────▶ deny_all | allowlist (non-empty); metadata + control plane must be blocked
 *   env ──────────▶ unique /^[A-Za-z_][A-Za-z0-9_]*$/ names; secret_ref may not inline a value
 *
 *   Every rule appends an issue; validation never throws and never short-circuits.
 */

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ResourceLimits {
  readonly cpuMilli: number;
  readonly memoryBytes: number;
  readonly pidLimit: number;
  readonly diskBytes: number;
  readonly wallClockMs: number;
  readonly outputBytes: number;
}

export interface NetworkPolicy {
  readonly mode: "deny_all" | "allowlist";
  readonly allowedEgressHosts: readonly string[];
  readonly blockMetadataEndpoints: boolean;
  readonly blockControlPlane: boolean;
}

export interface ImagePin {
  readonly ref: string;
  readonly digest: string;
}

export interface EnvEntry {
  readonly name: string;
  readonly source: "literal" | "secret_ref";
  readonly value?: string;
  readonly secretRefId?: string;
}

export interface EnvSchema {
  readonly entries: readonly EnvEntry[];
}

export interface WorkerSpec {
  readonly runId: string;
  readonly attemptId?: string;
  readonly jobId?: string;
  readonly clusterId?: string;
  readonly image: ImagePin;
  readonly command?: readonly string[];
  readonly env: EnvSchema;
  readonly limits: ResourceLimits;
  readonly network: NetworkPolicy;
  readonly scratchDir?: string;
  readonly secretRefs?: readonly { name: string; secretRefId: string }[];
  readonly leaseToken?: string;
  readonly contentStoreConfig?: {
    masterKeyId: string;
    maxChunkSize?: number;
  };
}

export interface PolicyResult {
  readonly ok: boolean;
  readonly digest: string;
  readonly allowedEgressHosts: readonly string[];
  readonly issues: readonly string[];
}

export const METADATA_ENDPOINT_BLOCKLIST: readonly string[] = Object.freeze([
  "169.254.169.254",
  "169.254.169.253",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata",
]);

const CONTROL_PLANE_HOST_RE = /(^|\.)opennode-control-plane\.|^api\.|^cluster-admin\./i;

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}

function hostIsMetadata(host: string): boolean {
  const h = host.toLowerCase();
  return METADATA_ENDPOINT_BLOCKLIST.some((m) => h === m || h.endsWith(`.${m}`)) || h.startsWith("169.254.");
}

export function validateWorkerSpec(spec: WorkerSpec): PolicyResult {
  const issues: string[] = [];
  if (!spec.runId || typeof spec.runId !== "string") issues.push("runId is required");
  if (!DIGEST_RE.test(spec.image?.digest ?? "")) issues.push("image.digest must be an immutable sha256 digest");
  if (!spec.image?.ref) issues.push("image.ref is required");

  const l = spec.limits;
  if (!l || !isPositiveInt(l.cpuMilli)) issues.push("limits.cpuMilli must be a positive integer");
  if (!l || !isPositiveInt(l.memoryBytes)) issues.push("limits.memoryBytes must be a positive integer");
  if (!l || !isPositiveInt(l.pidLimit)) issues.push("limits.pidLimit must be a positive integer");
  if (!l || !isPositiveInt(l.diskBytes)) issues.push("limits.diskBytes must be a positive integer");
  if (!l || !isPositiveInt(l.wallClockMs)) issues.push("limits.wallClockMs must be a positive integer");
  if (!l || !isPositiveInt(l.outputBytes)) issues.push("limits.outputBytes must be a positive integer");

  const n = spec.network;
  if (!n) {
    issues.push("network policy is required");
  } else {
    if (n.mode !== "deny_all" && n.mode !== "allowlist") issues.push("network.mode must be deny_all or allowlist");
    if (n.mode === "allowlist" && n.allowedEgressHosts.length === 0) issues.push("allowlist mode requires explicit allowedEgressHosts");
    if (n.blockMetadataEndpoints !== true) issues.push("metadata endpoints must be blocked");
    if (n.blockControlPlane !== true) issues.push("control-plane endpoints must be blocked");
    for (const host of n.allowedEgressHosts) {
      if (hostIsMetadata(host)) issues.push(`egress host ${host} is a blocked metadata endpoint`);
      if (CONTROL_PLANE_HOST_RE.test(host)) issues.push(`egress host ${host} is a blocked control-plane endpoint`);
    }
  }

  if (!spec.env || !Array.isArray(spec.env.entries)) {
    issues.push("env schema is required");
  } else {
    const seen = new Set<string>();
    for (const e of spec.env.entries) {
      if (!ENV_NAME_RE.test(e.name)) issues.push(`env var ${e.name} has invalid name`);
      if (seen.has(e.name)) issues.push(`env var ${e.name} is duplicated`);
      seen.add(e.name);
      if (e.source === "secret_ref") {
        if (!e.secretRefId) issues.push(`env var ${e.name} secret_ref requires secretRefId`);
        if (e.value !== undefined) issues.push(`env var ${e.name} must not inline a secret value`);
      } else {
        if (e.value === undefined) issues.push(`env var ${e.name} literal requires value`);
      }
    }
  }

  if (spec.secretRefs) {
    const seenRefs = new Set<string>();
    for (const ref of spec.secretRefs) {
      if (!ref.name || !ref.secretRefId) issues.push("secretRef requires name and secretRefId");
      if (seenRefs.has(ref.name)) issues.push(`duplicate secret ref name: ${ref.name}`);
      seenRefs.add(ref.name);
    }
  }

  return {
    ok: issues.length === 0,
    digest: spec.image?.digest ?? "",
    allowedEgressHosts: spec.network?.allowedEgressHosts ?? [],
    issues,
  };
}
