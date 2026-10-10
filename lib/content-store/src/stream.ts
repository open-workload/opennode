/**
 * Bounded writer that chunks and stores a run's output stream, and its reader.
 *
 *   bytes ──▶ count / size / duration guards ──▶ chunker.chunk ──▶ store.put
 *              │   over any limit: STREAM_EXHAUSTED              └──▶ StreamChunk
 *   close | truncate ──▶ StreamResult { chunks, totalSize, durationMs, truncated }
 *
 *   chunk refs ──▶ store.get ──▶ verifyRef ──▶ unchunk ──▶ yields plaintext
 */
import { StoredChunk, ChunkRef, ChunkerOptions, createChunker } from "./chunk";
import { Encryptor } from "./encryption";
import { ContentStoreError } from "./errors";

export type StreamType = "logs" | "metrics" | "traces" | "events" | string;

export type { ChunkRef };

export interface StreamChunk extends ChunkRef {
  readonly sequence: number;
  readonly isLast: boolean;
}

export interface StreamOptions {
  readonly attemptId: string;
  readonly streamType: StreamType;
  readonly maxChunks?: number;
  readonly maxTotalSize?: number;
  readonly maxDurationMs?: number;
}

export interface StreamResult {
  readonly chunks: readonly StreamChunk[];
  readonly totalSize: number;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface BoundedStreamConfig {
  readonly chunker: ReturnType<typeof createChunker>;
  readonly store: {
    put(chunk: StoredChunk): Promise<void>;
    get(address: string): Promise<StoredChunk | undefined>;
  };
}

export function createBoundedStream(
  config: BoundedStreamConfig,
  options: StreamOptions,
) {
  const { chunker, store } = config;
  const { attemptId, streamType, maxChunks = 1000, maxTotalSize = 100 * 1024 * 1024, maxDurationMs = 5 * 60 * 1000 } = options;

  let sequence = 0;
  let totalSize = 0;
  const startTime = Date.now();
  const chunks: StreamChunk[] = [];
  let closed = false;

  async function write(data: Uint8Array): Promise<StreamChunk> {
    if (closed) {
      throw new ContentStoreError("STREAM_EXHAUSTED", "Stream has been closed");
    }

    if (chunks.length >= maxChunks) {
      throw new ContentStoreError("STREAM_EXHAUSTED", `Maximum chunks (${maxChunks}) exceeded`);
    }

    if (totalSize + data.length > maxTotalSize) {
      throw new ContentStoreError("STREAM_EXHAUSTED", `Maximum total size (${maxTotalSize}) exceeded`);
    }

    if (Date.now() - startTime > maxDurationMs) {
      throw new ContentStoreError("STREAM_EXHAUSTED", `Maximum duration (${maxDurationMs}ms) exceeded`);
    }

    const stored = await chunker.chunk(data, attemptId, streamType);
    await store.put(stored);

    const ref = chunker.createRef(stored);
    const streamChunk: StreamChunk = Object.freeze({
      ...ref,
      sequence: sequence++,
      isLast: false,
    });

    chunks.push(streamChunk);
    totalSize += data.length;

    return streamChunk;
  }

  function close(): StreamResult {
    closed = true;
    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk) {
      chunks[chunks.length - 1] = Object.freeze({
        ...lastChunk,
        isLast: true,
      });
    }
    return Object.freeze({
      chunks: Object.freeze(chunks),
      totalSize,
      durationMs: Date.now() - startTime,
      truncated: false,
    });
  }

  function truncate(reason: string): StreamResult {
    closed = true;
    return Object.freeze({
      chunks: Object.freeze(chunks),
      totalSize,
      durationMs: Date.now() - startTime,
      truncated: true,
    });
  }

  function getChunks(): readonly StreamChunk[] {
    return Object.freeze([...chunks]);
  }

  function getStats() {
    return {
      chunkCount: chunks.length,
      totalSize,
      durationMs: Date.now() - startTime,
      isClosed: closed,
    };
  }

  return Object.freeze({
    write,
    close,
    truncate,
    getChunks,
    getStats,
  });
}

export interface StreamReaderOptions {
  readonly attemptId: string;
  readonly streamType: StreamType;
  readonly chunker: ReturnType<typeof createChunker>;
  readonly store: {
    get(address: string): Promise<StoredChunk | undefined>;
  };
  readonly chunkRefs: readonly ChunkRef[];
}

export async function* readStream(opts: StreamReaderOptions): AsyncGenerator<Uint8Array, void, unknown> {
  const { chunker, store, chunkRefs } = opts;

  for (const ref of chunkRefs) {
    const stored = await store.get(ref.address);
    if (!stored) {
      throw new ContentStoreError("INVALID_CHUNK_ADDRESS", `Chunk not found: ${ref.address}`);
    }
    if (!chunker.verifyRef(stored, ref.metadata.checksum)) {
      throw new ContentStoreError("CHECKSUM_MISMATCH", `Checksum mismatch for chunk ${ref.address}`);
    }
    const payload = await chunker.unchunk(stored);
    yield payload.data;
  }
}

export function createStreamCursor(chunks: readonly StreamChunk[], index: number): string {
  if (index < 0 || index >= chunks.length) {
    throw new ContentStoreError("INVALID_CURSOR", `Index ${index} out of bounds for ${chunks.length} chunks`);
  }
  return Buffer.from(JSON.stringify({
    attemptId: chunks[0]?.metadata.attemptId ?? "",
    streamType: chunks[0]?.metadata.streamType ?? "",
    index,
  })).toString("base64url");
}

export function parseStreamCursor(cursor: string): { attemptId: string; streamType: string; index: number } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof decoded.attemptId !== "string" ||
      typeof decoded.streamType !== "string" ||
      typeof decoded.index !== "number"
    ) {
      throw new Error("Invalid cursor structure");
    }
    return decoded;
  } catch {
    throw new ContentStoreError("INVALID_CURSOR", "Failed to parse cursor");
  }
}