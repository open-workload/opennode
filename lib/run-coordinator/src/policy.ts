import { RunCoordinatorError } from "./errors";

export type SideEffectClass = "idempotent" | "at-least-once" | "exactly-once-external";

export interface ResourceLimits {
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
  readonly timeoutSeconds: number;
}

/**
 * Cluster admission quotas. validateSpec may only depend on the spec and
 * this policy; concurrency checks live in RunCoordinator.validate, which
 * additionally consults committed state.
 */
export interface QuotaPolicy {
  readonly maxConcurrentRuns: number;
  readonly maxQueuedRuns: number;
  readonly maxDurationMs: number;
  readonly maxCpuMilli: number;
  readonly maxMemoryMiB: number;
  readonly maxDiskMiB: number;
  readonly maxOutputBytes: number;
  readonly maxAttempts: number;
  readonly requireDigestPinnedImage: boolean;
  readonly allowedImagePrefixes: readonly string[];
  readonly allowedSecretRefPrefixes: readonly string[];
  readonly maxCpuMilliPerTenant: number;
  readonly maxMemoryMiBPerTenant: number;
  readonly maxDiskMiBPerTenant: number;
  readonly maxConcurrentRunsPerTenant: number;
}

export interface RunSpec {
  readonly name: string;
  readonly mode: "built-in-diagnostic" | "container";
  readonly image: string | null;
  readonly command: readonly string[];
  readonly resources: ResourceLimits;
  readonly expectedOutputBytes: number;
  readonly secretRefs: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly networkPolicy: "deny_all" | "allowlist";
  readonly sideEffectClass: SideEffectClass;
  readonly tenantId: string;
  readonly projectId: string;
}

export interface ValidatedRunSpec extends RunSpec {
  readonly resources: ResourceLimits;
}

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateRunSpec(
  spec: RunSpec,
  quotas: QuotaPolicy,
): ValidatedRunSpec {
  if (typeof spec !== "object" || spec === null) {
    throw new RunCoordinatorError("INVALID_RUN_SPEC", "A run spec is required.");
  }
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    throw new RunCoordinatorError("INVALID_RUN_SPEC", "name is required.");
  }
  if (spec.mode !== "built-in-diagnostic" && spec.mode !== "container") {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "mode must be built-in-diagnostic or container.",
    );
  }
  if (spec.mode === "container") {
    if (typeof spec.image !== "string" || spec.image.trim().length === 0) {
      throw new RunCoordinatorError(
        "INVALID_RUN_SPEC",
        "Container runs require an image.",
      );
    }
    if (
      quotas.allowedImagePrefixes.length > 0 &&
      !quotas.allowedImagePrefixes.some((p) => spec.image!.startsWith(p))
    ) {
      throw new RunCoordinatorError(
        "IMAGE_POLICY_VIOLATION",
        `Image ${spec.image} is not in the allowed registry prefixes.`,
      );
    }
    if (quotas.requireDigestPinnedImage && !spec.image.includes("@sha256:")) {
      throw new RunCoordinatorError(
        "IMAGE_POLICY_VIOLATION",
        "Images must be pinned by digest.",
      );
    }
  } else {
    if (spec.image !== null) {
      throw new RunCoordinatorError(
        "INVALID_RUN_SPEC",
        "Diagnostic runs must not specify an image.",
      );
    }
  }
  if (!Array.isArray(spec.command)) {
    throw new RunCoordinatorError("INVALID_RUN_SPEC", "command must be an array.");
  }
  if (spec.command.length > 128) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "command must have at most 128 items.",
    );
  }
  for (const arg of spec.command) {
    if (typeof arg !== "string" || arg.trim().length === 0) {
      throw new RunCoordinatorError(
        "INVALID_RUN_SPEC",
        "command items must be non-empty strings.",
      );
    }
    if (arg.length > 4096) {
      throw new RunCoordinatorError(
        "INVALID_RUN_SPEC",
        "command items must be at most 4096 characters.",
      );
    }
  }
  const r = spec.resources;
  if (
    typeof r !== "object" ||
    r === null ||
    !isPositiveInt(r.cpuMilli) ||
    r.cpuMilli === 0 ||
    !isPositiveInt(r.memoryMiB) ||
    r.memoryMiB === 0 ||
    !isPositiveInt(r.diskMiB) ||
    r.diskMiB === 0 ||
    !isPositiveInt(r.timeoutSeconds) ||
    r.timeoutSeconds === 0
  ) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "Resources must be positive integers.",
    );
  }
  if (r.cpuMilli > quotas.maxCpuMilli) {
    throw new RunCoordinatorError("QUOTA_EXCEEDED", "cpuMilli exceeds quota.");
  }
  if (r.memoryMiB > quotas.maxMemoryMiB) {
    throw new RunCoordinatorError("QUOTA_EXCEEDED", "memoryMiB exceeds quota.");
  }
  if (r.diskMiB > quotas.maxDiskMiB) {
    throw new RunCoordinatorError("QUOTA_EXCEEDED", "diskMiB exceeds quota.");
  }
  if (r.timeoutSeconds * 1000 > quotas.maxDurationMs) {
    throw new RunCoordinatorError("QUOTA_EXCEEDED", "duration exceeds quota.");
  }
  if (
    !Number.isSafeInteger(spec.expectedOutputBytes) ||
    spec.expectedOutputBytes < 0
  ) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "expectedOutputBytes must be a non-negative safe integer.",
    );
  }
  if (spec.expectedOutputBytes > quotas.maxOutputBytes) {
    throw new RunCoordinatorError("QUOTA_EXCEEDED", "output exceeds quota.");
  }
  if (!Array.isArray(spec.secretRefs)) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "secretRefs must be an array.",
    );
  }
  for (const ref of spec.secretRefs) {
    if (typeof ref !== "string" || ref.trim().length === 0) {
      throw new RunCoordinatorError(
        "INVALID_RUN_SPEC",
        "Secret refs must be non-empty strings.",
      );
    }
    if (
      quotas.allowedSecretRefPrefixes.length > 0 &&
      !quotas.allowedSecretRefPrefixes.some((p) => ref.startsWith(p))
    ) {
      throw new RunCoordinatorError(
        "SECRET_REF_VIOLATION",
        `Secret ref ${ref} is not authorized.`,
      );
    }
  }
  if (!Array.isArray(spec.requiredCapabilities)) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "requiredCapabilities must be an array.",
    );
  }
  for (const cap of spec.requiredCapabilities) {
    if (typeof cap !== "string" || cap.trim().length === 0) {
      throw new RunCoordinatorError(
        "INVALID_RUN_SPEC",
        "Capabilities must be non-empty strings.",
      );
    }
  }
  if (spec.networkPolicy !== "deny_all" && spec.networkPolicy !== "allowlist") {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "networkPolicy must be deny_all or allowlist.",
    );
  }
  if (
    spec.sideEffectClass !== "idempotent" &&
    spec.sideEffectClass !== "at-least-once" &&
    spec.sideEffectClass !== "exactly-once-external"
  ) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "sideEffectClass must be idempotent, at-least-once, or exactly-once-external.",
    );
  }
  if (typeof spec.tenantId !== "string" || spec.tenantId.trim().length === 0) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "tenantId is required.",
    );
  }
  if (typeof spec.projectId !== "string" || spec.projectId.trim().length === 0) {
    throw new RunCoordinatorError(
      "INVALID_RUN_SPEC",
      "projectId is required.",
    );
  }
  return Object.freeze({
    ...spec,
    resources: Object.freeze({ ...spec.resources }),
    command: Object.freeze([...spec.command]),
    secretRefs: Object.freeze([...spec.secretRefs]),
    requiredCapabilities: Object.freeze([...spec.requiredCapabilities]),
  });
}
