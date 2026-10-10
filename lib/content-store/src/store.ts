import { ChunkStore, StoredChunk } from "./chunk";

export interface ListableChunkStore extends ChunkStore {
  list(): Promise<readonly StoredChunk[]>;
  count(): number;
}

export class InMemoryChunkStore implements ListableChunkStore {
  private readonly chunks = new Map<string, StoredChunk>();

  async put(chunk: StoredChunk): Promise<void> {
    this.chunks.set(chunk.address, chunk);
  }

  async get(address: string): Promise<StoredChunk | undefined> {
    return this.chunks.get(address);
  }

  async delete(address: string): Promise<void> {
    this.chunks.delete(address);
  }

  async has(address: string): Promise<boolean> {
    return this.chunks.has(address);
  }

  async list(): Promise<readonly StoredChunk[]> {
    return [...this.chunks.values()];
  }

  count(): number {
    return this.chunks.size;
  }
}
