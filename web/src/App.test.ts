import { describe, expect, it } from 'vitest';
import { buildJourneyStatus, readOwnerViewMode, resolveView } from './App';

describe('onboarding completion', () => {
  it('does not return a user with a finished result to onboarding when balance is zero', () => {
    const status = buildJourneyStatus(
      { hasBalance: false, hasProject: true, hasReadyModel: true, hasResult: true },
      { balanceDeferred: false, guideSeen: false, skipped: false },
    );
    expect(status.current).toBe('done');
  });
});

describe('owner cabinet modes', () => {
  it('defaults to admin and restores the private user preview preference', () => {
    expect(readOwnerViewMode({ getItem: () => null })).toBe('admin');
    expect(readOwnerViewMode({ getItem: () => 'user' })).toBe('user');
    expect(readOwnerViewMode({ getItem: () => 'unexpected' })).toBe('admin');
  });

  it('keeps admin private while allowing the owner to open ordinary billing', () => {
    expect(resolveView('admin', false, 'user')).toBe('swap');
    expect(resolveView('admin', true, 'user')).toBe('swap');
    expect(resolveView('billing', true, 'user')).toBe('billing');
    expect(resolveView('billing', true, 'admin')).toBe('admin');
    expect(resolveView('admin', true, 'admin')).toBe('admin');
  });
});

describe('carousel studio gating', () => {
  it('без флага #carousel не резолвится (в т.ч. по умолчанию), с флагом — открывается', () => {
    expect(resolveView('carousel', false, 'user')).toBe('swap');
    expect(resolveView('carousel', false, 'user', false)).toBe('swap');
    expect(resolveView('carousel', true, 'admin', false)).toBe('swap');
    expect(resolveView('carousel', false, 'user', true)).toBe('carousel');
    expect(resolveView('carousel', true, 'admin', true)).toBe('carousel');
  });

  it('флаг не ломает существующие виды', () => {
    expect(resolveView('swap', false, 'user', true)).toBe('swap');
    expect(resolveView('admin', false, 'user', true)).toBe('swap');
  });
});
