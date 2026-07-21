import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import Admin from './Admin';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('owner provider balances', () => {
  it('shows local OpenAI spend, the exact billing link and WaveSpeed balance', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'adminOverview').mockResolvedValue({
      generatedAt: new Date().toISOString(),
      summary: {
        users: 0,
        totalBalanceUsd: 0,
        heldUsd: 0,
        activeRenders: 0,
        completedRenders: 0,
      },
      operations: {
        pendingPayments: 0,
        quarantinedPayments: 0,
        staleJobs: 0,
        stuckRenders: 0,
        staleHolds: 0,
        failedJobs24h: 0,
        diskUsedPct: 10,
        alerts: [],
      },
      users: [],
    });
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(
        <Admin
          pricing={{ balanceUsd: 12.34, litellmFetchedAt: null, wavespeedFetchedAt: null }}
          usage={{ month: '2026-07', openaiUsd: 1.23, wavespeedUsd: 4.56, totalUsd: 5.79, runs: 2 }}
        />,
      );
      await Promise.resolve();
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('OpenAI');
    expect(text).toContain('$1.23');
    expect(text).toContain('WaveSpeed');
    expect(text).toContain('$12.34');
    const balanceLink = document.querySelector<HTMLAnchorElement>('a[href*="billing/credit-grants"]');
    expect(balanceLink?.target).toBe('_blank');
    expect(balanceLink?.rel).toContain('noopener');

    await act(async () => root.unmount());
  });
});
