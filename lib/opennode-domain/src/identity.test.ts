import { describe, it, expect, vi } from 'vitest';

const dbMock = vi.hoisted(() => {
  const state = { existingIdentity: [] as Array<{ nodeId: string }> };
  const db = {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    select: () => ({ from: () => ({ limit: async () => state.existingIdentity }) }),
  };
  return { db, state };
});

vi.mock('@workspace/db', () => ({
  db: dbMock.db,
  clusterNodesTable: { id: 'clusterNodes.id' },
  localNodeIdentityTable: { singleton: 'localNodeIdentity.singleton', nodeId: 'localNodeIdentity.nodeId' },
}));

import { DomainError } from './errors';
import {
  deriveNodeIdFromSecretKey,
  assertNoNodeIdCollision,
  ensureNodeIdentity,
  type NodeIdentityKeystore,
  type StoredNodeIdentity,
} from './identity';

class InMemoryKeystore implements NodeIdentityKeystore {
  private identity: StoredNodeIdentity | undefined;
  load(): StoredNodeIdentity | undefined {
    return this.identity;
  }
  save(identity: StoredNodeIdentity): void {
    this.identity = identity;
  }
}

describe('identity', () => {
  describe('deriveNodeIdFromSecretKey', () => {
    it('derives consistent node ID from same secret key', () => {
      const secretKey = 'my-secret-key-123';
      const id1 = deriveNodeIdFromSecretKey(secretKey);
      const id2 = deriveNodeIdFromSecretKey(secretKey);
      expect(id1).toBe(id2);
      expect(id1.length).toBe(16);
    });

    it('produces different IDs for different secret keys', () => {
      expect(deriveNodeIdFromSecretKey('key1')).not.toBe(deriveNodeIdFromSecretKey('key2'));
    });

    it('throws for empty secret key', () => {
      expect(() => deriveNodeIdFromSecretKey('')).toThrow(DomainError);
      expect(() => deriveNodeIdFromSecretKey('   ')).toThrow(DomainError);
    });

    it('throws for non-string', () => {
      expect(() => deriveNodeIdFromSecretKey(null as any)).toThrow(DomainError);
      expect(() => deriveNodeIdFromSecretKey(123 as any)).toThrow(DomainError);
    });
  });

  describe('assertNoNodeIdCollision', () => {
    it('passes for unique identities', () => {
      const identities = [
        { secretKey: 'key1', nodeId: 'node1' },
        { secretKey: 'key2', nodeId: 'node2' },
      ];
      expect(() => assertNoNodeIdCollision(identities)).not.toThrow();
    });

    it('throws for collision with different secret keys', () => {
      const identities = [
        { secretKey: 'key1', nodeId: 'node1' },
        { secretKey: 'key2', nodeId: 'node1' },
      ];
      expect(() => assertNoNodeIdCollision(identities)).toThrow(DomainError);
    });

    it('passes for same secret key and node ID', () => {
      const identities = [
        { secretKey: 'key1', nodeId: 'node1' },
        { secretKey: 'key1', nodeId: 'node1' },
      ];
      expect(() => assertNoNodeIdCollision(identities)).not.toThrow();
    });

    it('handles empty array', () => {
      expect(() => assertNoNodeIdCollision([])).not.toThrow();
    });
  });

  describe('ensureNodeIdentity', () => {
    it('creates the identity exactly once and reuses it across boots', async () => {
      const keystore = new InMemoryKeystore();
      const createSecretKey = vi.fn(() => 'persisted-secret');

      const first = await ensureNodeIdentity(keystore, createSecretKey);
      const second = await ensureNodeIdentity(keystore, createSecretKey);

      expect(second.nodeId.value).toBe(first.nodeId.value);
      expect(first.nodeId.value).toBe(deriveNodeIdFromSecretKey('persisted-secret'));
      expect(createSecretKey).toHaveBeenCalledTimes(1);
    });

    it('refuses to boot when the stored key does not match its node ID', async () => {
      const keystore = new InMemoryKeystore();
      keystore.save({ secretKey: 'secret-a', nodeId: 'forged-node' });

      await expect(ensureNodeIdentity(keystore, () => 'secret-b')).rejects.toMatchObject({
        code: 'IDENTITY_COLLISION',
      });
    });

    it('refuses to boot when local_node_identity disagrees with the derived node ID', async () => {
      const keystore = new InMemoryKeystore();
      await ensureNodeIdentity(keystore, () => 'secret-a');
      dbMock.state.existingIdentity = [{ nodeId: 'someone-else' }];

      await expect(ensureNodeIdentity(keystore, () => 'secret-a')).rejects.toMatchObject({
        code: 'IDENTITY_COLLISION',
      });
    });
  });
});