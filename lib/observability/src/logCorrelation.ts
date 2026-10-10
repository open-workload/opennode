/**
 * Correlates log lines with request/run/attempt/node ids and fans them out to handlers.
 *
 *   log()/info()/warn()/error() ──▶ base ids + per-call ids ──▶ StructuredLogEntry
 *        │                                                       │
 *   child(ids) narrows scope, shares handlers                    ▼
 *                                               handlers (a throwing one is skipped)
 *   withOperation(fn) ──▶ start ──▶ durationMs ──▶ completed | failed + rethrow
 *   createConsoleLogHandler(minLevel) ──▶ console.log line, filtered by level
 *   no caller in this repo wires globalLogCorrelator to a handler yet
 */
export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export interface CorrelationIds {
  requestId?: string;
  runId?: string;
  attemptId?: string;
  nodeId?: string;
  clusterId?: string;
  correlationId?: string;
  [key: string]: string | undefined;
}

export interface StructuredLogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  correlationIds: CorrelationIds;
  subsystem: string;
  operation?: string;
  durationMs?: number;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  metadata?: Record<string, unknown>;
}

export type CorrelationContext = CorrelationIds;

type LogHandler = (entry: StructuredLogEntry) => void;

export class LogCorrelator {
  private handlers: LogHandler[] = [];
  private baseCorrelationIds: CorrelationIds = {};

  setBaseCorrelationIds(ids: CorrelationIds): void {
    this.baseCorrelationIds = { ...ids };
  }

  addHandler(handler: LogHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  child(ids: CorrelationIds): LogCorrelator {
    const child = new LogCorrelator();
    child.baseCorrelationIds = { ...this.baseCorrelationIds, ...ids };
    child.handlers = this.handlers;
    return child;
  }

  log(level: LogLevel, message: string, options: {
    subsystem: string;
    operation?: string;
    durationMs?: number;
    error?: Error;
    metadata?: Record<string, unknown>;
    correlationIds?: CorrelationIds;
  } = { subsystem: "unknown" }): void {
    const entry: StructuredLogEntry = {
      timestamp: Date.now(),
      level,
      message,
      correlationIds: { ...this.baseCorrelationIds, ...options.correlationIds },
      subsystem: options.subsystem,
      operation: options.operation,
      durationMs: options.durationMs,
      error: options.error
        ? { name: options.error.name, message: options.error.message, stack: options.error.stack }
        : undefined,
      metadata: options.metadata,
    };

    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch {
        // Silently ignore handler errors to avoid logging loops
      }
    }
  }

  debug(message: string, options?: Parameters<LogCorrelator["log"]>[2]): void {
    this.log(LogLevel.Debug, message, options);
  }

  info(message: string, options?: Parameters<LogCorrelator["log"]>[2]): void {
    this.log(LogLevel.Info, message, options);
  }

  warn(message: string, options?: Parameters<LogCorrelator["log"]>[2]): void {
    this.log(LogLevel.Warn, message, options);
  }

  error(message: string, options?: Parameters<LogCorrelator["log"]>[2]): void {
    this.log(LogLevel.Error, message, options);
  }

  withOperation<T>(operation: string, fn: () => Promise<T> | T, options?: Parameters<LogCorrelator["log"]>[2]): Promise<T> {
    const start = Date.now();
    const subsystem = options?.subsystem ?? "unknown";
    const correlationIds = options?.correlationIds;

    this.debug(`Starting ${operation}`, { subsystem, operation, correlationIds });

    const promise = Promise.resolve(fn());
    return promise
      .then((result) => {
        this.debug(`Completed ${operation}`, {
          subsystem,
          operation,
          durationMs: Date.now() - start,
          correlationIds,
        });
        return result;
      })
      .catch((err) => {
        this.error(`Failed ${operation}`, {
          subsystem,
          operation,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err : new Error(String(err)),
          correlationIds,
        });
        throw err;
      });
  }
}

export const globalLogCorrelator = new LogCorrelator();

export function createConsoleLogHandler(minLevel: LogLevel = LogLevel.Info): LogHandler {
  const levelOrder = [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error];
  const minIndex = levelOrder.indexOf(minLevel);

  return (entry: StructuredLogEntry) => {
    if (levelOrder.indexOf(entry.level) < minIndex) return;

    const correlationStr = Object.entries(entry.correlationIds)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");

    const meta = entry.metadata ? ` ${JSON.stringify(entry.metadata)}` : "";
    const err = entry.error ? ` error=${entry.error.name}:${entry.error.message}` : "";
    const dur = entry.durationMs !== undefined ? ` durationMs=${entry.durationMs}` : "";
    const op = entry.operation ? ` op=${entry.operation}` : "";

    const line = `[${new Date(entry.timestamp).toISOString()}] ${entry.level.toUpperCase()} ${entry.subsystem}${op}${dur} ${entry.message}${correlationStr ? ` [${correlationStr}]` : ""}${err}${meta}`;
    console.log(line);
  };
}