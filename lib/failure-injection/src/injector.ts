export enum FaultType {
  Latency = "latency",
  Error = "error",
  Timeout = "timeout",
  Partition = "partition",
  Crash = "crash",
  DataCorruption = "data_corruption",
  ResourceExhaustion = "resource_exhaustion",
  ClockSkew = "clock_skew",
  MessageLoss = "message_loss",
  MessageDuplication = "message_duplication",
  MessageReordering = "message_reordering",
}

export interface FaultConfig {
  type: FaultType;
  probability?: number;
  latencyMs?: number;
  errorMessage?: string;
  errorCode?: string;
  durationMs?: number;
  affectedOperations?: string[];
  labels?: Record<string, string>;
}

export interface FaultInjection {
  id: string;
  faultPoint: string;
  config: FaultConfig;
  enabled: boolean;
  injectedAt?: number;
  injectedCount: number;
  lastInjectedAt?: number;
}

export interface FaultPointRegistration {
  name: string;
  subsystem: string;
  description: string;
  supportedFaultTypes: FaultType[];
  defaultConfig?: Partial<FaultConfig>;
}

export class FailureInjector {
  private injections = new Map<string, FaultInjection>();
  private faultPoints = new Map<string, FaultPointRegistration>();
  private enabled = false;
  private globalProbability = 1.0;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setGlobalProbability(probability: number): void {
    this.globalProbability = Math.max(0, Math.min(1, probability));
  }

  getGlobalProbability(): number {
    return this.globalProbability;
  }

  registerFaultPoint(registration: FaultPointRegistration): void {
    if (this.faultPoints.has(registration.name)) {
      throw new Error(`Fault point ${registration.name} already registered`);
    }
    this.faultPoints.set(registration.name, registration);
  }

  unregisterFaultPoint(name: string): void {
    this.faultPoints.delete(name);
    this.injections.delete(name);
  }

  getFaultPoint(name: string): FaultPointRegistration | undefined {
    return this.faultPoints.get(name);
  }

  getAllFaultPoints(): FaultPointRegistration[] {
    return Array.from(this.faultPoints.values());
  }

  getFaultPointsBySubsystem(subsystem: string): FaultPointRegistration[] {
    return Array.from(this.faultPoints.values()).filter(fp => fp.subsystem === subsystem);
  }

  createInjection(faultPointName: string, config: FaultConfig): FaultInjection {
    const faultPoint = this.faultPoints.get(faultPointName);
    if (!faultPoint) {
      throw new Error(`Fault point ${faultPointName} not registered`);
    }

    if (!faultPoint.supportedFaultTypes.includes(config.type)) {
      throw new Error(`Fault type ${config.type} not supported by fault point ${faultPointName}`);
    }

    const injection: FaultInjection = {
      id: `${faultPointName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      faultPoint: faultPointName,
      config: { ...faultPoint.defaultConfig, ...config } as FaultConfig,
      enabled: true,
      injectedCount: 0,
    };

    this.injections.set(faultPointName, injection);
    return injection;
  }

  removeInjection(faultPointName: string): void {
    this.injections.delete(faultPointName);
  }

  getInjection(faultPointName: string): FaultInjection | undefined {
    return this.injections.get(faultPointName);
  }

  getAllInjections(): FaultInjection[] {
    return Array.from(this.injections.values());
  }

  shouldInject(faultPointName: string): boolean {
    if (!this.enabled) return false;

    const injection = this.injections.get(faultPointName);
    if (!injection || !injection.enabled) return false;

    const probability = injection.config.probability ?? 1.0;
    const effectiveProbability = probability * this.globalProbability;

    if (Math.random() > effectiveProbability) return false;

    injection.injectedCount++;
    injection.lastInjectedAt = Date.now();
    if (!injection.injectedAt) injection.injectedAt = Date.now();

    return true;
  }

  async inject<T>(faultPointName: string, operation: () => Promise<T>): Promise<T> {
    if (!this.shouldInject(faultPointName)) {
      return operation();
    }

    const injection = this.injections.get(faultPointName)!;
    const config = injection.config;

    switch (config.type) {
      case FaultType.Latency: {
        const latency = config.latencyMs ?? 100;
        await new Promise(resolve => setTimeout(resolve, latency));
        return operation();
      }
      case FaultType.Error: {
        const error = new Error(config.errorMessage ?? "Injected fault");
        if (config.errorCode) (error as any).code = config.errorCode;
        throw error;
      }
      case FaultType.Timeout: {
        const timeout = config.durationMs ?? 5000;
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Injected timeout")), timeout)
        );
        return operation();
      }
      case FaultType.Crash: {
        const error = new Error(config.errorMessage ?? "Injected crash");
        (error as any).isInjectedCrash = true;
        throw error;
      }
      case FaultType.DataCorruption: {
        const error = new Error(config.errorMessage ?? "Injected data corruption");
        (error as any).isInjectedCorruption = true;
        throw error;
      }
      case FaultType.ResourceExhaustion: {
        const error = new Error(config.errorMessage ?? "Injected resource exhaustion");
        (error as any).code = config.errorCode ?? "ENOSPC";
        throw error;
      }
      case FaultType.ClockSkew: {
        const skew = config.latencyMs ?? 1000;
        const originalNow = Date.now;
        (globalThis as any).Date.now = () => originalNow() + skew;
        try {
          return await operation();
        } finally {
          (globalThis as any).Date.now = originalNow;
        }
      }
      default:
        return operation();
    }
  }

  injectSync<T>(faultPointName: string, operation: () => T): T {
    if (!this.shouldInject(faultPointName)) {
      return operation();
    }

    const injection = this.injections.get(faultPointName)!;
    const config = injection.config;

    switch (config.type) {
      case FaultType.Latency: {
        const latency = config.latencyMs ?? 100;
        const start = Date.now();
        while (Date.now() - start < latency) {}
        return operation();
      }
      case FaultType.Error: {
        const error = new Error(config.errorMessage ?? "Injected fault");
        if (config.errorCode) (error as any).code = config.errorCode;
        throw error;
      }
      case FaultType.Crash: {
        const error = new Error(config.errorMessage ?? "Injected crash");
        (error as any).isInjectedCrash = true;
        throw error;
      }
      case FaultType.DataCorruption: {
        const error = new Error(config.errorMessage ?? "Injected data corruption");
        (error as any).isInjectedCorruption = true;
        throw error;
      }
      case FaultType.ResourceExhaustion: {
        const error = new Error(config.errorMessage ?? "Injected resource exhaustion");
        (error as any).code = config.errorCode ?? "ENOSPC";
        throw error;
      }
      default:
        return operation();
    }
  }

  clearAllInjections(): void {
    this.injections.clear();
  }

  reset(): void {
    this.injections.clear();
    this.enabled = false;
    this.globalProbability = 1.0;
  }
}

export const globalFailureInjector = new FailureInjector();