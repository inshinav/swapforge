// Пакеты кредитов: конфиг в env SWAPFORGE_PACKS_JSON (правит Alex, без деплоя кода).
// Server-initiated модель: сервер сам создаёт инвойс у провайдера и кладёт packId
// в payload/UTM → маппинг платёж→пакт прямой по id, без угадывания по сумме.
// Формат пакета:
//   { "id":"start", "title":"Старт", "credits":300, "priceLabel":"≈3 USDT / 299 ₽",
//     "cryptoAsset":"USDT", "cryptoAmount":3,            // Crypto Pay
//     "lavaOfferId":"836b9fc5-…", "lavaCurrency":"RUB" } // Lava.top offer
import { config } from '../config';

export interface CreditPack {
  id: string;
  title: string;
  credits: number;
  /** Человеческая цена («≈3 USDT / 299 ₽») — показывается юзеру. */
  priceLabel: string;
  /** Crypto Pay: актив и сумма (currency_type=crypto). */
  cryptoAsset?: string;
  cryptoAmount?: number;
  /** Lava.top: id оффера (цены) и валюта инвойса. */
  lavaOfferId?: string;
  lavaCurrency?: string;
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
      cryptoAsset: typeof r.cryptoAsset === 'string' ? r.cryptoAsset.toUpperCase() : undefined,
      cryptoAmount: typeof r.cryptoAmount === 'number' && r.cryptoAmount > 0 ? r.cryptoAmount : undefined,
      lavaOfferId: typeof r.lavaOfferId === 'string' ? r.lavaOfferId : undefined,
      lavaCurrency: typeof r.lavaCurrency === 'string' ? r.lavaCurrency.toUpperCase() : undefined,
    });
  }
  return out;
}

export function listPacks(): CreditPack[] {
  if (cache === null) cache = parsePacks(config.packsJson);
  return cache;
}

export function getPack(id: string): CreditPack | undefined {
  return listPacks().find((p) => p.id === id);
}

/** Тестовый рычаг. */
export function _resetPacksCache(): void {
  cache = null;
}
