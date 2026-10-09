export type SyncEngineErrorCode =
  | "INVALID_SYNC_EVENT"
  | "BROKEN_HASH_LINK"
  | "SIGNATURE_INVALID"
  | "UNKNOWN_SIGNER"
  | "SEQUENCE_GAP"
  | "EPOCH_REGRESSION"
  | "WRONG_CLUSTER"
  | "SCHEMA_VERSION_MISMATCH"
  | "SNAPSHOT_INVALID"
  | "SNAPSHOT_UNAPPROVED"
  | "SNAPSHOT_SIGNATURE_INVALID"
  | "SNAPSHOT_ROOT_MISMATCH"
  | "MERKLE_ROOT_MISMATCH"
  | "CHECKPOINT_INVALID"
  | "DIVERGED_LOG"
  | "INCOMPLETE_CHUNK";

export class SyncEngineError extends Error {
  constructor(
    public readonly code: SyncEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyncEngineError";
  }
}
