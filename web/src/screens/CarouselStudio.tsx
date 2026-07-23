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

function CreateCard({ onCreated, onOpenModels }: { onCreated: (id: string) => void; onOpenModels: () => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelId, setModelId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.models().then(setModels).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const model = models?.find((m) => m.id === modelId) ?? null;

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
      <SectionTitle step="1" title="Новая карусель" hint="фото-карусель для IG с твоей моделью" />
      <div className="p-4 space-y-3">
        {models !== null && models.length === 0 ? (
          <div className="space-y-2">
            <Empty icon="◇" title="Нет моделей" sub="Сначала создай модель с фото-листами" />
            <Button kind="primary" onClick={onOpenModels}>К моделям</Button>
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-sm">
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
              <label className="block text-sm">
                <span className="text-mut text-xs">Вариант (образ)</span>
                <select
                  className="mt-1 w-full rounded-lg border border-line2 bg-panel2 px-3 py-2"
                  value={variantId}
                  onChange={(e) => setVariantId(e.target.value)}
                  disabled={!model}
                >
                  <option value="">— выбери —</option>
                  {(model?.variants ?? []).map((v) => (
                    <option key={v.id} value={v.id}>{v.title}</option>
                  ))}
                </select>
              </label>
            </div>
            {error && <ErrorNote text={error} />}
            <Button kind="primary" busy={busy} disabled={!modelId || !variantId} onClick={() => void create()}>
              Создать карусель
            </Button>
          </>
        )}
      </div>
    </Card>
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

  const generate = () =>
    guarded(
      async () => {
        setBusy(true);
        try {
          setIdeas((await api.carouselIdeas(carousel.id, wish || undefined)).ideas);
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
          <SectionTitle title="Экспорт" hint="ZIP и отправка в Telegram появятся в следующем обновлении" />
          <div className="p-4 flex gap-2">
            <Button disabled title="Скоро">Скачать ZIP</Button>
            <Button disabled title="Скоро">В Telegram</Button>
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
