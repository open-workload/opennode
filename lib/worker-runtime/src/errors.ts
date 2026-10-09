export class WorkerRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkerRuntimeError";
  }
}

export class WorkerSpecError extends WorkerRuntimeError {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid WorkerSpec: ${issues.join("; ")}`, "invalid_spec");
    this.name = "WorkerSpecError";
  }
}
