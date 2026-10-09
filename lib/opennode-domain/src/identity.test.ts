import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import {
  deriveNodeIdFromSecretKey,
  assertNoNodeIdCollision,
} from './identity';

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
});