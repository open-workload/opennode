import { FeatureFlagsError } from "./errors";

export interface KillSwitchState {
  readonly enabled: boolean;
  readonly reason: string;
  readonly activatedAt: string;
  readonly activatedBy: string;
}

type KillSwitchListener = (state: KillSwitchState) => void;

export class KillSwitch {
  private state: KillSwitchState = {
    enabled: false,
    reason: "",
    activatedAt: "",
    activatedBy: "",
  };
  private readonly listeners = new Set<KillSwitchListener>();

  getState(): KillSwitchState {
    return this.state;
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  activate(reason: string, activatedBy: string): KillSwitchState {
    if (this.state.enabled) {
      throw new FeatureFlagsError("ALREADY_ACTIVATED", "Kill switch is already activated");
    }
    this.state = Object.freeze({
      enabled: true,
      reason,
      activatedAt: new Date().toISOString(),
      activatedBy,
    });
    this.notifyListeners();
    return this.state;
  }

  deactivate(): KillSwitchState {
    if (!this.state.enabled) {
      throw new FeatureFlagsError("NOT_ACTIVATED", "Kill switch is not activated");
    }
    this.state = Object.freeze({
      enabled: false,
      reason: "",
      activatedAt: "",
      activatedBy: "",
    });
    this.notifyListeners();
    return this.state;
  }

  subscribe(listener: KillSwitchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Listener errors should not affect kill switch operation
      }
    }
  }
}

export const killSwitch = new KillSwitch();