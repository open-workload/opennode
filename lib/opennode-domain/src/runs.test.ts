import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import {
  createBuiltInDiagnosticWorkload,
  createArbitraryContainerWorkload,
  createRun,
  transitionRun,
} from './runs';

describe('runs', () => {
  describe('createBuiltInDiagnosticWorkload', () => {
    it('creates a valid workload', () => {
      const workload = createBuiltInDiagnosticWorkload();
      expect(workload.mode).toBe('built-in-diagnostic');
      expect(workload.diagnostic).toBe('health-check');
    });
  });

  describe('createArbitraryContainerWorkload', () => {
    it('creates a valid workload', () => {
      const workload = createArbitraryContainerWorkload('my-image:latest');
      expect(workload.mode).toBe('arbitrary-container');
      expect(workload.image).toBe('my-image:latest');
      expect('command' in workload).toBe(false);
      expect('entrypoint' in workload).toBe(false);
    });

    it('throws for empty image', () => {
      expect(() => createArbitraryContainerWorkload('')).toThrow(DomainError);
    });

    it('throws for whitespace only image', () => {
      expect(() => createArbitraryContainerWorkload('   ')).toThrow(DomainError);
    });
  });

  describe('createRun', () => {
    it('creates a run with built-in diagnostic workload', () => {
      const run = createRun('run-1', createBuiltInDiagnosticWorkload());
      expect(run.runId).toBe('run-1');
      expect(run.workload.mode).toBe('built-in-diagnostic');
      expect(run.state).toBe('queued');
    });

    it('creates a run with container workload', () => {
      const run = createRun('run-1', createArbitraryContainerWorkload('my-image'));
      expect(run.runId).toBe('run-1');
      expect(run.workload.mode).toBe('arbitrary-container');
      expect(run.state).toBe('queued');
    });

    it('throws for empty runId', () => {
      expect(() => createRun('', createBuiltInDiagnosticWorkload())).toThrow(DomainError);
    });

    it('throws for invalid workload', () => {
      expect(() => createRun('run-1', null as any)).toThrow(DomainError);
    });
  });

  describe('transitionRun', () => {
    const run = createRun('run-1', createBuiltInDiagnosticWorkload());

    it('allows queued -> scheduled', () => {
      const next = transitionRun(run, 'scheduled');
      expect(next.state).toBe('scheduled');
      expect(next.runId).toBe('run-1');
    });

    it('allows queued -> cancelled', () => {
      const next = transitionRun(run, 'cancelled');
      expect(next.state).toBe('cancelled');
    });

    it('allows scheduled -> running', () => {
      const scheduled = transitionRun(run, 'scheduled');
      const next = transitionRun(scheduled, 'running');
      expect(next.state).toBe('running');
    });

    it('allows scheduled -> failed', () => {
      const scheduled = transitionRun(run, 'scheduled');
      const next = transitionRun(scheduled, 'failed');
      expect(next.state).toBe('failed');
    });

    it('allows scheduled -> cancelled', () => {
      const scheduled = transitionRun(run, 'scheduled');
      const next = transitionRun(scheduled, 'cancelled');
      expect(next.state).toBe('cancelled');
    });

    it('allows running -> succeeded', () => {
      let r = transitionRun(run, 'scheduled');
      r = transitionRun(r, 'running');
      const next = transitionRun(r, 'succeeded');
      expect(next.state).toBe('succeeded');
    });

    it('allows running -> failed', () => {
      let r = transitionRun(run, 'scheduled');
      r = transitionRun(r, 'running');
      const next = transitionRun(r, 'failed');
      expect(next.state).toBe('failed');
    });

    it('allows running -> cancelled', () => {
      let r = transitionRun(run, 'scheduled');
      r = transitionRun(r, 'running');
      const next = transitionRun(r, 'cancelled');
      expect(next.state).toBe('cancelled');
    });

    it('throws for invalid transitions', () => {
      expect(() => transitionRun(run, 'running')).toThrow(DomainError);
      expect(() => transitionRun(run, 'succeeded')).toThrow(DomainError);
      expect(() => transitionRun(run, 'failed')).toThrow(DomainError);
    });

    it('throws for transitions from terminal states', () => {
      const succeeded = transitionRun(transitionRun(transitionRun(run, 'scheduled'), 'running'), 'succeeded');
      expect(() => transitionRun(succeeded, 'failed')).toThrow(DomainError);
      expect(() => transitionRun(succeeded, 'cancelled')).toThrow(DomainError);
    });

    it('throws for unknown state', () => {
      expect(() => transitionRun({ ...run, state: 'unknown' as any }, 'scheduled')).toThrow(DomainError);
      expect(() => transitionRun(run, 'unknown' as any)).toThrow(DomainError);
    });

    it('throws for empty runId', () => {
      expect(() => transitionRun({ ...run, runId: '' }, 'scheduled')).toThrow(DomainError);
    });
  });
});