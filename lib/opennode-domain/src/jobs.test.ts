import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import {
  createJob,
  transitionJob,
  createJobAttempt,
  transitionAttempt,
  isTerminalJobState,
} from './jobs';
import { createJobSpec, createAttempt, SCHEMA_VERSION } from './schemas';

describe('jobs', () => {
  const validSpec = createJobSpec({
    jobId: 'job-1',
    clusterId: { schemaVersion: SCHEMA_VERSION, value: 'cluster-1' },
    image: 'my-image:latest',
    createdBy: { schemaVersion: SCHEMA_VERSION, value: 'node-1' },
  });

  describe('createJob', () => {
    it('creates a job in queued state', () => {
      const job = createJob(validSpec);
      expect(job.schemaVersion).toBe(SCHEMA_VERSION);
      expect(job.spec).toBe(validSpec);
      expect(job.state).toBe('queued');
    });
  });

  describe('transitionJob', () => {
    const job = createJob(validSpec);

    it('allows queued -> starting', () => {
      const next = transitionJob(job, 'starting');
      expect(next.state).toBe('starting');
    });

    it('allows queued -> cancel-requested', () => {
      const next = transitionJob(job, 'cancel-requested');
      expect(next.state).toBe('cancel-requested');
    });

    it('allows queued -> cancelled', () => {
      const next = transitionJob(job, 'cancelled');
      expect(next.state).toBe('cancelled');
    });

    it('allows queued -> infrastructure-error', () => {
      const next = transitionJob(job, 'infrastructure-error');
      expect(next.state).toBe('infrastructure-error');
    });

    it('allows starting -> running', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'running');
      expect(next.state).toBe('running');
    });

    it('allows starting -> failed', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'failed');
      expect(next.state).toBe('failed');
    });

    it('allows starting -> cancel-requested', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'cancel-requested');
      expect(next.state).toBe('cancel-requested');
    });

    it('allows starting -> cancelled', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'cancelled');
      expect(next.state).toBe('cancelled');
    });

    it('allows starting -> timed-out', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'timed-out');
      expect(next.state).toBe('timed-out');
    });

    it('allows starting -> infrastructure-error', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'infrastructure-error');
      expect(next.state).toBe('infrastructure-error');
    });

    it('allows starting -> lost', () => {
      let j = transitionJob(job, 'starting');
      const next = transitionJob(j, 'lost');
      expect(next.state).toBe('lost');
    });

    it('allows running -> succeeded', () => {
      let j = transitionJob(job, 'starting');
      j = transitionJob(j, 'running');
      const next = transitionJob(j, 'succeeded');
      expect(next.state).toBe('succeeded');
    });

    it('allows running -> failed', () => {
      let j = transitionJob(job, 'starting');
      j = transitionJob(j, 'running');
      const next = transitionJob(j, 'failed');
      expect(next.state).toBe('failed');
    });

    it('allows running -> cancel-requested', () => {
      let j = transitionJob(job, 'starting');
      j = transitionJob(j, 'running');
      const next = transitionJob(j, 'cancel-requested');
      expect(next.state).toBe('cancel-requested');
    });

    it('allows running -> timed-out', () => {
      let j = transitionJob(job, 'starting');
      j = transitionJob(j, 'running');
      const next = transitionJob(j, 'timed-out');
      expect(next.state).toBe('timed-out');
    });

    it('allows running -> infrastructure-error', () => {
      let j = transitionJob(job, 'starting');
      j = transitionJob(j, 'running');
      const next = transitionJob(j, 'infrastructure-error');
      expect(next.state).toBe('infrastructure-error');
    });

    it('allows running -> lost', () => {
      let j = transitionJob(job, 'starting');
      j = transitionJob(j, 'running');
      const next = transitionJob(j, 'lost');
      expect(next.state).toBe('lost');
    });

    it('allows cancel-requested -> cancelled', () => {
      let j = transitionJob(job, 'cancel-requested');
      const next = transitionJob(j, 'cancelled');
      expect(next.state).toBe('cancelled');
    });

    it('allows cancel-requested -> failed', () => {
      let j = transitionJob(job, 'cancel-requested');
      const next = transitionJob(j, 'failed');
      expect(next.state).toBe('failed');
    });

    it('allows cancel-requested -> timed-out', () => {
      let j = transitionJob(job, 'cancel-requested');
      const next = transitionJob(j, 'timed-out');
      expect(next.state).toBe('timed-out');
    });

    it('allows cancel-requested -> infrastructure-error', () => {
      let j = transitionJob(job, 'cancel-requested');
      const next = transitionJob(j, 'infrastructure-error');
      expect(next.state).toBe('infrastructure-error');
    });

    it('allows cancel-requested -> lost', () => {
      let j = transitionJob(job, 'cancel-requested');
      const next = transitionJob(j, 'lost');
      expect(next.state).toBe('lost');
    });

    it('throws for invalid transitions from terminal states', () => {
      const terminalStates = ['succeeded', 'failed', 'cancelled', 'timed-out', 'infrastructure-error', 'lost'];
      for (const state of terminalStates) {
        const terminalJob = { ...job, state } as any;
        expect(() => transitionJob(terminalJob, 'running')).toThrow(DomainError);
      }
    });

    it('throws for unknown states', () => {
      expect(() => transitionJob({ ...job, state: 'unknown' as any }, 'running')).toThrow(DomainError);
      expect(() => transitionJob(job, 'unknown' as any)).toThrow(DomainError);
    });

    it('throws for invalid job object', () => {
      expect(() => transitionJob(null as any, 'running')).toThrow(DomainError);
    });
  });

  describe('createJobAttempt', () => {
    const validAttempt = createAttempt({
      attemptId: 'attempt-1',
      jobId: 'job-1',
      ordinal: 1,
    });

    it('creates attempt in queued state', () => {
      const attempt = createJobAttempt(validAttempt);
      expect(attempt.attempt).toBe(validAttempt);
      expect(attempt.state).toBe('queued');
    });
  });

  describe('transitionAttempt', () => {
    const attempt = createJobAttempt(
      createAttempt({ attemptId: 'attempt-1', jobId: 'job-1', ordinal: 1 })
    );

    it('allows same transitions as job', () => {
      const next = transitionAttempt(attempt, 'starting');
      expect(next.state).toBe('starting');
    });

    it('throws for invalid transitions', () => {
      expect(() => transitionAttempt(attempt, 'running')).toThrow(DomainError);
    });

    it('throws for unknown states', () => {
      expect(() => transitionAttempt(attempt, 'unknown' as any)).toThrow(DomainError);
    });
  });

  describe('isTerminalJobState', () => {
    it('returns true for terminal states', () => {
      expect(isTerminalJobState('succeeded')).toBe(true);
      expect(isTerminalJobState('failed')).toBe(true);
      expect(isTerminalJobState('cancelled')).toBe(true);
      expect(isTerminalJobState('timed-out')).toBe(true);
      expect(isTerminalJobState('infrastructure-error')).toBe(true);
      expect(isTerminalJobState('lost')).toBe(true);
    });

    it('returns false for non-terminal states', () => {
      expect(isTerminalJobState('queued')).toBe(false);
      expect(isTerminalJobState('starting')).toBe(false);
      expect(isTerminalJobState('running')).toBe(false);
      expect(isTerminalJobState('cancel-requested')).toBe(false);
    });
  });
});