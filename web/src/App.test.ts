import { describe, expect, it } from 'vitest';
import { buildJourneyStatus } from './App';

describe('onboarding completion', () => {
  it('does not return a user with a finished result to onboarding when balance is zero', () => {
    const status = buildJourneyStatus(
      { hasBalance: false, hasProject: true, hasReadyModel: true, hasResult: true },
      { balanceDeferred: false, guideSeen: false, skipped: false },
    );
    expect(status.current).toBe('done');
  });
});
