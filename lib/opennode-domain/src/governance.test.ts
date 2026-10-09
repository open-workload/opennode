import { describe, it, expect, vi } from 'vitest';
import { DomainError } from './errors';
import {
  admissionThreshold,
  evictionThreshold,
  createAdmissionProposal,
  createEvictionProposal,
  createVoluntaryLeaveProposal,
  castGovernanceVote,
  submitEvictionResponse,
  hasGovernancePassed,
  requireVoteProposal,
} from './governance';

describe('governance', () => {
  describe('admissionThreshold', () => {
    it('returns 1 for electorate size 1', () => {
      expect(admissionThreshold(1)).toBe(1);
    });

    it('returns 2 for electorate size 2-9', () => {
      expect(admissionThreshold(2)).toBe(2);
      expect(admissionThreshold(5)).toBe(2);
      expect(admissionThreshold(9)).toBe(2);
    });

    it('returns 20% ceiling for larger electorates', () => {
      expect(admissionThreshold(10)).toBe(2);
      expect(admissionThreshold(11)).toBe(3);
      expect(admissionThreshold(20)).toBe(4);
      expect(admissionThreshold(50)).toBe(10);
      expect(admissionThreshold(100)).toBe(20);
    });

    it('throws for invalid electorate size', () => {
      expect(() => admissionThreshold(0)).toThrow(DomainError);
      expect(() => admissionThreshold(-1)).toThrow(DomainError);
      expect(() => admissionThreshold(1.5)).toThrow(DomainError);
    });
  });

  describe('evictionThreshold', () => {
    it('returns 50% ceiling', () => {
      expect(evictionThreshold(1)).toBe(1);
      expect(evictionThreshold(2)).toBe(1);
      expect(evictionThreshold(3)).toBe(2);
      expect(evictionThreshold(4)).toBe(2);
      expect(evictionThreshold(5)).toBe(3);
      expect(evictionThreshold(10)).toBe(5);
      expect(evictionThreshold(11)).toBe(6);
    });

    it('throws for invalid electorate size', () => {
      expect(() => evictionThreshold(0)).toThrow(DomainError);
      expect(() => evictionThreshold(-1)).toThrow(DomainError);
      expect(() => evictionThreshold(1.5)).toThrow(DomainError);
    });
  });

  describe('threshold golden vectors (GOV-09)', () => {
    const admissionGolden: ReadonlyArray<readonly [number, number]> = [
      [1, 1], [2, 2], [3, 2], [4, 2], [5, 2],
      [6, 2], [7, 2], [8, 2], [9, 2], [10, 2],
      [11, 3], [12, 3], [13, 3], [14, 3], [15, 3],
      [16, 4], [17, 4], [18, 4], [19, 4], [20, 4],
    ];

    const evictionGolden: ReadonlyArray<readonly [number, number]> = [
      [1, 1], [2, 1], [3, 2], [4, 2], [5, 3],
      [6, 3], [7, 4], [8, 4], [9, 5], [10, 5],
      [11, 6], [12, 6], [13, 7], [14, 7], [15, 8],
      [16, 8], [17, 9], [18, 9], [19, 10], [20, 10],
    ];

    it.each(admissionGolden)(
      'admissionThreshold(%i) equals published value %i',
      (n, expected) => {
        expect(admissionThreshold(n)).toBe(expected);
      },
    );

    it.each(evictionGolden)(
      'evictionThreshold(%i) equals published value %i',
      (n, expected) => {
        expect(evictionThreshold(n)).toBe(expected);
      },
    );

    it('matches the exact rational value where a float could differ (N=15)', () => {
      // 20% of 15 is exactly 3. A floating-point `0.2 * 15` can round above 3.0
      // on some engines, which would make Math.ceil return 4. Integer arithmetic
      // cannot: (15 * 20) / 100 is exactly 3.
      const exactAdmission = Number((15n * 20n) / 100n);
      const exactEviction = Number((15n * 50n + 99n) / 100n);
      expect(exactAdmission).toBe(3);
      expect(exactEviction).toBe(8);
      expect(admissionThreshold(15)).toBe(exactAdmission);
      expect(evictionThreshold(15)).toBe(exactEviction);
    });
  });

  describe('createAdmissionProposal', () => {
    const validInput = {
      proposalId: 'prop-1',
      epoch: 1,
      electorate: ['node-1', 'node-2', 'node-3'],
      candidateId: 'node-4',
    };

    it('creates a valid admission proposal', () => {
      const proposal = createAdmissionProposal(validInput);
      expect(proposal.kind).toBe('admission');
      expect(proposal.proposalId).toBe('prop-1');
      expect(proposal.epoch).toBe(1);
      expect(proposal.candidateId).toBe('node-4');
      expect(proposal.status).toBe('open');
      expect(proposal.votes).toEqual([]);
      expect(proposal.electorate).toEqual(['node-1', 'node-2', 'node-3']);
    });

    it('throws for empty proposalId', () => {
      expect(() => createAdmissionProposal({ ...validInput, proposalId: '' })).toThrow(DomainError);
    });

    it('throws for empty candidateId', () => {
      expect(() => createAdmissionProposal({ ...validInput, candidateId: '' })).toThrow(DomainError);
    });

    it('throws for empty electorate', () => {
      expect(() => createAdmissionProposal({ ...validInput, electorate: [] })).toThrow(DomainError);
    });

    it('throws for duplicate electorate members', () => {
      expect(() => createAdmissionProposal({ ...validInput, electorate: ['node-1', 'node-1'] })).toThrow(DomainError);
    });

    it('throws if candidate is already in electorate', () => {
      expect(() => createAdmissionProposal({ ...validInput, electorate: ['node-4'] })).toThrow(DomainError);
    });

    it('throws for negative epoch', () => {
      expect(() => createAdmissionProposal({ ...validInput, epoch: -1 })).toThrow(DomainError);
    });
  });

  describe('createEvictionProposal', () => {
    const validInput = {
      proposalId: 'prop-1',
      epoch: 1,
      electorate: ['node-1', 'node-2', 'node-3'],
      targetId: 'node-2',
    };

    it('creates a valid eviction proposal', () => {
      const proposal = createEvictionProposal(validInput);
      expect(proposal.kind).toBe('eviction');
      expect(proposal.proposalId).toBe('prop-1');
      expect(proposal.epoch).toBe(1);
      expect(proposal.targetId).toBe('node-2');
      expect(proposal.status).toBe('open');
      expect(proposal.votes).toEqual([]);
      expect(proposal.electorate).toEqual(['node-1', 'node-2', 'node-3']);
    });

    it('throws if target is not in electorate', () => {
      expect(() => createEvictionProposal({ ...validInput, targetId: 'node-4' })).toThrow(DomainError);
    });

    it('throws for empty electorate', () => {
      expect(() => createEvictionProposal({ ...validInput, electorate: [] })).toThrow(DomainError);
    });
  });

  describe('createVoluntaryLeaveProposal', () => {
    const validInput = {
      proposalId: 'prop-1',
      epoch: 1,
      memberId: 'node-1',
    };

    it('creates a passed voluntary leave proposal', () => {
      const proposal = createVoluntaryLeaveProposal(validInput);
      expect(proposal.kind).toBe('voluntary-leave');
      expect(proposal.proposalId).toBe('prop-1');
      expect(proposal.epoch).toBe(1);
      expect(proposal.memberId).toBe('node-1');
      expect(proposal.status).toBe('passed');
      expect(proposal.votes).toEqual([]);
    });
  });

  describe('castGovernanceVote', () => {
    const baseProposal = {
      proposalId: 'prop-1',
      epoch: 1,
      electorate: ['node-1', 'node-2', 'node-3'],
      candidateId: 'node-4',
      votes: [] as const,
      status: 'open' as const,
      kind: 'admission' as const,
    };

    it('accepts valid yes vote', () => {
      const proposal = castGovernanceVote(baseProposal, {
        voterId: 'node-1',
        epoch: 1,
        choice: 'yes',
      });
      expect(proposal.votes.length).toBe(1);
      expect(proposal.votes[0].choice).toBe('yes');
    });

    it('accepts valid no vote', () => {
      const proposal = castGovernanceVote(baseProposal, {
        voterId: 'node-1',
        epoch: 1,
        choice: 'no',
      });
      expect(proposal.votes[0].choice).toBe('no');
    });

    it('returns passed when threshold reached', () => {
      let proposal = baseProposal;
      proposal = castGovernanceVote(proposal, { voterId: 'node-1', epoch: 1, choice: 'yes' }) as typeof baseProposal;
      proposal = castGovernanceVote(proposal, { voterId: 'node-2', epoch: 1, choice: 'yes' }) as typeof baseProposal;
      expect(proposal.status).toBe('passed');
    });

    it('throws for wrong epoch', () => {
      expect(() => castGovernanceVote(baseProposal, { voterId: 'node-1', epoch: 2, choice: 'yes' })).toThrow(DomainError);
    });

    it('throws for already passed proposal', () => {
      const passedProposal = { ...baseProposal, status: 'passed' as const };
      expect(() => castGovernanceVote(passedProposal, { voterId: 'node-1', epoch: 1, choice: 'yes' })).toThrow(DomainError);
    });

    it('throws if candidate votes on own admission', () => {
      expect(() => castGovernanceVote(baseProposal, { voterId: 'node-4', epoch: 1, choice: 'yes' })).toThrow(DomainError);
    });

    it('throws if target votes on own eviction', () => {
      const evictionProposal = {
        proposalId: 'prop-1',
        epoch: 1,
        electorate: ['node-1', 'node-2', 'node-3'],
        targetId: 'node-2',
        votes: [] as const,
        status: 'open' as const,
        kind: 'eviction' as const,
      };
      expect(() => castGovernanceVote(evictionProposal, { voterId: 'node-2', epoch: 1, choice: 'yes' })).toThrow(DomainError);
    });

    it('throws for unauthorized voter', () => {
      expect(() => castGovernanceVote(baseProposal, { voterId: 'node-5', epoch: 1, choice: 'yes' })).toThrow(DomainError);
    });

    it('throws for duplicate vote', () => {
      let proposal = castGovernanceVote(baseProposal, { voterId: 'node-1', epoch: 1, choice: 'yes' });
      expect(() => castGovernanceVote(proposal, { voterId: 'node-1', epoch: 1, choice: 'no' })).toThrow(DomainError);
    });

    it('throws for invalid choice', () => {
      expect(() => castGovernanceVote(baseProposal, { voterId: 'node-1', epoch: 1, choice: 'maybe' as any })).toThrow(DomainError);
    });
  });

  describe('submitEvictionResponse', () => {
    const baseProposal = {
      proposalId: 'prop-1',
      epoch: 1,
      electorate: ['node-1', 'node-2', 'node-3'],
      targetId: 'node-2',
      votes: [] as const,
      status: 'open' as const,
      kind: 'eviction' as const,
    };

    it('accepts valid response from target', () => {
      const proposal = submitEvictionResponse(baseProposal, {
        memberId: 'node-2',
        epoch: 1,
        response: 'I object',
      });
      expect(proposal.response).toBe('I object');
    });

    it('throws for non-target member', () => {
      expect(() => submitEvictionResponse(baseProposal, { memberId: 'node-1', epoch: 1, response: 'test' })).toThrow(DomainError);
    });

    it('throws for duplicate response', () => {
      const withResponse = { ...baseProposal, response: 'existing' };
      expect(() => submitEvictionResponse(withResponse, { memberId: 'node-2', epoch: 1, response: 'another' })).toThrow(DomainError);
    });

    it('throws for empty response', () => {
      expect(() => submitEvictionResponse(baseProposal, { memberId: 'node-2', epoch: 1, response: '' })).toThrow(DomainError);
    });
  });

  describe('hasGovernancePassed', () => {
    it('returns true for passed proposal', () => {
      expect(hasGovernancePassed({ status: 'passed' } as any)).toBe(true);
    });

    it('returns false for open proposal', () => {
      expect(hasGovernancePassed({ status: 'open' } as any)).toBe(false);
    });
  });

  describe('requireVoteProposal', () => {
    it('returns proposal for admission', () => {
      const p = { kind: 'admission', status: 'open' } as any;
      expect(requireVoteProposal(p)).toBe(p);
    });

    it('returns proposal for eviction', () => {
      const p = { kind: 'eviction', status: 'open' } as any;
      expect(requireVoteProposal(p)).toBe(p);
    });

    it('throws for voluntary leave', () => {
      const p = { kind: 'voluntary-leave', status: 'passed' } as any;
      expect(() => requireVoteProposal(p)).toThrow(DomainError);
    });
  });
});