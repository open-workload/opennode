import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import {
  computePayloadHash,
  createSubmissionRecord,
  resolveIdempotentSubmission,
  extractIdempotencyKey,
} from './idempotency';

describe('idempotency', () => {
  describe('computePayloadHash', () => {
    it('computes consistent hash for same payload', () => {
      const payload = { foo: 'bar', num: 42 };
      const hash1 = computePayloadHash(payload);
      const hash2 = computePayloadHash(payload);
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(8);
    });

    it('produces different hashes for different payloads', () => {
      expect(computePayloadHash({ a: 1 })).not.toBe(computePayloadHash({ a: 2 }));
      expect(computePayloadHash({ a: 1 })).not.toBe(computePayloadHash({ b: 1 }));
    });

    it('handles null', () => {
      expect(computePayloadHash(null)).toBe('77074ba4');
    });

    it('handles boolean', () => {
      expect(computePayloadHash(true)).toBe('4db211e5');
      expect(computePayloadHash(false)).toBe('0b069958');
    });

    it('handles number', () => {
      expect(computePayloadHash(42)).toBe('87e38583');
      expect(computePayloadHash(0)).toBe('350ca8af');
      expect(computePayloadHash(-1)).toBe('14cd0a2b');
    });

    it('handles string', () => {
      expect(computePayloadHash('hello')).toBe('df47ee8b');
    });

    it('handles arrays', () => {
      expect(computePayloadHash([1, 2, 3])).toBe('e0f965d9');
    });

    it('handles objects with sorted keys', () => {
      expect(computePayloadHash({ b: 1, a: 2 })).toBe(computePayloadHash({ a: 2, b: 1 }));
    });

    it('excludes undefined values', () => {
      expect(computePayloadHash({ a: 1, b: undefined })).toBe(computePayloadHash({ a: 1 }));
    });

    it('throws for non-serializable values', () => {
      expect(() => computePayloadHash(Symbol('test'))).toThrow(DomainError);
      expect(() => computePayloadHash({ sym: Symbol('test') })).toThrow(DomainError);
    });
  });

  describe('createSubmissionRecord', () => {
    it('creates a valid record', () => {
      const record = createSubmissionRecord('actor-1', 'key-1', { data: 'test' });
      expect(record.actorId).toBe('actor-1');
      expect(record.key).toBe('key-1');
      expect(record.payloadHash).toBe(computePayloadHash({ data: 'test' }));
      expect(record.runId).toMatch(/^run-/);
      expect(record.expiresAt).toBeInstanceOf(Date);
      expect(record.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('throws for empty key', () => {
      expect(() => createSubmissionRecord('actor-1', '', { data: 'test' })).toThrow(DomainError);
    });

    it('throws for empty actorId', () => {
      expect(() => createSubmissionRecord('', 'key-1', { data: 'test' })).toThrow(DomainError);
    });
  });

  describe('resolveIdempotentSubmission', () => {
    const actorId = 'actor-1';
    const key = 'key-1';
    const payload = { data: 'test' };
    const record = createSubmissionRecord(actorId, key, payload);

    it('creates new submission if no existing record', () => {
      const result = resolveIdempotentSubmission(actorId, key, payload, undefined);
      expect(result.runId).toBe(record.runId);
      expect(result.record.actorId).toBe(record.actorId);
      expect(result.record.key).toBe(record.key);
      expect(result.record.payloadHash).toBe(record.payloadHash);
      expect(result.record.runId).toBe(record.runId);
    });

    it('returns existing record if payload matches', () => {
      const result = resolveIdempotentSubmission(actorId, key, payload, record);
      expect(result.runId).toBe(record.runId);
      expect(result.record).toBe(record);
    });

    it('throws for different actor', () => {
      expect(() => resolveIdempotentSubmission('actor-2', key, payload, record)).toThrow(DomainError);
    });

    it('throws for different key', () => {
      expect(() => resolveIdempotentSubmission(actorId, 'key-2', payload, record)).toThrow(DomainError);
    });

    it('throws for expired record', () => {
      const expiredRecord = { ...record, expiresAt: new Date(Date.now() - 1000) };
      expect(() => resolveIdempotentSubmission(actorId, key, payload, expiredRecord)).toThrow(DomainError);
    });

    it('throws for different payload', () => {
      expect(() => resolveIdempotentSubmission(actorId, key, { data: 'different' }, record)).toThrow(DomainError);
    });

    it('throws for invalid existing record', () => {
      expect(() => resolveIdempotentSubmission(actorId, key, payload, { actorId: 'x', key: 'y', payloadHash: 'z', runId: 'r', expiresAt: new Date() } as any)).toThrow(DomainError);
    });
  });

  describe('extractIdempotencyKey', () => {
    it('extracts from lowercase header', () => {
      expect(extractIdempotencyKey({ 'idempotency-key': 'key-1' })).toBe('key-1');
    });

    it('extracts from exact case header', () => {
      expect(extractIdempotencyKey({ 'Idempotency-Key': 'key-1' })).toBe('key-1');
    });

    it('returns null if not present', () => {
      expect(extractIdempotencyKey({})).toBeNull();
    });

    it('trims whitespace', () => {
      expect(extractIdempotencyKey({ 'idempotency-key': '  key-1  ' })).toBe('key-1');
    });

    it('returns null for empty string', () => {
      expect(extractIdempotencyKey({ 'idempotency-key': '   ' })).toBeNull();
    });
  });
});