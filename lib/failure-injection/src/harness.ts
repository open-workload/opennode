/**
 * Scenario driver: arms a set of fault points, then tears them down.
 *
 *   runScenario ──▶ setup ──▶ createInjection per point ──▶ timer
 *        ▲                                                    │
 *        └──────────────── stopScenario ◀──── durationMs ─────┘
 *
 * Rejects a second concurrent run. Several built-in scenarios name fault
 * types the injector never implements, so they arm cleanly but no fault
 * fires; teardown swallows its own errors.
 */
import { FailureInjector, FaultPointRegistration, FaultType, type FaultConfig, type FaultInjection } from "./injector";

export interface HarnessConfig {
  injector: FailureInjector;
  scenarios: HarnessScenario[];
  defaultProbability?: number;
  globalEnabled?: boolean;
}

export interface HarnessScenario {
  id: string;
  name: string;
  description: string;
  faultPoints: FaultInjection[];
  durationMs?: number;
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
}

export class FailureInjectionHarness {
  private injector: FailureInjector;
  private scenarios = new Map<string, HarnessScenario>();
  private runningScenario: string | null = null;
  private scenarioTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: HarnessConfig) {
    this.injector = config.injector;
    for (const scenario of config.scenarios) {
      this.scenarios.set(scenario.id, scenario);
    }
    if (config.globalEnabled) this.injector.enable();
    if (config.defaultProbability !== undefined) this.injector.setGlobalProbability(config.defaultProbability);
  }

  registerScenario(scenario: HarnessScenario): void {
    this.scenarios.set(scenario.id, scenario);
  }

  getScenario(id: string): HarnessScenario | undefined {
    return this.scenarios.get(id);
  }

  getAllScenarios(): HarnessScenario[] {
    return Array.from(this.scenarios.values());
  }

  async runScenario(scenarioId: string): Promise<void> {
    const scenario = this.scenarios.get(scenarioId);
    if (!scenario) throw new Error(`Scenario ${scenarioId} not found`);

    if (this.runningScenario) {
      throw new Error(`Scenario ${this.runningScenario} already running`);
    }

    this.runningScenario = scenarioId;

    try {
      if (scenario.setup) await scenario.setup();

      for (const injection of scenario.faultPoints) {
        this.injector.createInjection(injection.faultPoint, injection.config);
      }

      if (scenario.durationMs) {
        this.scenarioTimeout = setTimeout(() => {
          this.stopScenario();
        }, scenario.durationMs);
      }
    } catch (err) {
      this.runningScenario = null;
      if (scenario.teardown) await scenario.teardown().catch(() => {});
      throw err;
    }
  }

  async stopScenario(): Promise<void> {
    const scenarioId = this.runningScenario;
    if (!scenarioId) return;

    const scenario = this.scenarios.get(scenarioId);
    this.runningScenario = null;

    if (this.scenarioTimeout) {
      clearTimeout(this.scenarioTimeout);
      this.scenarioTimeout = null;
    }

    for (const injection of scenario?.faultPoints ?? []) {
      this.injector.removeInjection(injection.faultPoint);
    }

    if (scenario?.teardown) await scenario.teardown().catch(() => {});
  }

  isRunning(): boolean {
    return this.runningScenario !== null;
  }

  getRunningScenario(): string | null {
    return this.runningScenario;
  }

  async runAllScenariosSequentially(intervalMs = 5000): Promise<void> {
    for (const scenario of this.scenarios.values()) {
      await this.runScenario(scenario.id);
      if (scenario.durationMs) {
        await new Promise(resolve => setTimeout(resolve, scenario.durationMs!));
      }
      await this.stopScenario();
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  createScenarioFromFaultPoints(
    id: string,
    name: string,
    description: string,
    faultPoints: Array<{ name: string; config: FaultConfig }>,
    durationMs?: number
  ): HarnessScenario {
    return {
      id,
      name,
      description,
      faultPoints: faultPoints.map(fp => ({
        id: `${fp.name}-${Date.now()}`,
        faultPoint: fp.name,
        config: fp.config,
        injectedCount: 0,
        enabled: true,
      })),
      durationMs,
    };
  }
}

export function createDefaultHarness(injector: FailureInjector): FailureInjectionHarness {
  const scenarios: HarnessScenario[] = [
    {
      id: "peer-partition",
      name: "Peer Network Partition",
      description: "Simulate network partition between peers",
      faultPoints: [
        {
          id: "partition-1",
          faultPoint: "peernet.send_message",
          config: { type: FaultType.Partition, probability: 0.5, affectedOperations: ["gossip", "sync"] },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "partition-2",
          faultPoint: "peernet.receive_message",
          config: { type: FaultType.MessageLoss, probability: 0.5 },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 30000,
    },
    {
      id: "control-plane-restart",
      name: "Control Plane Restart",
      description: "Simulate control plane process restart",
      faultPoints: [
        {
          id: "restart-1",
          faultPoint: "run-coordinator.acquire_lease",
          config: { type: FaultType.Crash, probability: 1.0 },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "restart-2",
          faultPoint: "membership-log.commit_decision",
          config: { type: FaultType.Timeout, probability: 1.0, durationMs: 10000 },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 15000,
    },
    {
      id: "consensus-quorum-loss",
      name: "Consensus Quorum Loss",
      description: "Simulate loss of consensus quorum",
      faultPoints: [
        {
          id: "quorum-1",
          faultPoint: "sync-engine.propose",
          config: { type: FaultType.Error, probability: 1.0, errorMessage: "Quorum lost" },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "quorum-2",
          faultPoint: "membership-log.get_quorum",
          config: { type: FaultType.Error, probability: 1.0, errorCode: "QUORUM_LOST" },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 20000,
    },
    {
      id: "worker-restart",
      name: "Worker Restart",
      description: "Simulate worker process restart during execution",
      faultPoints: [
        {
          id: "worker-1",
          faultPoint: "worker-runtime.execute",
          config: { type: FaultType.Crash, probability: 0.3 },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "worker-2",
          faultPoint: "worker-runtime.stream_logs",
          config: { type: FaultType.Error, probability: 0.2, errorMessage: "Worker disconnected" },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 30000,
    },
    {
      id: "object-store-outage",
      name: "Object Store Outage",
      description: "Simulate object store unavailability",
      faultPoints: [
        {
          id: "store-1",
          faultPoint: "content-store.write_chunk",
          config: { type: FaultType.Error, probability: 0.8, errorMessage: "Storage unavailable" },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "store-2",
          faultPoint: "content-store.read_chunk",
          config: { type: FaultType.Timeout, probability: 0.5, durationMs: 30000 },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 30000,
    },
    {
      id: "full-disk",
      name: "Full Disk",
      description: "Simulate disk space exhaustion",
      faultPoints: [
        {
          id: "disk-1",
          faultPoint: "node-store.write",
          config: { type: FaultType.ResourceExhaustion, probability: 1.0, errorCode: "ENOSPC" },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "disk-2",
          faultPoint: "content-store.write_chunk",
          config: { type: FaultType.ResourceExhaustion, probability: 1.0, errorCode: "ENOSPC" },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 10000,
    },
    {
      id: "provider-timeout",
      name: "Provider Timeout",
      description: "Simulate execution provider timeout",
      faultPoints: [
        {
          id: "provider-1",
          faultPoint: "worker-runtime.execute",
          config: { type: FaultType.Timeout, probability: 0.5, durationMs: 60000 },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 30000,
    },
    {
      id: "expired-credentials",
      name: "Expired Credentials",
      description: "Simulate expired credentials for secret broker and provider",
      faultPoints: [
        {
          id: "cred-1",
          faultPoint: "secret-broker.get_secret",
          config: { type: FaultType.Error, probability: 1.0, errorMessage: "Credentials expired", errorCode: "CREDENTIALS_EXPIRED" },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "cred-2",
          faultPoint: "worker-runtime.pull_image",
          config: { type: FaultType.Error, probability: 1.0, errorMessage: "Registry auth expired", errorCode: "AUTH_EXPIRED" },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 15000,
    },
    {
      id: "failed-cleanup",
      name: "Failed Cleanup",
      description: "Simulate cleanup failures after job completion",
      faultPoints: [
        {
          id: "cleanup-1",
          faultPoint: "worker-runtime.cleanup",
          config: { type: FaultType.Error, probability: 0.5, errorMessage: "Cleanup failed" },
          injectedCount: 0,
          enabled: true,
        },
        {
          id: "cleanup-2",
          faultPoint: "content-store.delete_chunk",
          config: { type: FaultType.Error, probability: 0.3, errorMessage: "Delete failed" },
          injectedCount: 0,
          enabled: true,
        },
      ],
      durationMs: 20000,
    },
  ];

  return new FailureInjectionHarness({ injector, scenarios });
}