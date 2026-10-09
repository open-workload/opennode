import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import {
  createNodeId,
  createClusterId,
  createJobSpec,
  createAttempt,
  createLogChunk,
  createArtifactRef,
  createVote,
  isVoteBoundTo,
  isVoteExpired,
  createClusterEvent,
  assertNodeId,
  assertClusterId,
  SCHEMA_VERSION,
} from './schemas';

describe('schemas', () => {
  describe('createNodeId', () => {
    it('creates a valid NodeId', () => {
      const nodeId = createNodeId('node-123');
      expect(nodeId.schemaVersion).toBe(SCHEMA_VERSION);
      expect(nodeId.value).toBe('node-123');
    });

    it('throws for empty value', () => {
      expect(() => createNodeId('')).toThrow(DomainError);
      expect(() => createNodeId('   ')).toThrow(DomainError);
    });
  });

  describe('createClusterId', () => {
    it('creates a valid ClusterId', () => {
      const clusterId = createClusterId('cluster-123');
      expect(clusterId.schemaVersion).toBe(SCHEMA_VERSION);
      expect(clusterId.value).toBe('cluster-123');
    });

    it('throws for empty value', () => {
      expect(() => createClusterId('')).toThrow(DomainError);
    });
  });

  describe('createJobSpec', () => {
    const validInput = {
      jobId: 'job-1',
      clusterId: createClusterId('cluster-1'),
      image: 'my-image:latest',
      createdBy: createNodeId('node-1'),
    };

    it('creates a valid JobSpec', () => {
      const spec = createJobSpec(validInput);
      expect(spec.schemaVersion).toBe(SCHEMA_VERSION);
      expect(spec.jobId).toBe('job-1');
      expect(spec.clusterId).toBe(validInput.clusterId);
      expect(spec.image).toBe('my-image:latest');
      expect(spec.createdBy).toBe(validInput.createdBy);
    });

    it('throws for empty jobId', () => {
      expect(() => createJobSpec({ ...validInput, jobId: '' })).toThrow(DomainError);
    });

    it('throws for empty image', () => {
      expect(() => createJobSpec({ ...validInput, image: '' })).toThrow(DomainError);
    });

    it('throws for invalid clusterId', () => {
      expect(() => createJobSpec({ ...validInput, clusterId: { schemaVersion: 2, value: 'c' } as any })).toThrow(DomainError);
    });

    it('throws for invalid createdBy', () => {
      expect(() => createJobSpec({ ...validInput, createdBy: { schemaVersion: 2, value: 'n' } as any })).toThrow(DomainError);
    });
  });

  describe('createAttempt', () => {
    it('creates a valid Attempt', () => {
      const attempt = createAttempt({ attemptId: 'attempt-1', jobId: 'job-1', ordinal: 1 });
      expect(attempt.schemaVersion).toBe(SCHEMA_VERSION);
      expect(attempt.attemptId).toBe('attempt-1');
      expect(attempt.jobId).toBe('job-1');
      expect(attempt.ordinal).toBe(1);
    });

    it('throws for empty attemptId', () => {
      expect(() => createAttempt({ attemptId: '', jobId: 'job-1', ordinal: 1 })).toThrow(DomainError);
    });

    it('throws for empty jobId', () => {
      expect(() => createAttempt({ attemptId: 'attempt-1', jobId: '', ordinal: 1 })).toThrow(DomainError);
    });

    it('throws for negative ordinal', () => {
      expect(() => createAttempt({ attemptId: 'attempt-1', jobId: 'job-1', ordinal: -1 })).toThrow(DomainError);
    });

    it('throws for non-integer ordinal', () => {
      expect(() => createAttempt({ attemptId: 'attempt-1', jobId: 'job-1', ordinal: 1.5 })).toThrow(DomainError);
    });
  });

  describe('createLogChunk', () => {
    it('creates a valid LogChunk', () => {
      const chunk = createLogChunk({
        chunkId: 'chunk-1',
        attemptId: 'attempt-1',
        stream: 'stdout',
        sequence: 1,
        content: 'hello',
      });
      expect(chunk.schemaVersion).toBe(SCHEMA_VERSION);
      expect(chunk.chunkId).toBe('chunk-1');
      expect(chunk.attemptId).toBe('attempt-1');
      expect(chunk.stream).toBe('stdout');
      expect(chunk.sequence).toBe(1);
      expect(chunk.content).toBe('hello');
    });

    it('throws for invalid stream', () => {
      expect(() => createLogChunk({ chunkId: 'c', attemptId: 'a', stream: 'invalid' as any, sequence: 1, content: 'x' })).toThrow(DomainError);
    });

    it('throws for negative sequence', () => {
      expect(() => createLogChunk({ chunkId: 'c', attemptId: 'a', stream: 'stdout', sequence: -1, content: 'x' })).toThrow(DomainError);
    });
  });

  describe('createArtifactRef', () => {
    it('creates a valid ArtifactRef', () => {
      const ref = createArtifactRef({
        artifactId: 'artifact-1',
        jobId: 'job-1',
        attemptId: 'attempt-1',
        uri: 's3://bucket/key',
        sha256: 'a'.repeat(64),
      });
      expect(ref.schemaVersion).toBe(SCHEMA_VERSION);
      expect(ref.artifactId).toBe('artifact-1');
      expect(ref.sha256).toBe('a'.repeat(64));
    });

    it('throws for invalid sha256', () => {
      expect(() => createArtifactRef({ artifactId: 'a', jobId: 'j', attemptId: 'a', uri: 'u', sha256: 'invalid' })).toThrow(DomainError);
      expect(() => createArtifactRef({ artifactId: 'a', jobId: 'j', attemptId: 'a', uri: 'u', sha256: 'G'.repeat(64) })).toThrow(DomainError);
      expect(() => createArtifactRef({ artifactId: 'a', jobId: 'j', attemptId: 'a', uri: 'u', sha256: 'a'.repeat(63) })).toThrow(DomainError);
    });
  });

  describe('createVote', () => {
    const validInput = {
      proposalId: 'prop-1',
      clusterId: createClusterId('cluster-1'),
      voterId: createNodeId('node-1'),
      epoch: 1,
      choice: 'yes' as const,
      expiry: Date.now() + 10000,
    };

    it('creates a valid Vote', () => {
      const vote = createVote(validInput);
      expect(vote.schemaVersion).toBe(SCHEMA_VERSION);
      expect(vote.proposalId).toBe('prop-1');
      expect(vote.choice).toBe('yes');
      expect(vote.expiry).toBe(validInput.expiry);
    });

    it('throws for invalid choice', () => {
      expect(() => createVote({ ...validInput, choice: 'maybe' as any })).toThrow(DomainError);
    });

    it('throws for negative epoch', () => {
      expect(() => createVote({ ...validInput, epoch: -1 })).toThrow(DomainError);
    });

    it('throws for negative expiry', () => {
      expect(() => createVote({ ...validInput, expiry: -1 })).toThrow(DomainError);
    });
  });

  describe('isVoteBoundTo', () => {
    const vote = createVote({
      proposalId: 'prop-1',
      clusterId: createClusterId('cluster-1'),
      voterId: createNodeId('node-1'),
      epoch: 1,
      choice: 'yes',
      expiry: 10000,
    });

    it('returns true for matching binding', () => {
      expect(isVoteBoundTo(vote, { proposalId: 'prop-1', clusterId: createClusterId('cluster-1'), epoch: 1 })).toBe(true);
    });

    it('returns false for different proposalId', () => {
      expect(isVoteBoundTo(vote, { proposalId: 'prop-2', clusterId: createClusterId('cluster-1'), epoch: 1 })).toBe(false);
    });

    it('returns false for different clusterId', () => {
      expect(isVoteBoundTo(vote, { proposalId: 'prop-1', clusterId: createClusterId('cluster-2'), epoch: 1 })).toBe(false);
    });

    it('returns false for different epoch', () => {
      expect(isVoteBoundTo(vote, { proposalId: 'prop-1', clusterId: createClusterId('cluster-1'), epoch: 2 })).toBe(false);
    });
  });

  describe('isVoteExpired', () => {
    const vote = createVote({
      proposalId: 'prop-1',
      clusterId: createClusterId('cluster-1'),
      voterId: createNodeId('node-1'),
      epoch: 1,
      choice: 'yes',
      expiry: 10000,
    });

    it('returns true if expired', () => {
      expect(isVoteExpired(vote, 10001)).toBe(true);
    });

    it('returns false if not expired', () => {
      expect(isVoteExpired(vote, 9999)).toBe(false);
    });

    it('returns true if exactly at expiry', () => {
      expect(isVoteExpired(vote, 10000)).toBe(true);
    });

    it('throws for invalid now', () => {
      expect(() => isVoteExpired(vote, 1.5)).toThrow(DomainError);
      expect(() => isVoteExpired(vote, NaN)).toThrow(DomainError);
      expect(() => isVoteExpired(vote, Infinity)).toThrow(DomainError);
    });
  });

  describe('createClusterEvent', () => {
    it('creates a valid ClusterEvent', () => {
      const event = createClusterEvent({
        eventId: 'evt-1',
        clusterId: createClusterId('cluster-1'),
        sequence: 1,
        epoch: 1,
        kind: 'test.kind',
        correlationId: 'corr-1',
        payload: { data: 'test' },
      });
      expect(event.schemaVersion).toBe(SCHEMA_VERSION);
      expect(event.eventId).toBe('evt-1');
      expect(event.sequence).toBe(1);
      expect(event.epoch).toBe(1);
      expect(event.kind).toBe('test.kind');
      expect(event.correlationId).toBe('corr-1');
      expect(event.payload).toEqual({ data: 'test' });
    });

    it('throws for negative sequence', () => {
      expect(() => createClusterEvent({ eventId: 'e', clusterId: createClusterId('c'), sequence: -1, epoch: 1, kind: 'k', correlationId: 'c', payload: {} })).toThrow(DomainError);
    });

    it('throws for negative epoch', () => {
      expect(() => createClusterEvent({ eventId: 'e', clusterId: createClusterId('c'), sequence: 1, epoch: -1, kind: 'k', correlationId: 'c', payload: {} })).toThrow(DomainError);
    });
  });

  describe('assertNodeId', () => {
    it('passes for valid NodeId', () => {
      expect(() => assertNodeId({ schemaVersion: SCHEMA_VERSION, value: 'node-1' })).not.toThrow();
    });

    it('throws for invalid schemaVersion', () => {
      expect(() => assertNodeId({ schemaVersion: 2, value: 'node-1' } as any)).toThrow(DomainError);
    });

    it('throws for empty value', () => {
      expect(() => assertNodeId({ schemaVersion: SCHEMA_VERSION, value: '' })).toThrow(DomainError);
    });

    it('throws for non-object', () => {
      expect(() => assertNodeId(null as any)).toThrow(DomainError);
    });
  });

  describe('assertClusterId', () => {
    it('passes for valid ClusterId', () => {
      expect(() => assertClusterId({ schemaVersion: SCHEMA_VERSION, value: 'cluster-1' })).not.toThrow();
    });

    it('throws for invalid schemaVersion', () => {
      expect(() => assertClusterId({ schemaVersion: 2, value: 'cluster-1' } as any)).toThrow(DomainError);
    });

    it('throws for empty value', () => {
      expect(() => assertClusterId({ schemaVersion: SCHEMA_VERSION, value: '' })).toThrow(DomainError);
    });
  });
});