// Carousel Studio (SPEC §9): список → визард (Модель → Идеи → Раскадровка → Генерация →
// Ревью/Результат). Поллинг — клон useProject (seq-guard); цены идеации прямо на кнопках;
// нехватка кредитов → onOpenBilling(shortfall). Экспорт/TG активируются в P6.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Button, Card, Empty, ErrorNote, SectionTitle, Spinner, Tag, copyText } from '../ui';
import type { ModelInfo } from '@shared/api-types';
import type {
  CarouselIdea,
  CarouselInfo,
  CarouselQuoteInfo,
  CollectionInfo,
  MiningTheme,
  PatternCardInfo,
  SlideInfo,
  Storyboard,
} from '@shared/carousel';

const BUSY_STATUSES = new Set(['generating']);

interface PackScene {
  id: string;
  name: string;
}

function useCarousel(id: string | null) {
  const [data, setData] = useState<{ carousel: CarouselInfo; queuePosition: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!id) return;
    const my = ++seq.current;
    try {
      const res = await api.carouselGet(id);
      if (my === seq.current) {
        setData(res);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!data || !BUSY_STATUSES.has(data.carousel.status)) return;
    const t = setInterval(() => void reload(), 2500);
    return () => clearInterval(t);
  }, [data, reload]);

  return { data, error, reload };
}

function priceLabel(usd: number | null | undefined): string {
  return usd == null || usd < 0 ? '…' : `≈$${usd.toFixed(2)}`;
}

const SLIDE_STATUS_RU: Record<SlideInfo['status'], { label: string; tone: 'mut' | 'lime' | 'warn' | 'danger' | 'ok' }> = {
  pending: { label: 'в очереди', tone: 'mut' },
  generating: { label: 'генерируется', tone: 'lime' },
  qc: { label: 'проверка', tone: 'lime' },
  done: { label: 'готов', tone: 'ok' },
  needs_review: { label: 'на ревью', tone: 'warn' },
  moderated: { label: 'модерация', tone: 'danger' },
  failed: { label: 'ошибка', tone: 'danger' },
};

export default function CarouselStudio({
  onOpenBilling,
  onOpenModels,
}: {
  onOpenBilling: (needed?: number) => void;
  onOpenModels: () => void;
}) {
  const [list, setList] = useState<CarouselInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      setList((await api.carouselList()).carousels);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  if (selectedId) {
    return (
      <CarouselWizard
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
          void loadList();
        }}
        onOpenBilling={onOpenBilling}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-4">
      <CreateCard
        onCreated={(id) => {
          setSelectedId(id);
        }}
        onOpenModels={onOpenModels}
      />
      <CollectionsCard />
      <Card>
        <SectionTitle title="Мои карусели" hint="последние 50" />
        <div className="p-4 space-y-2">
          {listError ? (
            <ErrorNote text={listError} onRetry={() => void loadList()} />
          ) : list === null ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : list.length === 0 ? (
            <Empty icon="▤" title="Пока пусто" sub="Создай первую карусель — выбери модель выше" />
          ) : (
            list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="w-full text-left rounded-xl border border-line bg-panel2 px-4 py-3 hover:border-lime/40 transition-colors flex items-center gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{c.title || c.idea?.title || 'Без названия'}</div>
                  <div className="text-xs text-mut">{c.slideCount} слайдов · {new Date(c.createdAt + 'Z').toLocaleDateString('ru-RU')}</div>
                </div>
                <CarouselStatusTag status={c.status} />
              </button>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}

/** «Подборки» (SPEC §3): майнинг вирусных референсов → структурные PatternCards. */
function CollectionsCard() {
  const [collections, setCollections] = useState<CollectionInfo[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ cards: PatternCardInfo[]; runStatus: string | null } | null>(null);
  const [name, setName] = useState('');
  const [usernames, setUsernames] = useState('');
  const [minePrice, setMinePrice] = useState<number | null>(null);
  const [busy, setBusy] = useState<'create' | 'mine' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      setCollections((await api.minerCollections()).collections);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (expanded) {
      void load();
      api.minerQuote().then((r) => setMinePrice(r.priceUsd)).catch(() => setMinePrice(null));
    }
  }, [expanded, load]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await api.minerGet(id);
      setDetail({ cards: res.cards, runStatus: res.runs[0]?.status ?? null });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    void loadDetail(openId);
  }, [loadDetail, openId]);

  // Поллинг статуса активного рана.
  useEffect(() => {
    if (!openId || !detail?.runStatus || !['queued', 'running', 'filtering', 'vision'].includes(detail.runStatus)) return;
    const t = setInterval(() => void loadDetail(openId), 3000);
    return () => clearInterval(t);
  }, [detail?.runStatus, loadDetail, openId]);

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      const list = usernames.split(/[,\s]+/).filter(Boolean);
      await api.minerCreate({ name, usernames: list });
      setName('');
      setUsernames('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const mine = async (id: string) => {
    setBusy('mine');
    setError(null);
    try {
      await api.minerMine(id);
      await loadDetail(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <SectionTitle
        title="Подборки"
        hint="вирусные референсы → структурные паттерны для идей"
        right={<Button onClick={() => setExpanded((v) => !v)}>{expanded ? 'Свернуть' : 'Открыть'}</Button>}
      />
      {expanded && (
        <div className="p-4 space-y-3">
          {error && <ErrorNote text={error} />}
          <AutoDiscovery
            onStarted={(id) => {
              void load();
              setOpenId(id);
            }}
          />
          <div className="text-xs text-mut">Или вручную — свои аккаунты-источники:</div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              className="flex-1 rounded-lg border border-line2 bg-panel2 px-3 py-2 text-sm"
              placeholder="Имя подборки"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="flex-1 rounded-lg border border-line2 bg-panel2 px-3 py-2 text-sm"
              placeholder="Аккаунты через запятую (@user1, @user2)"
              value={usernames}
              onChange={(e) => setUsernames(e.target.value)}
            />
            <Button kind="primary" busy={busy === 'create'} disabled={!name || !usernames} onClick={() => void create()}>
              Создать
            </Button>
          </div>
          {collections === null ? (
            <div className="flex justify-center py-4"><Spinner /></div>
          ) : collections.length === 0 ? (
            <Empty icon="◈" title="Подборок нет" sub="Собери первую: аккаунты-источники → виральные паттерны" />
          ) : (
            collections.map((c) => (
              <div key={c.id} className="rounded-xl border border-line bg-panel2">
                <button
                  type="button"
                  className="w-full text-left px-4 py-3 flex items-center gap-3"
                  onClick={() => setOpenId(openId === c.id ? null : c.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">{c.name}</div>
                    <div className="text-xs text-mut">{c.cardCount} карточек</div>
                  </div>
                  <Tag tone={c.cardCount > 0 ? 'lime' : 'mut'}>{openId === c.id ? '▴' : '▾'}</Tag>
                </button>
                {openId === c.id && (
                  <div className="px-4 pb-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Button
                        kind="primary"
                        busy={busy === 'mine'}
                        disabled={!!detail?.runStatus && ['queued', 'running', 'filtering', 'vision'].includes(detail.runStatus)}
                        onClick={() => void mine(c.id)}
                      >
                        Майнить · {priceLabel(minePrice)}
                      </Button>
                      {detail?.runStatus && ['queued', 'running', 'filtering', 'vision'].includes(detail.runStatus) && (
                        <Tag tone="lime">майнинг: {detail.runStatus}</Tag>
                      )}
                    </div>
                    {detail && detail.cards.length > 0 && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {detail.cards.map((card) => (
                          <PatternCardTile key={card.id} collectionId={c.id} card={card} onChanged={() => void loadDetail(c.id)} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
          <div className="text-xs text-mut">
            Майнер адаптирует структуру и идеи вирусных постов — изображения и подписи источников никогда не копируются.
          </div>
        </div>
      )}
    </Card>
  );
}

/** P9: автоподбор — кнопка → темы под модель → выбор → майнинг сам находит аккаунты. */
function AutoDiscovery({ onStarted }: { onStarted: (collectionId: string) => void }) {
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelId, setModelId] = useState('');
  const [prices, setPrices] = useState<{ priceUsd: number | null; themesUsd: number | null } | null>(null);
  const [themes, setThemes] = useState<MiningTheme[] | null>(null);
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<'themes' | 'mine' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .models()
      .then((ms) => {
        setModels(ms.map((m) => ({ id: m.id, name: m.name })));
        if (ms[0]) setModelId(ms[0].id);
      })
      .catch(() => setModels([]));
    api.minerQuote({ discovery: true }).then(setPrices).catch(() => setPrices(null));
  }, []);

  const suggest = async () => {
    setBusy('themes');
    setError(null);
    try {
      const res = await api.minerAutoStart(modelId || undefined);
      setThemes(res.themes);
      setCollectionId(res.collectionId);
      setPicked(new Set(res.themes.slice(0, 2).map((_, i) => i)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const mine = async () => {
    if (!collectionId || !themes) return;
    const hashtags = [...picked].flatMap((i) => themes[i]?.hashtags ?? []).slice(0, 6);
    setBusy('mine');
    setError(null);
    try {
      await api.minerMine(collectionId, hashtags);
      setThemes(null);
      setPicked(new Set());
      onStarted(collectionId);
      setCollectionId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-lime/25 bg-lime/5 p-3 space-y-2">
      <div className="text-sm font-semibold">Автоподбор под модель</div>
      <div className="text-xs text-mut">
        Одна кнопка: темы под твою модель → сам найду вирусные аккаунты по хэштегам → разберу в паттерны.
      </div>
      {error && <ErrorNote text={error} />}
      {!themes ? (
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            className="rounded-lg border border-line2 bg-panel2 px-3 py-2 text-sm"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
            {models.length === 0 && <option value="">без модели</option>}
          </select>
          <Button kind="primary" busy={busy === 'themes'} onClick={() => void suggest()}>
            Предложить темы · {priceLabel(prices?.themesUsd)}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {themes.map((t, i) => (
              <button
                key={i}
                type="button"
                onClick={() =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else if (next.size < 3) next.add(i);
                    return next;
                  })
                }
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  picked.has(i) ? 'border-lime/60 text-lime bg-lime/10' : 'border-line2 text-mut hover:border-lime/40'
                }`}
                title={t.hashtags.map((h) => `#${h}`).join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button kind="primary" busy={busy === 'mine'} disabled={picked.size === 0} onClick={() => void mine()}>
              Найти вирусное · {priceLabel(prices?.priceUsd)}
            </Button>
            <span className="text-xs text-mut">до 3 тем · {[...picked].flatMap((i) => themes[i]?.hashtags ?? []).slice(0, 6).map((h) => `#${h}`).join(' ')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function PatternCardTile({
  collectionId,
  card,
  onChanged,
}: {
  collectionId: string;
  card: PatternCardInfo;
  onChanged: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel overflow-hidden">
      <div className="aspect-square bg-bg">
        {card.thumbFile ? (
          <img src={api.minerThumbUrl(collectionId, card.thumbFile)} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-dim">◈</div>
        )}
      </div>
      <div className="p-2 space-y-1">
        <div className="text-[11px] text-mut truncate">
          @{card.author} · ER {(card.virality.er * 100).toFixed(1)}%
        </div>
        <div className="text-[11px] truncate" title={card.structure.hookType}>{card.structure.hookType}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`text-xs px-1.5 py-0.5 rounded border ${card.liked ? 'border-lime/40 text-lime' : 'border-line2 text-mut'}`}
            onClick={() => void api.minerCardPatch(card.id, { liked: !card.liked }).then(onChanged)}
          >
            ♥
          </button>
          <a
            className="text-[11px] text-mut hover:text-lime truncate"
            href={card.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            источник ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function CarouselStatusTag({ status }: { status: CarouselInfo['status'] }) {
  const map: Record<CarouselInfo['status'], { label: string; tone: 'mut' | 'lime' | 'warn' | 'danger' | 'ok' }> = {
    draft: { label: 'черновик', tone: 'mut' },
    storyboard: { label: 'раскадровка', tone: 'lime' },
    generating: { label: 'генерируется', tone: 'lime' },
    qc_review: { label: 'ревью', tone: 'warn' },
    done: { label: 'готова', tone: 'ok' },
    failed: { label: 'ошибка', tone: 'danger' },
  };
  const m = map[status];
  return <Tag tone={m.tone}>{m.label}</Tag>;
}

/** Превью-лист лука (варианта): первый model-role реф этого варианта, иначе shared. */
function lookThumb(model: ModelInfo, variantId: string): string | null {
  const own = model.refs.find((r) => r.role === 'model' && r.variantId === variantId);
  const shared = model.refs.find((r) => r.role === 'model' && r.variantId === null);
  return own?.file ?? shared?.file ?? null;
}

function CreateCard({ onCreated, onOpenModels }: { onCreated: (id: string) => void; onOpenModels: () => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadModels = useCallback(async () => {
    const ms = await api.models();
    setModels(ms);
    return ms;
  }, []);

  useEffect(() => {
    void reloadModels().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [reloadModels]);

  const model = models?.find((m) => m.id === modelId) ?? null;
  // Луки = варианты модели с готовым identity-листом (role=model).
  const looks = (model?.variants ?? []).filter((v) => model && lookThumb(model, v.id) !== null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.carouselCreate({ modelId, variantId });
      onCreated(res.carousel.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card glow>
      <SectionTitle step="1" title="Новая карусель" hint="выбери модель и лук — образ со всех ракурсов" />
      <div className="p-4 space-y-3">
        {models !== null && models.length === 0 ? (
          <div className="space-y-2">
            <Empty icon="◇" title="Нет моделей" sub="Сначала создай модель с фото-листами" />
            <Button kind="primary" onClick={onOpenModels}>К моделям</Button>
          </div>
        ) : (
          <>
            <label className="block text-sm max-w-xs">
              <span className="text-mut text-xs">Модель</span>
              <select
                className="mt-1 w-full rounded-lg border border-line2 bg-panel2 px-3 py-2"
                value={modelId}
                onChange={(e) => {
                  setModelId(e.target.value);
                  setVariantId('');
                }}
              >
                <option value="">— выбери —</option>
                {(models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
            {model && (
              <div className="space-y-2">
                <div className="text-xs text-mut">Лук — образ и лицо берутся с выбранного листа:</div>
                <LookGallery
                  model={model}
                  looks={looks}
                  selected={variantId}
                  onSelect={setVariantId}
                  onAdded={async (newVariantId) => {
                    await reloadModels();
                    setVariantId(newVariantId);
                  }}
                  onError={setError}
                />
              </div>
            )}
            {error && <ErrorNote text={error} />}
            <div className="flex flex-wrap items-center gap-3">
              <Button kind="primary" busy={busy} disabled={!modelId || !variantId} onClick={() => void create()}>
                Создать карусель
              </Button>
              <span className="text-xs text-mut">
                пропсы (мотоцикл, шлем…) и уточнение лука — следующим шагом
              </span>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** Наглядная галерея луков (вариантов) с превью-листами + добавление своих (P10). */
function LookGallery({
  model,
  looks,
  selected,
  onSelect,
  onAdded,
  onError,
}: {
  model: ModelInfo;
  looks: Array<{ id: string; title: string }>;
  selected: string;
  onSelect: (variantId: string) => void;
  onAdded: (variantId: string) => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!newName.trim() || !file) return;
    setBusy(true);
    onError(null);
    try {
      const { id: variantId } = await api.addModelVariant(model.id, newName.trim());
      await api.addModelRef(model.id, file, 'model', variantId, '');
      await onAdded(variantId);
      setAdding(false);
      setNewName('');
      setFile(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {looks.map((v) => {
        const thumb = lookThumb(model, v.id);
        const on = selected === v.id;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v.id)}
            className={`group relative rounded-xl overflow-hidden border-2 transition-colors ${
              on ? 'border-lime' : 'border-line hover:border-lime/40'
            }`}
          >
            <div className="aspect-[3/4] bg-bg">
              {thumb && (
                <img src={api.modelFileUrl(model.id, thumb)} alt={v.title} className="w-full h-full object-cover" />
              )}
            </div>
            <div className={`px-1.5 py-1 text-[11px] font-semibold truncate ${on ? 'text-lime bg-lime/10' : 'text-mut'}`}>
              {v.title}
            </div>
            {on && (
              <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-lime text-black text-xs flex items-center justify-center">
                ✓
              </div>
            )}
          </button>
        );
      })}
      {adding ? (
        <div className="col-span-3 sm:col-span-4 rounded-xl border border-line2 bg-panel2 p-3 space-y-2">
          <div className="text-sm font-semibold">Новый лук</div>
          <input
            className="w-full rounded-lg border border-line2 bg-panel px-3 py-2 text-sm"
            placeholder="Название лука: «спорт half-zip оранжевые»"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 rounded-lg border border-line2 bg-panel px-3 py-2 text-sm cursor-pointer hover:border-lime/50">
              {file ? file.name.slice(0, 24) : 'Выбрать лист (фото со всех ракурсов)'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          <div className="text-[11px] text-mut">
            Лучше всего — character sheet: лицо крупным планом + фигура спереди/сбоку/сзади на одном листе.
          </div>
          <div className="flex gap-2">
            <Button kind="primary" busy={busy} disabled={!newName.trim() || !file} onClick={() => void submit()}>
              Сохранить лук
            </Button>
            <Button onClick={() => setAdding(false)}>Отмена</Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-xl border border-dashed border-line2 aspect-[3/4] flex flex-col items-center justify-center gap-1 text-mut hover:border-lime/50 hover:text-lime text-xs"
        >
          <span className="text-2xl leading-none">+</span>
          Новый лук
        </button>
      )}
    </div>
  );
}

function CarouselWizard({
  id,
  onBack,
  onOpenBilling,
}: {
  id: string;
  onBack: () => void;
  onOpenBilling: (needed?: number) => void;
}) {
  const { data, error, reload } = useCarousel(id);
  const [prices, setPrices] = useState<{ ideasUsd: number | null; storyboardUsd: number | null; captionUsd: number | null } | null>(null);
  const [scenes, setScenes] = useState<PackScene[]>([]);

  useEffect(() => {
    api.carouselIdeationPrices().then(setPrices).catch(() => setPrices(null));
    api
      .carouselPacks()
      .then((r) => setScenes(r.packs[0]?.scenes ?? []))
      .catch(() => setScenes([]));
  }, []);

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <ErrorNote text={error} onRetry={() => void reload()} />
      </div>
    );
  }
  if (!data) {
    return <div className="flex justify-center py-24"><Spinner /></div>;
  }
  const c = data.carousel;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 space-y-4">
      <div className="flex items-center gap-3">
        <Button onClick={onBack}>← Мои карусели</Button>
        <CarouselStatusTag status={c.status} />
        {c.status === 'generating' && data.queuePosition > 0 && (
          <span className="text-xs text-mut">в очереди: {data.queuePosition}</span>
        )}
      </div>

      {(c.status === 'draft' || c.status === 'storyboard') && (
        <LookStep carousel={c} onChanged={() => void reload()} />
      )}
      {(c.status === 'draft' || c.status === 'storyboard') && (
        <IdeaStep carousel={c} prices={prices} onChanged={() => void reload()} onOpenBilling={onOpenBilling} />
      )}
      {(c.status === 'draft' || c.status === 'storyboard') && c.idea && (
        <StoryboardStep
          carousel={c}
          scenes={scenes}
          prices={prices}
          onChanged={() => void reload()}
          onOpenBilling={onOpenBilling}
        />
      )}
      {(c.status === 'generating' || c.status === 'qc_review' || c.status === 'done' || c.status === 'failed') && (
        <ProgressAndResult carousel={c} prices={prices} onChanged={() => void reload()} onOpenBilling={onOpenBilling} />
      )}
    </div>
  );
}

/** P8: лук (описание + фото) и пропсы (мотоцикл/шлем — свои или из модели). */
function LookStep({ carousel, onChanged }: { carousel: CarouselInfo; onChanged: () => void }) {
  const [note, setNote] = useState(carousel.lookNote);
  const [noteBusy, setNoteBusy] = useState(false);
  const [upBusy, setUpBusy] = useState<'look' | 'prop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modelRefs, setModelRefs] = useState<Array<{ id: string; file: string; note: string; role: string }>>([]);

  useEffect(() => setNote(carousel.lookNote), [carousel.lookNote]);

  useEffect(() => {
    if (!carousel.modelId) return;
    api
      .models()
      .then((models) => {
        const m = models.find((x) => x.id === carousel.modelId);
        setModelRefs((m?.refs ?? []).filter((r) => r.role !== 'model').map((r) => ({ id: r.id, file: r.file, note: r.note, role: r.role })));
      })
      .catch(() => setModelRefs([]));
  }, [carousel.modelId]);

  const saveNote = async () => {
    setNoteBusy(true);
    setError(null);
    try {
      await api.carouselLookSave(carousel.id, note);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNoteBusy(false);
    }
  };

  const upload = async (kind: 'look' | 'prop', file: File | undefined) => {
    if (!file) return;
    setUpBusy(kind);
    setError(null);
    try {
      await api.carouselRefUpload(carousel.id, file, kind, '');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUpBusy(null);
    }
  };

  const addFromModel = async (modelRefId: string) => {
    setError(null);
    try {
      await api.carouselRefFromModel(carousel.id, modelRefId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const looks = carousel.refs.filter((r) => r.kind === 'look');
  const props = carousel.refs.filter((r) => r.kind === 'prop');

  return (
    <Card>
      <SectionTitle
        step="1a"
        title="Уточнить образ и пропсы"
        hint="основной лук — с выбранного листа; тут можно добавить деталь и что в кадре"
      />
      <div className="p-4 space-y-3">
        {error && <ErrorNote text={error} />}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="flex-1 rounded-lg border border-line2 bg-panel2 px-3 py-2 text-sm"
            placeholder="Лук словами: «белое льняное платье, распущенные волосы, золотая цепочка»"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button busy={noteBusy} disabled={note === carousel.lookNote} onClick={() => void saveNote()}>
            Сохранить лук
          </Button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-2">
            <div className="text-xs text-mut">Фото лука (одежда возьмётся с него) · {looks.length}/1</div>
            <div className="flex flex-wrap gap-2">
              {looks.map((r) => (
                <RefThumb key={r.id} carouselId={carousel.id} r={r} onDelete={() => void api.carouselRefDelete(carousel.id, r.id).then(onChanged)} />
              ))}
              {looks.length < 1 && (
                <UploadTile busy={upBusy === 'look'} onPick={(f) => void upload('look', f)} label="+ фото лука" />
              )}
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs text-mut">Пропсы в кадре: мотоцикл, шлем… · {props.length}/2</div>
            <div className="flex flex-wrap gap-2">
              {props.map((r) => (
                <RefThumb key={r.id} carouselId={carousel.id} r={r} onDelete={() => void api.carouselRefDelete(carousel.id, r.id).then(onChanged)} />
              ))}
              {props.length < 2 && (
                <UploadTile busy={upBusy === 'prop'} onPick={(f) => void upload('prop', f)} label="+ свой пропс" />
              )}
            </div>
            {modelRefs.length > 0 && props.length < 2 && (
              <div className="flex flex-wrap gap-1.5">
                {modelRefs.map((r) => (
                  <Button key={r.id} className="!min-h-8 !px-2 !py-1 text-xs" onClick={() => void addFromModel(r.id)}>
                    + {r.note ? r.note.slice(0, 24) : r.role === 'vehicle' ? 'техника модели' : 'объект модели'}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function RefThumb({
  carouselId,
  r,
  onDelete,
}: {
  carouselId: string;
  r: CarouselInfo['refs'][number];
  onDelete: () => void;
}) {
  return (
    <div className="relative w-20">
      <img
        src={api.carouselRefUrl(carouselId, r.file)}
        alt={r.note || r.kind}
        className="w-20 h-24 object-cover rounded-lg border border-line"
      />
      <button
        type="button"
        aria-label="Убрать"
        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-panel border border-line text-mut text-xs leading-none hover:text-danger"
        onClick={onDelete}
      >
        ×
      </button>
    </div>
  );
}

function UploadTile({
  busy,
  label,
  onPick,
}: {
  busy: boolean;
  label: string;
  onPick: (f: File | undefined) => void;
}) {
  return (
    <label className="w-20 h-24 rounded-lg border border-dashed border-line2 flex items-center justify-center text-[11px] text-mut hover:border-lime/50 hover:text-lime cursor-pointer text-center px-1">
      {busy ? <Spinner size={14} /> : label}
      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => onPick(e.target.files?.[0])} />
    </label>
  );
}

/** Единый обработчик 402/409 идеационных вызовов. */
async function guarded(
  fn: () => Promise<void>,
  setError: (v: string | null) => void,
  onOpenBilling: (needed?: number) => void,
): Promise<void> {
  setError(null);
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 402) {
      const body = e.body as { shortfallUsd?: number } | undefined;
      onOpenBilling(body?.shortfallUsd);
      return;
    }
    setError(e instanceof Error ? e.message : String(e));
  }
}

function IdeaStep({
  carousel,
  prices,
  onChanged,
  onOpenBilling,
}: {
  carousel: CarouselInfo;
  prices: { ideasUsd: number | null } | null;
  onChanged: () => void;
  onOpenBilling: (needed?: number) => void;
}) {
  const [wish, setWish] = useState('');
  const [ideas, setIdeas] = useState<CarouselIdea[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickBusy, setPickBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [likedCards, setLikedCards] = useState<string[]>([]);
  const [usePatterns, setUsePatterns] = useState(true);

  // Лайкнутые PatternCards из всех подборок — few-shot для идей (до 5).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { collections } = await api.minerCollections();
        const ids: string[] = [];
        for (const c of collections) {
          if (ids.length >= 5) break;
          const { cards } = await api.minerGet(c.id);
          for (const card of cards) {
            if (card.liked && ids.length < 5) ids.push(card.id);
          }
        }
        if (!cancelled) setLikedCards(ids);
      } catch {
        /* подборки опциональны */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const generate = () =>
    guarded(
      async () => {
        setBusy(true);
        try {
          setIdeas(
            (
              await api.carouselIdeas(carousel.id, {
                wish: wish || undefined,
                patternCardIds: usePatterns && likedCards.length > 0 ? likedCards : undefined,
              })
            ).ideas,
          );
        } finally {
          setBusy(false);
        }
      },
      setError,
      onOpenBilling,
    );

  const pick = (idea: CarouselIdea, i: number) =>
    guarded(
      async () => {
        setPickBusy(i);
        try {
          await api.carouselPickIdea(carousel.id, idea);
          setIdeas(null);
          onChanged();
        } finally {
          setPickBusy(null);
        }
      },
      setError,
      onOpenBilling,
    );

  return (
    <Card>
      <SectionTitle
        step="2"
        title="Идея"
        hint={carousel.idea ? `выбрано: ${carousel.idea.title}` : 'что снимаем'}
      />
      <div className="p-4 space-y-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            className="flex-1 rounded-lg border border-line2 bg-panel2 px-3 py-2 text-sm"
            placeholder="Пожелание (необязательно): «утро на пляже», «спортзал»…"
            value={wish}
            onChange={(e) => setWish(e.target.value)}
          />
          <Button kind="primary" busy={busy} onClick={() => void generate()}>
            Идеи · {priceLabel(prices?.ideasUsd)}
          </Button>
        </div>
        {likedCards.length > 0 && (
          <label className="flex items-center gap-2 text-xs text-mut">
            <input type="checkbox" checked={usePatterns} onChange={(e) => setUsePatterns(e.target.checked)} />
            Использовать паттерны из подборок (♥ {likedCards.length}) — структура, не копирование
          </label>
        )}
        {error && <ErrorNote text={error} />}
        {ideas && (
          <div className="space-y-2">
            {ideas.map((idea, i) => (
              <div key={i} className="rounded-xl border border-line bg-panel2 p-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold">{idea.title}</div>
                  <Tag tone="mut">{idea.slideCount} слайдов · {idea.ugcPreset}</Tag>
                </div>
                <div className="text-sm text-lime">{idea.hook}</div>
                <div className="text-sm text-mut">{idea.concept}</div>
                <Button kind="ghost" busy={pickBusy === i} onClick={() => void pick(idea, i)}>
                  Взять эту
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function StoryboardStep({
  carousel,
  scenes,
  prices,
  onChanged,
  onOpenBilling,
}: {
  carousel: CarouselInfo;
  scenes: PackScene[];
  prices: { storyboardUsd: number | null } | null;
  onChanged: () => void;
  onOpenBilling: (needed?: number) => void;
}) {
  const [draft, setDraft] = useState<Storyboard | null>(carousel.storyboard);
  const [quote, setQuote] = useState<CarouselQuoteInfo | null>(null);
  const [busy, setBusy] = useState<'gen' | 'save' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(carousel.storyboard), [carousel.storyboard]);

  useEffect(() => {
    const n = draft?.slides.length ?? carousel.slideCount;
    api
      .carouselQuote(carousel.id, n)
      .then((r) => setQuote(r.quote))
      .catch(() => setQuote(null));
  }, [carousel.id, carousel.slideCount, draft?.slides.length]);

  const genStoryboard = () =>
    guarded(
      async () => {
        setBusy('gen');
        try {
          setDraft((await api.carouselStoryboardGen(carousel.id)).storyboard);
          onChanged();
        } finally {
          setBusy(null);
        }
      },
      setError,
      onOpenBilling,
    );

  const save = async (): Promise<boolean> => {
    if (!draft) return false;
    setBusy('save');
    try {
      setDraft((await api.carouselStoryboardSave(carousel.id, draft)).storyboard);
      onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const start = () =>
    guarded(
      async () => {
        if (!(await save())) return;
        setBusy('start');
        try {
          await api.carouselGenerate(carousel.id);
          onChanged();
        } finally {
          setBusy(null);
        }
      },
      setError,
      onOpenBilling,
    );

  const setSlide = (i: number, patch: Partial<Storyboard['slides'][number]>) => {
    if (!draft) return;
    const slides = draft.slides.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setDraft({ ...draft, slides });
  };

  return (
    <Card>
      <SectionTitle
        step="3"
        title="Раскадровка"
        hint="проверь сцены и действия — это уйдёт в промты"
        right={
          <Button busy={busy === 'gen'} onClick={() => void genStoryboard()}>
            {draft ? 'Пересобрать' : 'Собрать'} · {priceLabel(prices?.storyboardUsd)}
          </Button>
        }
      />
      <div className="p-4 space-y-3">
        {error && <ErrorNote text={error} />}
        {!draft ? (
          <div className="text-sm text-mut">Собери раскадровку по выбранной идее — потом можно править каждый слайд.</div>
        ) : (
          <>
            <div className="space-y-2">
              {draft.slides.map((s, i) => (
                <div key={i} className="rounded-xl border border-line bg-panel2 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <Tag tone={i === 0 ? 'lime' : 'mut'}>{i === 0 ? 'слайд 1 · якорь' : `слайд ${i + 1}`} · {s.role}</Tag>
                    {draft.slides.length > 2 && (
                      <Button
                        kind="danger"
                        onClick={() => setDraft({ ...draft, slides: draft.slides.filter((_, j) => j !== i) })}
                      >
                        Убрать
                      </Button>
                    )}
                  </div>
                  <div className="grid sm:grid-cols-2 gap-2 text-sm">
                    <label className="block">
                      <span className="text-mut text-xs">Сцена</span>
                      <select
                        className="mt-1 w-full rounded-lg border border-line2 bg-panel px-2 py-1.5"
                        value={s.sceneId}
                        onChange={(e) => setSlide(i, { sceneId: e.target.value })}
                      >
                        {scenes.map((sc) => (
                          <option key={sc.id} value={sc.id}>{sc.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-mut text-xs">Действие (EN)</span>
                      <input
                        className="mt-1 w-full rounded-lg border border-line2 bg-panel px-2 py-1.5"
                        value={s.action}
                        onChange={(e) => setSlide(i, { action: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="text-mut text-xs">Одежда (EN)</span>
                      <input
                        className="mt-1 w-full rounded-lg border border-line2 bg-panel px-2 py-1.5"
                        value={s.outfit}
                        onChange={(e) => setSlide(i, { outfit: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="text-mut text-xs">Камера (EN)</span>
                      <input
                        className="mt-1 w-full rounded-lg border border-line2 bg-panel px-2 py-1.5"
                        value={s.camera}
                        onChange={(e) => setSlide(i, { camera: e.target.value })}
                      />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="text-mut text-xs">Пропс в кадре (EN, пусто = без пропсов)</span>
                      <input
                        className="mt-1 w-full rounded-lg border border-line2 bg-panel px-2 py-1.5"
                        placeholder="sitting on her orange Kawasaki, helmet in hand"
                        value={s.propNote}
                        onChange={(e) => setSlide(i, { propNote: e.target.value, useProductRef: e.target.value.trim().length > 0 })}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {draft.slides.length < 10 && (
                <Button
                  onClick={() =>
                    setDraft({
                      ...draft,
                      slides: [
                        ...draft.slides,
                        { ...draft.slides[draft.slides.length - 1]!, idx: draft.slides.length + 1, role: 'context' },
                      ],
                    })
                  }
                >
                  + Слайд
                </Button>
              )}
              <Button busy={busy === 'save'} onClick={() => void save()}>
                Сохранить правки
              </Button>
              <div className="flex-1" />
              {quote && !quote.enough ? (
                <Button kind="primary" onClick={() => onOpenBilling(quote.shortfallUsd)}>
                  Пополнить на ${quote.shortfallUsd.toFixed(2)}
                </Button>
              ) : (
                <Button kind="primary" busy={busy === 'start'} onClick={() => void start()}>
                  Сгенерировать {draft.slides.length} слайдов · {quote ? priceLabel(quote.priceUsd) : '…'}
                </Button>
              )}
            </div>
            <div className="text-xs text-mut">
              Слайды идут по одному (якорь держит образ) — {draft.slides.length} слайдов ≈{' '}
              {Math.round(draft.slides.length * 2)}–{Math.round(draft.slides.length * 3)} мин. Уйти со страницы можно.
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function ProgressAndResult({
  carousel,
  prices,
  onChanged,
  onOpenBilling,
}: {
  carousel: CarouselInfo;
  prices: { captionUsd: number | null } | null;
  onChanged: () => void;
  onOpenBilling: (needed?: number) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busySlide, setBusySlide] = useState<string | null>(null);
  const [captionBusy, setCaptionBusy] = useState(false);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgNote, setTgNote] = useState<string | null>(null);

  const sendTg = async () => {
    setTgBusy(true);
    setTgNote(null);
    try {
      await api.carouselSendTg(carousel.id);
      setTgNote('Отправлено — проверь Telegram');
    } catch (e) {
      setTgNote(e instanceof Error ? e.message : String(e));
    } finally {
      setTgBusy(false);
    }
  };

  const act = (slideId: string, action: 'accept' | 'retry') =>
    guarded(
      async () => {
        setBusySlide(slideId);
        try {
          await fetchSlideAction(carousel.id, slideId, action);
          onChanged();
        } finally {
          setBusySlide(null);
        }
      },
      setError,
      onOpenBilling,
    );

  const regenCaption = () =>
    guarded(
      async () => {
        setCaptionBusy(true);
        try {
          await api.carouselCaption(carousel.id);
          onChanged();
        } finally {
          setCaptionBusy(false);
        }
      },
      setError,
      onOpenBilling,
    );

  const doneSlides = carousel.slides.filter((s) => s.status === 'done');

  return (
    <>
      <Card glow={carousel.status === 'generating'}>
        <SectionTitle
          step="4"
          title={
            carousel.status === 'generating'
              ? 'Генерация'
              : carousel.status === 'qc_review'
                ? 'Ревью слайдов'
                : carousel.status === 'failed'
                  ? 'Не получилось'
                  : 'Результат'
          }
          hint={
            carousel.status === 'qc_review' && carousel.reviewDeadline
              ? `окно ревью до ${new Date(carousel.reviewDeadline + 'Z').toLocaleString('ru-RU')}`
              : undefined
          }
        />
        <div className="p-4 space-y-3">
          {error && <ErrorNote text={error} />}
          {carousel.status === 'failed' && (
            <ErrorNote text={`${carousel.error ?? 'Ран не удался'}. Кредиты за неудачное не списываются.`} />
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {carousel.slides.map((s) => (
              <SlideCard
                key={s.id}
                carouselId={carousel.id}
                slide={s}
                inReview={carousel.status === 'qc_review'}
                busy={busySlide === s.id}
                onAccept={() => void act(s.id, 'accept')}
                onRetry={() => void act(s.id, 'retry')}
              />
            ))}
          </div>
        </div>
      </Card>

      {(carousel.status === 'done' || carousel.status === 'qc_review') && (
        <Card>
          <SectionTitle
            title="Подпись"
            right={
              <Button busy={captionBusy} onClick={() => void regenCaption()}>
                Пересобрать · {priceLabel(prices?.captionUsd)}
              </Button>
            }
          />
          <div className="p-4 space-y-2">
            {carousel.caption ? (
              <>
                <div className="text-sm text-lime">{carousel.caption.hookLine}</div>
                <pre className="whitespace-pre-wrap text-sm font-sans text-ink">{carousel.caption.caption}</pre>
                <div className="text-xs text-mut break-words">{carousel.caption.hashtags.join(' ')}</div>
                <Button
                  onClick={() =>
                    copyText(
                      `${carousel.caption!.caption}\n\n${carousel.caption!.hashtags.join(' ')}`,
                    )
                  }
                >
                  Скопировать подпись
                </Button>
              </>
            ) : (
              <div className="text-sm text-mut">Подписи пока нет — собери кнопкой выше.</div>
            )}
          </div>
        </Card>
      )}

      {carousel.status === 'done' && doneSlides.length > 0 && (
        <Card>
          <SectionTitle title="Экспорт" hint={`${doneSlides.length} готовых слайдов + подпись`} />
          <div className="p-4 flex flex-wrap items-center gap-2">
            <a
              className="inline-flex min-h-11 sm:min-h-0 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold bg-lime text-black hover:bg-lime-dim"
              href={api.carouselExportUrl(carousel.id)}
              download
            >
              Скачать ZIP
            </a>
            <Button busy={tgBusy} onClick={() => void sendTg()}>
              В Telegram
            </Button>
            {tgNote && <span className="text-xs text-mut">{tgNote}</span>}
          </div>
        </Card>
      )}
    </>
  );
}

async function fetchSlideAction(carouselId: string, slideId: string, action: 'accept' | 'retry'): Promise<void> {
  await api.carouselSlideAction(carouselId, slideId, action);
}

function SlideCard({
  carouselId,
  slide,
  inReview,
  busy,
  onAccept,
  onRetry,
}: {
  carouselId: string;
  slide: SlideInfo;
  inReview: boolean;
  busy: boolean;
  onAccept: () => void;
  onRetry: () => void;
}) {
  const st = SLIDE_STATUS_RU[slide.status];
  const file = slide.finalFile ?? slide.file;
  return (
    <div className="rounded-xl border border-line bg-panel2 overflow-hidden flex flex-col">
      <div className="aspect-[4/5] bg-bg flex items-center justify-center">
        {file ? (
          <img src={api.carouselFileUrl(carouselId, file)} alt={`Слайд ${slide.idx}`} className="w-full h-full object-cover" />
        ) : slide.status === 'generating' || slide.status === 'qc' ? (
          <Spinner />
        ) : (
          <span className="text-2xl text-dim">▤</span>
        )}
      </div>
      <div className="p-2 space-y-1.5">
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] text-mut">#{slide.idx}{slide.isAnchor ? ' · якорь' : ''}</span>
          <Tag tone={st.tone}>{st.label}</Tag>
        </div>
        {slide.qc && slide.status === 'needs_review' && (
          <div className="text-[11px] text-mut">id {slide.qc.identity}/10 · арт {slide.qc.artifacts}/10 · реал {slide.qc.realism}/10</div>
        )}
        {inReview && slide.status === 'needs_review' && (
          <div className="flex gap-1">
            <Button kind="primary" busy={busy} className="flex-1 !min-h-8 !px-2 !py-1 text-xs" onClick={onAccept}>
              Принять
            </Button>
            <Button
              busy={busy}
              disabled={slide.manualRetries >= 2}
              title={slide.manualRetries >= 2 ? 'Лимит ретраев (2)' : 'Бесплатный ретрай'}
              className="flex-1 !min-h-8 !px-2 !py-1 text-xs"
              onClick={onRetry}
            >
              Ретрай {slide.manualRetries}/2
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
