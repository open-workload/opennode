import { describe, it, expect } from 'vitest';
import { DomainError } from './errors';
import { MembershipService } from './membership-service';

const auditSink = { record: () => {} };

describe('MembershipService.reconcile', () => {
  it('throws INVALID_DECISION when concatenations collide but sorted member sets differ', () => {
    const service = new MembershipService({
      clusterId: 'cluster-1',
      auditSink,
      initialMembers: ['ab', 'c'],
      initialEpoch: 7,
    });

    try {
      service.reconcile({ epoch: 7, memberIds: ['a', 'bc'], sequence: 1 });
      throw new Error('expected reconcile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INVALID_DECISION');
    }
  });

  it('throws INVALID_DECISION for ["abc"] versus ["a","b","c"] at the same epoch', () => {
    const service = new MembershipService({
      clusterId: 'cluster-1',
      auditSink,
      initialMembers: ['abc'],
      initialEpoch: 3,
    });

    try {
      service.reconcile({ epoch: 3, memberIds: ['a', 'b', 'c'], sequence: 1 });
      throw new Error('expected reconcile to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INVALID_DECISION');
    }
  });

  it('returns local membership when committed sets match at the same epoch', () => {
    const service = new MembershipService({
      clusterId: 'cluster-1',
      auditSink,
      initialMembers: ['ab', 'c'],
      initialEpoch: 7,
    });

    const snapshot = service.reconcile({
      epoch: 7,
      memberIds: ['c', 'ab'],
      sequence: 1,
    });

    expect(snapshot.memberIds).toEqual(['ab', 'c']);
  });
});
