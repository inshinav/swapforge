import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { confirmPaidAction } from './paid-actions';

const base = {
  kind: 'balance' as const,
  quoteId: 'quote-1',
  action: 'retry' as const,
  expiresAt: '2026-07-21 12:00:00',
  refFingerprint: 'refs',
  stages: ['render' as const],
  priceUsd: 5,
  balanceUsd: 10,
  approximate: false,
  warnings: [],
};

afterEach(() => vi.restoreAllMocks());

describe('paid action confirmation', () => {
  it('returns the exact quote only after explicit confirmation', async () => {
    vi.spyOn(api, 'actionQuote').mockResolvedValue(base);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await expect(
      confirmPaidAction({ projectId: 'p', action: 'retry', version: 1, sourceGenerationId: 'g' }),
    ).resolves.toBe('quote-1');
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('$5.00'));
  });

  it('does not launch after cancel or with insufficient balance', async () => {
    vi.spyOn(api, 'actionQuote').mockResolvedValue(base);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await expect(confirmPaidAction({ projectId: 'p', action: 'retry', version: 1 })).resolves.toBeNull();

    vi.spyOn(api, 'actionQuote').mockResolvedValue({ ...base, balanceUsd: 1 });
    await expect(confirmPaidAction({ projectId: 'p', action: 'retry', version: 1 })).rejects.toThrow(
      /Нужно \$5.00/,
    );
  });

  it('skips confirmation for the unmetered owner', async () => {
    vi.spyOn(api, 'actionQuote').mockResolvedValue({ ...base, quoteId: null, priceUsd: 0 });
    const confirm = vi.spyOn(window, 'confirm');
    await expect(confirmPaidAction({ projectId: 'p', action: 'rerun', version: 1 })).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });
});
