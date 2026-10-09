import { FeatureFlagsError } from "./errors";

export type FlagValue = boolean | number | string | Record<string, unknown>;

export interface FlagDefinition<T extends FlagValue = FlagValue> {
  readonly key: string;
  readonly description: string;
  readonly defaultValue: T;
  readonly rolloutPercentage?: number;
  readonly allowedValues?: readonly T[];
}

export interface FlagEvaluationContext {
  readonly nodeId?: string;
  readonly clusterId?: string;
  readonly userId?: string;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly [key: string]: unknown;
}

interface StoredFlagDefinition {
  readonly key: string;
  readonly description: string;
  readonly defaultValue: FlagValue;
  readonly rolloutPercentage?: number;
  readonly allowedValues?: readonly FlagValue[];
}

export class FlagRegistry {
  private readonly flags = new Map<string, StoredFlagDefinition>();

  register<T extends FlagValue>(definition: FlagDefinition<T>): void {
    if (this.flags.has(definition.key)) {
      throw new FeatureFlagsError("DUPLICATE_FLAG", `Flag already registered: ${definition.key}`);
    }
    if (definition.rolloutPercentage !== undefined) {
      if (!Number.isInteger(definition.rolloutPercentage) || definition.rolloutPercentage < 0 || definition.rolloutPercentage > 100) {
        throw new FeatureFlagsError("INVALID_ROLLOUT", `Rollout percentage must be an integer 0-100 for flag ${definition.key}`);
      }
    }
    if (definition.allowedValues !== undefined && definition.allowedValues.length === 0) {
      throw new FeatureFlagsError("INVALID_ALLOWED_VALUES", `Allowed values must not be empty for flag ${definition.key}`);
    }
    this.flags.set(definition.key, Object.freeze(definition as StoredFlagDefinition));
  }

  getDefinition<T extends FlagValue>(key: string): FlagDefinition<T> | undefined {
    const stored = this.flags.get(key);
    if (!stored) return undefined;
    return stored as FlagDefinition<T>;
  }

  getAllDefinitions(): readonly FlagDefinition[] {
    return Object.freeze([...this.flags.values()] as FlagDefinition[]);
  }

  evaluate<T extends FlagValue>(key: string, context: FlagEvaluationContext = {}): T {
    const definition = this.flags.get(key);
    if (!definition) {
      throw new FeatureFlagsError("FLAG_NOT_FOUND", `Flag not registered: ${key}`);
    }
    if (definition.rolloutPercentage !== undefined && definition.rolloutPercentage < 100) {
      const hashInput = this.getHashInput(key, context);
      const hash = this.hashString(hashInput);
      const bucket = hash % 100;
      if (bucket >= definition.rolloutPercentage) {
        return definition.defaultValue as T;
      }
    }
    return definition.defaultValue as T;
  }

  evaluateBoolean(key: string, context: FlagEvaluationContext = {}): boolean {
    const value = this.evaluate(key, context);
    return Boolean(value);
  }

  private getHashInput(key: string, context: FlagEvaluationContext): string {
    const parts = [key];
    if (context.nodeId) parts.push(`node:${context.nodeId}`);
    if (context.clusterId) parts.push(`cluster:${context.clusterId}`);
    if (context.userId) parts.push(`user:${context.userId}`);
    if (context.runId) parts.push(`run:${context.runId}`);
    if (context.attemptId) parts.push(`attempt:${context.attemptId}`);
    return parts.join("|");
  }

  private hashString(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  has(key: string): boolean {
    return this.flags.has(key);
  }

  delete(key: string): boolean {
    return this.flags.delete(key);
  }

  clear(): void {
    this.flags.clear();
  }
}

export const flagRegistry = new FlagRegistry();