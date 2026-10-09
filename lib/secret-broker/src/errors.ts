import { DomainError, DomainErrorCode } from "@workspace/opennode-domain";

export type SecretBrokerErrorCode =
  | "SECRET_NOT_FOUND"
  | "UNAUTHORIZED_WORKER"
  | "INVALID_JOB_SCOPE"
  | "SECRET_EXPIRED"
  | "INVALID_SECRET_ID"
  | DomainErrorCode;

export class SecretBrokerError extends DomainError {
  constructor(code: SecretBrokerErrorCode, message: string) {
    super(code as DomainErrorCode, message);
    this.name = "SecretBrokerError";
  }
}

export function isSecretBrokerError(error: unknown): error is SecretBrokerError {
  return error instanceof SecretBrokerError;
}