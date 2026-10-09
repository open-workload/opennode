export interface GuardResult {
  readonly name: string;
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly summary: string;
}
