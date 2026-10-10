/**
 * Run lifecycle plus the workload shape. A container run carries an image only.
 *
 *   queued ──▶ scheduled ──▶ running ──▶ succeeded | failed
 *      └──────────┴────────────┴────────────▶ cancelled
 *
 * An illegal edge throws INVALID_RUN_TRANSITION. A workload carrying `command` or
 * `entrypoint` is rejected, so no command-execution API is defined here.
 */
import { DomainError } from "./errors";

export interface BuiltInDiagnosticWorkload {
  readonly mode: "built-in-diagnostic";
  readonly diagnostic: "health-check";
}

/**
 * Identifies container mode without defining a command/entrypoint execution API.
 * Runtime validation rejects command-like fields as well.
 */
export interface ArbitraryContainerWorkload {
  readonly mode: "arbitrary-container";
  readonly image: string;
  readonly command?: never;
  readonly entrypoint?: never;
}

export type Workload = BuiltInDiagnosticWorkload | ArbitraryContainerWorkload;

export type RunState =
  | "queued"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkloadRun {
  readonly runId: string;
  readonly workload: Workload;
  readonly state: RunState;
}

const LEGAL_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ["scheduled", "cancelled"],
  scheduled: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function createBuiltInDiagnosticWorkload(): BuiltInDiagnosticWorkload {
  return Object.freeze({
    mode: "built-in-diagnostic",
    diagnostic: "health-check",
  });
}

export function createArbitraryContainerWorkload(
  image: string,
): ArbitraryContainerWorkload {
  validateIdentifier(image, "Container image");
  return Object.freeze({ mode: "arbitrary-container", image });
}

export function createRun(runId: string, workload: Workload): WorkloadRun {
  validateIdentifier(runId, "Run ID");
  validateWorkload(workload);
  return Object.freeze({
    runId,
    workload: Object.freeze({ ...workload }),
    state: "queued",
  });
}

export function transitionRun(
  run: WorkloadRun,
  nextState: RunState,
): WorkloadRun {
  validateIdentifier(run.runId, "Run ID");
  validateWorkload(run.workload);
  if (!isRunState(run.state) || !isRunState(nextState)) {
    throw new DomainError("INVALID_RUN", "Run contains an unknown state.");
  }
  if (!LEGAL_TRANSITIONS[run.state].includes(nextState)) {
    throw new DomainError(
      "INVALID_RUN_TRANSITION",
      `Run cannot transition from ${run.state} to ${nextState}.`,
    );
  }
  return Object.freeze({ ...run, state: nextState });
}

function validateWorkload(workload: Workload): void {
  if (typeof workload !== "object" || workload === null) {
    throw new DomainError("INVALID_WORKLOAD", "A workload is required.");
  }
  if (workload.mode === "built-in-diagnostic") {
    if (workload.diagnostic !== "health-check") {
      throw new DomainError(
        "INVALID_WORKLOAD",
        "Only the built-in health-check diagnostic is supported.",
      );
    }
    return;
  }
  if (workload.mode === "arbitrary-container") {
    if (
      typeof workload.image !== "string" ||
      workload.image.trim().length === 0 ||
      "command" in workload ||
      "entrypoint" in workload
    ) {
      throw new DomainError(
        "INVALID_WORKLOAD",
        "Container workloads require an image and cannot specify commands or entrypoints.",
      );
    }
    return;
  }
  throw new DomainError(
    "INVALID_WORKLOAD",
    "Unknown workload mode; no fallback workload is available.",
  );
}

function isRunState(value: string): value is RunState {
  return Object.prototype.hasOwnProperty.call(LEGAL_TRANSITIONS, value);
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", `${label} must not be empty.`);
  }
}
