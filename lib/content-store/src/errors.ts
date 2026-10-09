export type ContentStoreErrorCode =
  | "INVALID_CHUNK_ADDRESS"
  | "CHECKSUM_MISMATCH"
  | "DECRYPTION_FAILED"
  | "ENCRYPTION_FAILED"
  | "CHUNK_TOO_LARGE"
  | "STREAM_EXHAUSTED"
  | "INVALID_CURSOR"
  | "DUPLICATE_CHUNK"
  | "RETENTION_VIOLATION"
  | "REPLICATION_QUORUM_NOT_MET";

export class ContentStoreError extends Error {
  constructor(
    public readonly code: ContentStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContentStoreError";
  }
}