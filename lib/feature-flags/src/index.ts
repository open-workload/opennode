import { FeatureFlagsError } from "./errors";
import { FlagRegistry, type FlagEvaluationContext, type FlagValue } from "./flagRegistry";
import { KillSwitch, type KillSwitchState } from "./killSwitch";

export { type FlagEvaluationContext, type FlagValue } from "./flagRegistry";

export interface FeatureFlagsConfig {
  readonly enableKillSwitch?: boolean;
  readonly flags?: Record<string, FlagValue>;
}

export class FeatureFlags {
  private readonly registry: FlagRegistry;
  private readonly killSwitch: KillSwitch;
  private readonly config: FeatureFlagsConfig;

  constructor(config: FeatureFlagsConfig = {}) {
    this.registry = new FlagRegistry();
    this.killSwitch = new KillSwitch();
    this.config = config;
    this.registerCoreFlags();
    if (config.flags) {
      this.applyOverrides(config.flags);
    }
  }

  private registerCoreFlags(): void {
    this.registry.register({
      key: "execution.new_runs_enabled",
      description: "Allow new run submissions and lease acquisition",
      defaultValue: true,
      rolloutPercentage: 100,
    });
    this.registry.register({
      key: "execution.max_concurrent_runs",
      description: "Maximum concurrent runs per node (when kill switch is inactive)",
      defaultValue: 8,
      allowedValues: [1, 2, 4, 8, 16, 32, 64],
    });
    this.registry.register({
      key: "membership.leave_enabled",
      description: "Allow voluntary leave operations",
      defaultValue: true,
    });
    this.registry.register({
      key: "membership.eviction_enabled",
      description: "Allow eviction proposals and votes",
      defaultValue: true,
    });
    this.registry.register({
      key: "sync.snapshot_generation_enabled",
      description: "Enable automatic snapshot generation",
      defaultValue: true,
    });
    this.registry.register({
      key: "gossip.enabled",
      description: "Enable gossip protocol for presence and capacity signals",
      defaultValue: true,
    });
  }

  private applyOverrides(flags: Record<string, FlagValue>): void {
    for (const [key, value] of Object.entries(flags)) {
      const def = this.registry.getDefinition(key);
      if (def) {
        if (def.allowedValues && !def.allowedValues.includes(value)) {
          throw new FeatureFlagsError("INVALID_OVERRIDE", `Override value for ${key} not in allowed values`);
        }
        const currentDef = this.registry.getDefinition(key)!;
        this.registry.delete(key);
        this.registry.register({ ...currentDef, defaultValue: value });
      }
    }
  }

  getRegistry(): FlagRegistry {
    return this.registry;
  }

  getKillSwitch(): KillSwitch {
    return this.killSwitch;
  }

  isNewExecutionAllowed(context: FlagEvaluationContext = {}): boolean {
    if (this.config.enableKillSwitch && this.killSwitch.isEnabled()) {
      return false;
    }
    return this.registry.evaluateBoolean("execution.new_runs_enabled", context);
  }

  getMaxConcurrentRuns(context: FlagEvaluationContext = {}): number {
    return this.registry.evaluate<number>("execution.max_concurrent_runs", context);
  }

  isLeaveEnabled(context: FlagEvaluationContext = {}): boolean {
    return this.registry.evaluateBoolean("membership.leave_enabled", context);
  }

  isEvictionEnabled(context: FlagEvaluationContext = {}): boolean {
    return this.registry.evaluateBoolean("membership.eviction_enabled", context);
  }

  isSnapshotGenerationEnabled(context: FlagEvaluationContext = {}): boolean {
    return this.registry.evaluateBoolean("sync.snapshot_generation_enabled", context);
  }

  isGossipEnabled(context: FlagEvaluationContext = {}): boolean {
    return this.registry.evaluateBoolean("gossip.enabled", context);
  }

  getAllFlags(context: FlagEvaluationContext = {}): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const def of this.registry.getAllDefinitions()) {
      result[def.key] = this.registry.evaluate(def.key, context);
    }
    result.killSwitch = this.killSwitch.getState();
    return result;
  }

  activateKillSwitch(reason: string, activatedBy: string): KillSwitchState {
    if (!this.config.enableKillSwitch) {
      throw new FeatureFlagsError("KILL_SWITCH_DISABLED", "Kill switch is not enabled in configuration");
    }
    return this.killSwitch.activate(reason, activatedBy);
  }

  deactivateKillSwitch(): KillSwitchState {
    return this.killSwitch.deactivate();
  }
}

export const featureFlags = new FeatureFlags();