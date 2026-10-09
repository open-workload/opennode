export class FeatureFlagsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = "FeatureFlagsError";
  }
}