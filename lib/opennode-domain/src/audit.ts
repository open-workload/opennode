import { DomainError } from "./errors";
import { SCHEMA_VERSION } from "./schemas";

export interface CorrelationIds {
  readonly requestId: string;
  readonly runId?: string;
  readonly attemptId?: string;
}

export interface AuditEvent {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly eventId: string;
  readonly kind: string;
  readonly correlation: CorrelationIds;
  readonly details: Record<string, unknown>;
}

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /secret|token|password|passphrase|private|credential|api[-_]?key/i;

export function createAuditEvent(input: {
  readonly eventId: string;
  readonly kind: string;
  readonly correlation: CorrelationIds;
  readonly details?: Record<string, unknown>;
}): AuditEvent {
  validateId(input.eventId, "eventId");
  validateId(input.kind, "kind");
  validateCorrelation(input.correlation);
  const details = input.details ?? {};
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    throw new DomainError(
      "INVALID_AUDIT_EVENT",
      "Audit event details must be an object.",
    );
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    eventId: input.eventId,
    kind: input.kind,
    correlation: Object.freeze({ ...input.correlation }),
    details: Object.freeze({ ...details }),
  });
}

export function validateCorrelation(correlation: CorrelationIds): void {
  if (typeof correlation !== "object" || correlation === null) {
    throw new DomainError(
      "INVALID_AUDIT_EVENT",
      "Correlation IDs are required.",
    );
  }
  validateId(correlation.requestId, "requestId");
  if (correlation.runId !== undefined) validateId(correlation.runId, "runId");
  if (correlation.attemptId !== undefined) {
    validateId(correlation.attemptId, "attemptId");
  }
}

export function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecrets(entry));
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(entry);
  }
  return output;
}

export function redactAuditEvent(event: AuditEvent): AuditEvent {
  return Object.freeze({
    ...event,
    details: Object.freeze(redactSecrets(event.details) as Record<
      string,
      unknown
    >),
  });
}

function validateId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_AUDIT_EVENT", `${label} must not be empty.`);
  }
}
