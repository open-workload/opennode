import { RaftStorage, RaftLogEntry } from "./types";

export type { RaftStorage } from "./types";

export function createInMemoryRaftStorage(): RaftStorage {
  const entries: RaftLogEntry[] = [];
  let currentTerm = 0;
  let votedFor: string | null = null;
  let snapshotIndex = 0;
  let snapshotTerm = 0;
  let snapshotData: Uint8Array | null = null;

  return {
    async getFirstIndex() {
      return snapshotIndex + 1;
    },
    async getLastIndex() {
      return snapshotIndex + entries.length;
    },
    async getTerm(index: number) {
      if (index <= snapshotIndex) {
        return index === snapshotIndex ? snapshotTerm : 0;
      }
      const entry = entries[index - snapshotIndex - 1];
      return entry?.term ?? 0;
    },
    async getEntry(index: number) {
      if (index <= snapshotIndex) return undefined;
      return entries[index - snapshotIndex - 1];
    },
    async getEntries(from: number, to: number) {
      const result: RaftLogEntry[] = [];
      for (let i = from; i < to; i++) {
        const entry = await this.getEntry(i);
        if (entry) result.push(entry);
      }
      return result;
    },
    async appendEntries(newEntries: readonly RaftLogEntry[]) {
      for (const entry of newEntries) {
        if (entry.index <= snapshotIndex) continue;
        const idx = entry.index - snapshotIndex - 1;
        if (idx < 0) continue;
        if (idx >= entries.length) {
          while (entries.length < idx) {
            entries.push({ index: 0, term: 0, entry: null as any });
          }
          entries.push(entry);
        } else {
          entries[idx] = entry;
        }
      }
    },
    async truncateSuffix(index: number) {
      if (index <= snapshotIndex) {
        entries.length = 0;
        return;
      }
      const idx = index - snapshotIndex - 1;
      if (idx < entries.length) {
        entries.splice(idx);
      }
    },
    async truncateTo(height: number) {
      if (height <= snapshotIndex) {
        entries.length = 0;
        return;
      }
      const idx = height - snapshotIndex - 1;
      if (idx < entries.length) {
        entries.splice(idx);
      }
    },
    async setTerm(term: number) {
      currentTerm = term;
    },
    async getCurrentTerm() {
      return currentTerm;
    },
    async setVotedFor(candidateId: string) {
      votedFor = candidateId;
    },
    async getVotedFor() {
      return votedFor;
    },
    async saveSnapshot(index: number, term: number, data: Uint8Array) {
      snapshotIndex = index;
      snapshotTerm = term;
      snapshotData = data;
      const firstKept = index + 1;
      const toRemove = firstKept - snapshotIndex - 1;
      if (toRemove > 0 && toRemove <= entries.length) {
        entries.splice(0, toRemove);
      }
    },
    async loadSnapshot() {
      if (snapshotData === null) return null;
      return { index: snapshotIndex, term: snapshotTerm, data: snapshotData };
    },
  };
}