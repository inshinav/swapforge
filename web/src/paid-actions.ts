import { api } from './api';

export type PaidProjectAction = 'rerun' | 'retry' | 'iterate';

const LABEL: Record<PaidProjectAction, string> = {
  rerun: 'Создать ещё один ролик',
  retry: 'Повторить рендер',
  iterate: 'Улучшить и создать заново',
};

/** Returns null when the user cancels, undefined for the unmetered owner. */
export async function confirmPaidAction(input: {
  projectId: string;
  action: PaidProjectAction;
  version: number;
  sourceGenerationId?: string;
}): Promise<string | null | undefined> {
  const quote = await api.actionQuote(input.projectId, {
    action: input.action,
    version: input.version,
    sourceGenerationId: input.sourceGenerationId,
  });
  if (!quote.quoteId) return undefined;
  if (quote.priceUsd === null) throw new Error('Точная цена временно недоступна — попробуй чуть позже');
  if (quote.balanceUsd < quote.priceUsd) {
    throw new Error(`Нужно $${quote.priceUsd.toFixed(2)}, на балансе $${quote.balanceUsd.toFixed(2)}`);
  }
  const accepted = window.confirm(
    `${LABEL[input.action]} за $${quote.priceUsd.toFixed(2)}?\nБаланс: $${quote.balanceUsd.toFixed(2)}`,
  );
  return accepted ? quote.quoteId : null;
}
