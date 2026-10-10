/**
 * Cursor paging and address-set diffs over an already-loaded chunk list.
 *
 *   base64url cursor ──▶ { index } ──▶ slice ──▶ CursorPage { items, nextCursor, hasMore }
 *   chunk list ──▶ dedupKey ──▶ drop duplicate ──▶ deduped list
 *
 *   local vs remote addresses ──▶ set diff ──▶ { missing, extra }
 *
 * Paging is in-memory, so the whole list is already resident. The "replace"
 * duplicate policy is not implemented; a duplicate is dropped as under "skip".
 */
import { ChunkRef, StreamChunk } from "./stream";
import { ContentStoreError } from "./errors";

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly totalEstimate: number | null;
}

export interface PaginationOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly direction?: "forward" | "backward";
}

export interface DuplicatePolicy<T> {
  readonly onDuplicate: "skip" | "replace" | "error";
  readonly dedupKey: (item: T) => string;
}

export function createCursorPaginator<T extends { address: string }>(
  items: readonly T[],
  options: PaginationOptions = {},
): CursorPage<T> {
  const { cursor, limit = 100, direction = "forward" } = options;

  let startIndex = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (typeof decoded.index !== "number") {
        throw new Error("Invalid cursor");
      }
      startIndex = direction === "forward" ? decoded.index + 1 : decoded.index - 1;
    } catch {
      throw new ContentStoreError("INVALID_CURSOR", "Failed to parse cursor");
    }
  }

  if (direction === "backward") {
    const endIndex = Math.max(0, startIndex + 1);
    const start = Math.max(0, endIndex - limit);
    const pageItems = items.slice(start, endIndex).reverse();
    const hasMore = start > 0;
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ index: start - 1 })).toString("base64url")
      : null;

    return Object.freeze({
      items: Object.freeze(pageItems),
      nextCursor,
      hasMore,
      totalEstimate: items.length,
    });
  }

  const endIndex = Math.min(items.length, startIndex + limit);
  const pageItems = items.slice(startIndex, endIndex);
  const hasMore = endIndex < items.length;
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ index: endIndex - 1 })).toString("base64url")
    : null;

  return Object.freeze({
    items: Object.freeze(pageItems),
    nextCursor,
    hasMore,
    totalEstimate: items.length,
  });
}

export function deduplicateChunks<T extends ChunkRef>(
  chunks: readonly T[],
  policy: DuplicatePolicy<T> = { onDuplicate: "skip", dedupKey: (c) => c.address },
): readonly T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  const duplicates: T[] = [];

  for (const chunk of chunks) {
    const key = policy.dedupKey(chunk);
    if (seen.has(key)) {
      duplicates.push(chunk);
      if (policy.onDuplicate === "error") {
        throw new ContentStoreError("DUPLICATE_CHUNK", `Duplicate chunk detected: ${key}`);
      }
    } else {
      seen.add(key);
      result.push(chunk);
    }
  }

  return Object.freeze(result);
}

export function createStreamPaginator(
  chunks: readonly StreamChunk[],
  options: PaginationOptions = {},
): CursorPage<StreamChunk> {
  return createCursorPaginator(chunks, options);
}

export function createAddressSet(chunks: readonly ChunkRef[]): Set<string> {
  return new Set(chunks.map((c) => c.address));
}

export function filterKnownChunks<T extends ChunkRef>(
  chunks: readonly T[],
  knownAddresses: Set<string>,
): readonly T[] {
  return Object.freeze(chunks.filter((c) => !knownAddresses.has(c.address)));
}

export function chunkDiff(
  local: readonly ChunkRef[],
  remote: readonly ChunkRef[],
): { readonly missing: readonly ChunkRef[]; readonly extra: readonly ChunkRef[] } {
  const localSet = createAddressSet(local);
  const remoteSet = createAddressSet(remote);

  const missing = Object.freeze(remote.filter((c) => !localSet.has(c.address)));
  const extra = Object.freeze(local.filter((c) => !remoteSet.has(c.address)));

  return Object.freeze({ missing, extra });
}