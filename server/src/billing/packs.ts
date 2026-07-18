// Пакеты кредитов: конфиг в env SWAPFORGE_PACKS_JSON (правит Alex, без деплоя кода).
// Формат: [{"id":"start","title":"Старт","credits":300,"priceLabel":"299 ₽",
//           "url":"https://t.me/tribute/app?startapp=…","tributeProductId":456}]
// Маппинг вебхука: по tributeProductId → по (amount,currency) → неопознанный платёж
// НЕ теряется молча (adjust-0 строка + громкий лог, Alex доначисляет руками).
import { config } from '../config';

export interface CreditPack {
  id: string;
  title: string;
  credits: number;
  /** Человеческая цена («299 ₽») — сервер цен в валюте не считает, их держит Tribute. */
  priceLabel: string;
  /** Платёжная ссылка Tribute (открывает Telegram). */
  url: string;
  tributeProductId: number | null;
  /** Для fallback-маппинга по сумме, минимальные единицы + валюта (опционально). */
  amountMinor?: number;
  currency?: string;
}

let cache: CreditPack[] | null = null;

export function parsePacks(json: string): CreditPack[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn('[packs] SWAPFORGE_PACKS_JSON не парсится — пакетов нет');
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: CreditPack[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (typeof r?.id !== 'string' || typeof r?.title !== 'string') continue;
    if (typeof r?.credits !== 'number' || r.credits <= 0) continue;
    out.push({
      id: r.id,
      title: r.title,
      credits: Math.round(r.credits),
      priceLabel: typeof r.priceLabel === 'string' ? r.priceLabel : '',
      url: typeof r.url === 'string' ? r.url : '',
      tributeProductId: typeof r.tributeProductId === 'number' ? r.tributeProductId : null,
      amountMinor: typeof r.amountMinor === 'number' ? r.amountMinor : undefined,
      currency: typeof r.currency === 'string' ? r.currency.toLowerCase() : undefined,
    });
  }
  return out;
}

export function listPacks(): CreditPack[] {
  if (cache === null) cache = parsePacks(config.packsJson);
  return cache;
}

/** Тестовый рычаг. */
export function _resetPacksCache(): void {
  cache = null;
}

export function matchPack(productId: number | null, amountMinor: number, currency: string): CreditPack | null {
  const packs = listPacks();
  if (productId !== null) {
    const byId = packs.find((p) => p.tributeProductId === productId);
    if (byId) return byId;
  }
  return (
    packs.find((p) => p.amountMinor === amountMinor && (p.currency ?? '') === currency.toLowerCase()) ?? null
  );
}
