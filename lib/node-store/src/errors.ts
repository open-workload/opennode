export type NodeStoreErrorCode =
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_TRANSITION"
  | "INVALID_WORKLOAD"
  | "CORRUPTED_CHECKSUM"
  | "RESTORE_MISMATCH"
  | "INTERNAL";

export class NodeStoreError extends Error {
  constructor(
    public readonly code: NodeStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NodeStoreError";
  }
}
