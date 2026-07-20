import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import Billing from './Billing';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Billing polling', () => {
  it('loads at most four resources and makes no requests while idle', async () => {
    vi.useFakeTimers();
    const balance = vi.spyOn(api, 'billingBalance').mockResolvedValue({
      balanceUsd: 0,
      heldUsd: 0,
      availableUsd: 0,
    });
    const ledger = vi.spyOn(api, 'billingLedger').mockResolvedValue({ entries: [] });
    const methods = vi.spyOn(api, 'billingMethods').mockResolvedValue({
      minTopupUsd: 5,
      maxTopupUsd: 1_000,
      providers: [],
    });
    const intents = vi.spyOn(api, 'billingPaymentIntents').mockResolvedValue({ intents: [] });
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(
        <Billing
          userId="test-user"
          neededUsd={null}
          onBackToSwap={() => undefined}
          onBalanceChange={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(balance).toHaveBeenCalledOnce();
    expect(ledger).toHaveBeenCalledOnce();
    expect(methods).toHaveBeenCalledOnce();
    expect(intents).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(balance).toHaveBeenCalledOnce();
    expect(intents).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
  });
});
