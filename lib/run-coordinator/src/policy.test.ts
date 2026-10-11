import { describe, expect, it } from "vitest";
import { RunCoordinatorError, type RunCoordinatorErrorCode } from "./errors";
import {
  validateRunSpec,
  type QuotaPolicy,
  type RunSpec,
} from "./policy";

const QUOTAS: QuotaPolicy = {
  maxConcurrentRuns: 8,
  maxQueuedRuns: 32,
  maxDurationMs: 24 * 60 * 60 * 1000,
  maxCpuMilli: 16000,
  maxMemoryMiB: 65536,
  maxDiskMiB: 1048576,
  maxOutputBytes: 64 * 1024 * 1024,
  maxAttempts: 3,
  requireDigestPinnedImage: true,
  allowedImagePrefixes: [],
  allowedSecretRefPrefixes: [],
  maxCpuMilliPerTenant: 8000,
  maxMemoryMiBPerTenant: 32768,
  maxDiskMiBPerTenant: 524288,
  maxConcurrentRunsPerTenant: 4,
};

const DIGEST = "a".repeat(64);

function containerSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    name: "smoke",
    mode: "container",
    image: `busybox:1.36@sha256:${DIGEST}`,
    command: ["sh", "-c", "echo hi"],
    resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
    expectedOutputBytes: 0,
    secretRefs: [],
    requiredCapabilities: [],
    networkPolicy: "deny_all",
    sideEffectClass: "at-least-once",
    tenantId: "default",
    projectId: "default",
    ...overrides,
  };
}

function errorCodeOf(spec: RunSpec): RunCoordinatorErrorCode | undefined {
  try {
    validateRunSpec(spec, QUOTAS);
    return undefined;
  } catch (err) {
    if (err instanceof RunCoordinatorError) return err.code;
    throw err;
  }
}

describe("validateRunSpec command validation", () => {
  it("accepts a container spec with a command", () => {
    const spec = containerSpec();
    const validated = validateRunSpec(spec, QUOTAS);
    expect(validated.command).toEqual(spec.command);
  });

  it("accepts an empty command array", () => {
    expect(() => validateRunSpec(containerSpec({ command: [] }), QUOTAS)).not.toThrow();
  });

  it("rejects a command with more than 128 items", () => {
    const spec = containerSpec({
      command: Array.from({ length: 129 }, (_, i) => `arg-${i}`),
    });
    expect(errorCodeOf(spec)).toBe("INVALID_RUN_SPEC");
  });

  it("rejects a command item longer than 4096 characters", () => {
    const spec = containerSpec({ command: ["x".repeat(4097)] });
    expect(errorCodeOf(spec)).toBe("INVALID_RUN_SPEC");
  });

  it("rejects a command that is not an array", () => {
    const spec = containerSpec({ command: "sh" as unknown as readonly string[] });
    expect(errorCodeOf(spec)).toBe("INVALID_RUN_SPEC");
  });

  it("rejects a blank command item", () => {
    const spec = containerSpec({ command: ["ok", "   "] });
    expect(errorCodeOf(spec)).toBe("INVALID_RUN_SPEC");
  });
});

describe("validateRunSpec existing rules still apply", () => {
  it("still requires an image for container runs", () => {
    expect(errorCodeOf(containerSpec({ image: null }))).toBe("INVALID_RUN_SPEC");
  });

  it("still enforces digest pinning", () => {
    expect(errorCodeOf(containerSpec({ image: "busybox:1.36" }))).toBe(
      "IMAGE_POLICY_VIOLATION",
    );
  });

  it("still rejects a diagnostic run that specifies an image", () => {
    expect(
      errorCodeOf(
        containerSpec({
          mode: "built-in-diagnostic",
          image: `busybox:1.36@sha256:${DIGEST}`,
        }),
      ),
    ).toBe("INVALID_RUN_SPEC");
  });
});
