import { describe, expect, it } from 'vitest';
import {
  DomainError,
  admissionThreshold,
  evictionThreshold,
} from '@workspace/opennode-domain';

describe('OPS-01 workspace test runner', () => {
  it('imports workspace TS and applies the published N=1..20 threshold table', () => {
    for (let n = 1; n <= 20; n += 1) {
      const expectedAdmission = n === 1 ? 1 : Math.max(2, Math.ceil(n / 5));
      expect(admissionThreshold(n)).toBe(expectedAdmission);
      expect(evictionThreshold(n)).toBe(Math.ceil(n / 2));
    }

    expect(() => admissionThreshold(0)).toThrow(DomainError);
    expect(() => evictionThreshold(1.5)).toThrow(DomainError);
  });
});
