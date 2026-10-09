export enum HealthStatus {
  Healthy = "healthy",
  Degraded = "degraded",
  Unhealthy = "unhealthy",
  Unknown = "unknown",
}

export interface HealthCheck {
  name: string;
  subsystem: string;
  check(): Promise<HealthCheckResult>;
  intervalMs?: number;
  timeoutMs?: number;
  critical?: boolean;
}

export interface HealthCheckResult {
  status: HealthStatus;
  message?: string;
  details?: Record<string, unknown>;
  timestamp: number;
  latencyMs?: number;
}

export interface SubsystemHealth {
  subsystem: string;
  status: HealthStatus;
  checks: HealthCheckResult[];
  timestamp: number;
}

export class HealthCheckRegistry {
  private checks = new Map<string, HealthCheck>();
  private results = new Map<string, HealthCheckResult>();

  register(check: HealthCheck): void {
    const key = `${check.subsystem}:${check.name}`;
    this.checks.set(key, check);
  }

  unregister(subsystem: string, name: string): void {
    this.checks.delete(`${subsystem}:${name}`);
    this.results.delete(`${subsystem}:${name}`);
  }

  async runAll(): Promise<SubsystemHealth[]> {
    const bySubsystem = new Map<string, HealthCheck[]>();
    for (const check of this.checks.values()) {
      const arr = bySubsystem.get(check.subsystem) ?? [];
      arr.push(check);
      bySubsystem.set(check.subsystem, arr);
    }

    const results: SubsystemHealth[] = [];
    for (const [subsystem, checks] of bySubsystem) {
      const checkResults: HealthCheckResult[] = [];
      let overallStatus = HealthStatus.Healthy;

      for (const check of checks) {
        const start = Date.now();
        try {
          const timeoutMs = check.timeoutMs ?? 5000;
          const result = await Promise.race([
            check.check(),
            new Promise<HealthCheckResult>((_, reject) =>
              setTimeout(() => reject(new Error("Health check timeout")), timeoutMs)
            ),
          ]);
          result.latencyMs = Date.now() - start;
          checkResults.push(result);
          this.results.set(`${subsystem}:${check.name}`, result);

          if (result.status === HealthStatus.Unhealthy && check.critical) {
            overallStatus = HealthStatus.Unhealthy;
          } else if (result.status === HealthStatus.Degraded && overallStatus === HealthStatus.Healthy) {
            overallStatus = HealthStatus.Degraded;
          } else if (result.status === HealthStatus.Unknown && overallStatus === HealthStatus.Healthy) {
            overallStatus = HealthStatus.Unknown;
          }
        } catch (err) {
          const result: HealthCheckResult = {
            status: HealthStatus.Unhealthy,
            message: err instanceof Error ? err.message : "Check failed",
            timestamp: Date.now(),
            latencyMs: Date.now() - start,
          };
          checkResults.push(result);
          this.results.set(`${subsystem}:${check.name}`, result);
          if (check.critical) overallStatus = HealthStatus.Unhealthy;
        }
      }

      results.push({
        subsystem,
        status: overallStatus,
        checks: checkResults,
        timestamp: Date.now(),
      });
    }

    return results;
  }

  async runSubsystem(subsystem: string): Promise<SubsystemHealth | null> {
    const checks: HealthCheck[] = [];
    for (const check of this.checks.values()) {
      if (check.subsystem === subsystem) checks.push(check);
    }
    if (checks.length === 0) return null;

    const checkResults: HealthCheckResult[] = [];
    let overallStatus = HealthStatus.Healthy;

    for (const check of checks) {
      const start = Date.now();
      try {
        const timeoutMs = check.timeoutMs ?? 5000;
        const result = await Promise.race([
          check.check(),
          new Promise<HealthCheckResult>((_, reject) =>
            setTimeout(() => reject(new Error("Health check timeout")), timeoutMs)
          ),
        ]);
        result.latencyMs = Date.now() - start;
        checkResults.push(result);
        this.results.set(`${subsystem}:${check.name}`, result);

        if (result.status === HealthStatus.Unhealthy && check.critical) {
          overallStatus = HealthStatus.Unhealthy;
        } else if (result.status === HealthStatus.Degraded && overallStatus === HealthStatus.Healthy) {
          overallStatus = HealthStatus.Degraded;
        }
      } catch (err) {
        const result: HealthCheckResult = {
          status: HealthStatus.Unhealthy,
          message: err instanceof Error ? err.message : "Check failed",
          timestamp: Date.now(),
          latencyMs: Date.now() - start,
        };
        checkResults.push(result);
        this.results.set(`${subsystem}:${check.name}`, result);
        if (check.critical) overallStatus = HealthStatus.Unhealthy;
      }
    }

    return {
      subsystem,
      status: overallStatus,
      checks: checkResults,
      timestamp: Date.now(),
    };
  }

  getLastResult(subsystem: string, name: string): HealthCheckResult | undefined {
    return this.results.get(`${subsystem}:${name}`);
  }

  getAllLastResults(): Map<string, HealthCheckResult> {
    return new Map(this.results);
  }
}

export const healthCheckRegistry = new HealthCheckRegistry();

export interface HealthCheckEndpoint {
  path: string;
  handler(): Promise<Response>;
}

export function createHealthEndpoint(registry: HealthCheckRegistry): HealthCheckEndpoint {
  return {
    path: "/health",
    async handler() {
      const results = await registry.runAll();
      const overallStatus = results.some(r => r.status === HealthStatus.Unhealthy)
        ? HealthStatus.Unhealthy
        : results.some(r => r.status === HealthStatus.Degraded)
        ? HealthStatus.Degraded
        : HealthStatus.Healthy;

      return Response.json(
        { status: overallStatus, subsystems: results },
        { status: overallStatus === HealthStatus.Unhealthy ? 503 : 200 }
      );
    },
  };
}

export function createReadinessEndpoint(registry: HealthCheckRegistry): HealthCheckEndpoint {
  return {
    path: "/ready",
    async handler() {
      const results = await registry.runAll();
      const hasCriticalUnhealthy = results.some(r =>
        r.checks.some(c => c.status === HealthStatus.Unhealthy)
      );

      return Response.json(
        { ready: !hasCriticalUnhealthy, subsystems: results },
        { status: hasCriticalUnhealthy ? 503 : 200 }
      );
    },
  };
}

export function createLivenessEndpoint(): HealthCheckEndpoint {
  return {
    path: "/live",
    async handler() {
      return Response.json({ alive: true }, { status: 200 });
    },
  };
}