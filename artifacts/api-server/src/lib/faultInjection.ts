import {
  createDefaultHarness,
  getRegisteredFaultPoints,
  globalFailureInjector,
  registerAllFaultPoints,
  type FailureInjectionHarness,
  type FailureInjector,
} from "@workspace/failure-injection";
import type { WorkerBackend, WorkerSpec } from "@workspace/worker-runtime";

/**
 * Wires the failure-injection registry into a runtime the api-server can use.
 *
 *   registerAllFaultPoints ──▶ globalFailureInjector ──▶ inject()
 *        (once, idempotent)              │
 *   createDefaultHarness ────────────────┴──▶ harness scenarios
 *
 *   createFaultInjectingBackend wraps a WorkerBackend so every `start` runs
 *   through the injector at the worker-execution fault point.
 */
export const WORKER_EXECUTION_FAULT_POINT = "worker-runtime.execute";

export interface FaultInjectionRuntime {
  readonly injector: FailureInjector;
  readonly harness: FailureInjectionHarness;
}

/**
 * Registers every known fault point into the module registry, which now pushes
 * them onto the global injector that `inject()` reaches, and builds the default
 * harness around it. Idempotent: a second call (or a second import of this
 * module) reuses the registry instead of re-registering (which would throw).
 */
export function bootstrapFaultInjection(): FaultInjectionRuntime {
  if (getRegisteredFaultPoints().length === 0) {
    registerAllFaultPoints();
  }

  return { injector: globalFailureInjector, harness: createDefaultHarness(globalFailureInjector) };
}

export const faultInjection: FaultInjectionRuntime = bootstrapFaultInjection();

/**
 * Wraps a worker backend so every `start` runs through the injector at the
 * worker-execution fault point. With no injection active this is a no-op.
 */
export function createFaultInjectingBackend(
  backend: WorkerBackend,
  faultPoint: string = WORKER_EXECUTION_FAULT_POINT,
): WorkerBackend {
  const { injector } = faultInjection;
  return {
    kind: backend.kind,
    start: (spec: WorkerSpec) => injector.inject(faultPoint, () => backend.start(spec)),
  };
}
