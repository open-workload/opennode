import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import {
  createAuditEvent,
  validateCorrelation,
  redactSecrets,
  redactAuditEvent,
} from './audit';

describe('audit', () => {
  describe('createAuditEvent', () => {
    const validInput = {
      eventId: 'evt-1',
      kind: 'test.kind',
      correlation: { requestId: 'req-1', runId: 'run-1', attemptId: 'attempt-1' },
      details: { key: 'value' },
    };

    it('creates a valid audit event', () => {
      const event = createAuditEvent(validInput);
      expect(event.schemaVersion).toBe(1);
      expect(event.eventId).toBe('evt-1');
      expect(event.kind).toBe('test.kind');
      expect(event.correlation).toEqual({
        requestId: 'req-1',
        runId: 'run-1',
        attemptId: 'attempt-1',
      });
      expect(event.details).toEqual({ key: 'value' });
    });

    it('creates event without details', () => {
      const event = createAuditEvent({ ...validInput, details: undefined });
      expect(event.details).toEqual({});
    });

    it('throws for empty eventId', () => {
      expect(() => createAuditEvent({ ...validInput, eventId: '' })).toThrow(DomainError);
    });

    it('throws for empty kind', () => {
      expect(() => createAuditEvent({ ...validInput, kind: '' })).toThrow(DomainError);
    });

    it('throws for invalid correlation', () => {
      expect(() => createAuditEvent({ ...validInput, correlation: null as any })).toThrow(DomainError);
    });

    it('throws for empty requestId', () => {
      expect(() => createAuditEvent({ ...validInput, correlation: { requestId: '', runId: 'run-1' } })).toThrow(DomainError);
    });

    it('throws for non-object details', () => {
      expect(() => createAuditEvent({ ...validInput, details: 'string' as any })).toThrow(DomainError);
      expect(() => createAuditEvent({ ...validInput, details: [] as any })).toThrow(DomainError);
    });

    it('validates optional runId and attemptId', () => {
      expect(() => createAuditEvent({ ...validInput, correlation: { requestId: 'req-1', runId: '' } })).toThrow(DomainError);
      expect(() => createAuditEvent({ ...validInput, correlation: { requestId: 'req-1', attemptId: '' } })).toThrow(DomainError);
    });
  });

  describe('validateCorrelation', () => {
    it('passes for valid correlation', () => {
      expect(() => validateCorrelation({ requestId: 'req-1', runId: 'run-1', attemptId: 'attempt-1' })).not.toThrow();
    });

    it('passes with only requestId', () => {
      expect(() => validateCorrelation({ requestId: 'req-1' })).not.toThrow();
    });

    it('throws for missing correlation', () => {
      expect(() => validateCorrelation(null as any)).toThrow(DomainError);
      expect(() => validateCorrelation(undefined as any)).toThrow(DomainError);
    });

    it('throws for empty requestId', () => {
      expect(() => validateCorrelation({ requestId: '' })).toThrow(DomainError);
    });
  });

  describe('redactSecrets', () => {
    it('redacts secret keys in objects', () => {
      const input = { password: 'secret', token: 'abc', normal: 'value' };
      const output = redactSecrets(input);
      expect(output).toEqual({ password: '[redacted]', token: '[redacted]', normal: 'value' });
    });

    it('redacts nested secrets', () => {
      const input = { config: { api_key: 'secret', other: 'value' } };
      const output = redactSecrets(input);
      expect(output).toEqual({ config: { api_key: '[redacted]', other: 'value' } });
    });

    it('redacts in arrays', () => {
      const input = [{ secret: 'a' }, { token: 'b' }];
      const output = redactSecrets(input);
      expect(output).toEqual([{ secret: '[redacted]' }, { token: '[redacted]' }]);
    });

    it('handles null and primitives', () => {
      expect(redactSecrets(null)).toBeNull();
      expect(redactSecrets('string')).toBe('string');
      expect(redactSecrets(123)).toBe(123);
      expect(redactSecrets(true)).toBe(true);
    });

    it('matches various secret patterns', () => {
      const patterns = ['secret', 'token', 'password', 'passphrase', 'private', 'credential', 'apiKey', 'api_key'];
      for (const pattern of patterns) {
        const input = { [pattern]: 'value' };
        const output = redactSecrets(input) as Record<string, unknown>;
        expect(output[pattern]).toBe('[redacted]');
      }
    });
  });

  describe('redactAuditEvent', () => {
    it('redacts secrets in audit event details', () => {
      const event = createAuditEvent({
        eventId: 'evt-1',
        kind: 'test',
        correlation: { requestId: 'req-1' },
        details: { password: 'secret', normal: 'value' },
      });
      const redacted = redactAuditEvent(event);
      expect(redacted.details.password).toBe('[redacted]');
      expect(redacted.details.normal).toBe('value');
      expect(redacted.eventId).toBe('evt-1');
    });
  });
});