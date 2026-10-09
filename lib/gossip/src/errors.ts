export type GossipErrorCode =
  | "INVALID_GOSSIP_MESSAGE"
  | "GOSSIP_MESSAGE_EXPIRED"
  | "GOSSIP_VERSION_REGRESSION"
  | "GOSSIP_CATEGORY_FORBIDDEN"
  | "GOSSIP_NOT_AUTHORITATIVE"
  | "WRONG_CLUSTER"
  | "INVALID_DIGEST"
  | "INVALID_READ_MODEL_EVENT"
  | "READ_MODEL_GAP";

export class GossipError extends Error {
  constructor(
    public readonly code: GossipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GossipError";
  }
}
