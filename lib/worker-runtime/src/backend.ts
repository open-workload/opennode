/**
 * Type-only contract: a backend's start(spec) returns a handle, not a result.
 *
 *   WorkerSpec ──▶ WorkerBackend.start ──▶ WorkerHandle
 *                                              │
 *   starting ──spawn──▶ running ──exit──────▶ finished
 *      │                    │                   ▲
 *      └── cancel(reason) ──┴───────────────────┘
 *
 *   wait() ────▶ WorkerResult     cleanup() ───▶ CleanupReport
 *
 * The lifecycle union also admits pending, cancel_requested, tearing_down.
 */

import type { WorkerSpec } from "./spec";

export type WorkerLifecycleState =
  | "pending"
  | "starting"
  | "running"
  | "cancel_requested"
  | "tearing_down"
  | "finished";

export type WorkerTerminalStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "infrastructure_error";

export type TeardownReason =
  | "success"
  | "failure"
  | "timeout"
  | "eviction"
  | "worker_disappeared"
  | "control_plane_outage"
  | "cancelled";

export interface CleanupReport {
  readonly scratchRemoved: boolean;
  readonly tempCredsRevoked: boolean;
  readonly cgroupRemoved: boolean;
  readonly networkRulesRemoved: boolean;
  readonly imageLayersCleaned: boolean;
}

export interface WorkerResult {
  readonly runId: string;
  readonly backendRunId: string;
  readonly status: WorkerTerminalStatus;
  readonly exitCode: number | null;
  readonly outputBytes: number;
  readonly error?: string;
}

export interface WorkerHandle {
  readonly runId: string;
  readonly backendRunId: string;
  state(): WorkerLifecycleState;
  cancel(reason: TeardownReason): Promise<void>;
  cleanup(): Promise<CleanupReport>;
  wait(): Promise<WorkerResult>;
}

export interface WorkerBackend {
  readonly kind: string;
  start(spec: WorkerSpec): Promise<WorkerHandle>;
}
