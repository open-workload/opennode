/**
 * API-15 CLI request plumbing. Resolves the API base URL lazily (so
 * `--api-url` and `OPENNODE_API_URL` set after import still take effect) and
 * builds the auth header both the JSON and SSE log paths share.
 *
 *   flagUrl ▶ envUrl ▶ creds.apiUrl ▶ DEFAULT_API_BASE_URL ──▶ base URL
 *
 *   creds (unexpired) ──▶ Authorization: Bearer <token> ──┐
 *   extra headers ────────────────────────────────────────┴──▶ authedFetch
 *
 * Kept free of filesystem/commander so the resolution and header rules are
 * unit-testable; bin/cli.ts owns credential storage and argv parsing.
 */

export interface CliCredentials {
  token: string;
  expiresAt: number;
  apiUrl?: string;
}

export const DEFAULT_API_BASE_URL = "http://localhost:3000";

export interface ApiBaseSources {
  flagUrl?: string;
  envUrl?: string;
  creds?: CliCredentials | null;
}

export function resolveApiBaseUrl(sources: ApiBaseSources = {}): string {
  return sources.flagUrl ?? sources.envUrl ?? sources.creds?.apiUrl ?? DEFAULT_API_BASE_URL;
}

export function buildAuthHeaders(
  creds: CliCredentials | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (creds && creds.expiresAt > Date.now()) {
    headers.Authorization = `Bearer ${creds.token}`;
  }
  return headers;
}

export function authedFetch(
  url: string,
  creds: CliCredentials | null,
  init: RequestInit = {},
): Promise<Response> {
  const headers = buildAuthHeaders(creds, (init.headers as Record<string, string>) ?? {});
  return fetch(url, { ...init, headers });
}
