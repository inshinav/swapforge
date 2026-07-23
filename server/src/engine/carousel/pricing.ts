// Смета карусели и идеации (SPEC §7): forecast-токены × litellm-цена → totalUsd.
// Кредитную цену из totalUsd делает ТОЛЬКО frozen priceCredits() (billing/credits.ts) —
// здесь никакой маржи нет.
import { forecastTokens, priceForCached, taskModel, type UsageTask } from '../../pricing';
import { CAROUSEL_TASKS } from '../../../../shared/carousel';

export interface QuoteRowUsd {
  task: UsageTask;
  count: number;
  model: string;
  usdEach: number | null;
}

export interface CarouselQuoteUsd {
  /** null = нет тарифа хотя бы одной задачи (смета временно недоступна). */
  totalUsd: number | null;
  rows: QuoteRowUsd[];
  /** true, пока прогноз хотя бы одной задачи держится на сид-эмпирике, а не истории. */
  approximate: boolean;
}

function rowFor(task: UsageTask, count: number): { row: QuoteRowUsd; seedBasis: boolean } {
  const f = forecastTokens(task);
  const model = taskModel(task);
  const price = priceForCached(model);
  const usdEach = price ? (f.tokensIn * price.inPerM + f.tokensOut * price.outPerM) / 1e6 : null;
  return { row: { task, count, model, usdEach }, seedBasis: f.basis === 'seed' };
}

function totalOf(rows: Array<{ row: QuoteRowUsd; seedBasis: boolean }>): CarouselQuoteUsd {
  let total: number | null = 0;
  let approximate = false;
  for (const { row, seedBasis } of rows) {
    if (seedBasis) approximate = true;
    if (row.usdEach === null || total === null) total = null;
    else total += row.usdEach * row.count;
  }
  return { totalUsd: total === null ? null : Math.round(total * 1e4) / 1e4, rows: rows.map((r) => r.row), approximate };
}

/** Смета генерации: слайды + QC каждого + подпись (SPEC §7). */
export function buildCarouselQuote(slideCount: number): CarouselQuoteUsd {
  return totalOf([
    rowFor(CAROUSEL_TASKS.slide, slideCount),
    rowFor(CAROUSEL_TASKS.qc, slideCount),
    rowFor(CAROUSEL_TASKS.caption, 1),
  ]);
}

/** Смета одиночного идеационного вызова (микро-hold). */
export function buildIdeationQuote(
  task:
    | typeof CAROUSEL_TASKS.idea
    | typeof CAROUSEL_TASKS.storyboard
    | typeof CAROUSEL_TASKS.caption
    | typeof CAROUSEL_TASKS.discover,
): CarouselQuoteUsd {
  return totalOf([rowFor(task, 1)]);
}
