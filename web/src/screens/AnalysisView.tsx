import { useState } from 'react';
import type { ProjectFull } from '@shared/api-types';
import { ARTIFACTS, type ArtifactType } from '@shared/taxonomy';
import { api } from '../api';
import { Button, Card, copyText, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

export const prefs = {
  get lang(): 'en' | 'ru' {
    return localStorage.getItem('sf-lang') === 'ru' ? 'ru' : 'en';
  },
  set lang(v: 'en' | 'ru') {
    localStorage.setItem('sf-lang', v);
  },
};

const RISK_TONE: Record<ArtifactType, 'danger' | 'warn'> = {
  identity_bleed: 'danger',
  cross_wiring: 'danger',
  world_drift: 'warn',
  temporal_drift: 'warn',
  pasted_on: 'warn',
};

export function AnalysisView({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const a = proj.analysis;
  const canAnalyze = proj.frames.length > 0 && !['storyboarding', 'analyzing', 'generating'].includes(proj.status);

  if (proj.frames.length === 0 && !a) return null;

  const analyze = async () => {
    setErr(null);
    try {
      await api.analyze(proj.id);
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Card glow={!!a}>
      <SectionTitle
        step="3"
        title="Анализ"
        hint="мир, сцены, субъекты и карта рисков артефактов"
        right={
          a &&
          canAnalyze && (
            <Button kind="ghost" onClick={() => void analyze()} className="!py-1 !px-2.5 text-xs">
              переанализировать
            </Button>
          )
        }
      />
      <div className="p-5">
        {proj.status === 'analyzing' && (
          <div className="flex items-center gap-3 text-sm text-mut py-8 justify-center">
            <Spinner /> Смотрю кадры, разбираю мир и движения, строю карту рисков… ~30–90 с
          </div>
        )}
        {!a && proj.status !== 'analyzing' && (
          <div className="text-center py-8">
            <Button kind="primary" onClick={() => void analyze()} disabled={!canAnalyze}>
              Проанализировать ролик
            </Button>
            <div className="text-xs text-dim mt-3">
              сервис сам подберёт оптимальную модель под задачу (с авто-фолбэком)
            </div>
          </div>
        )}
        {err && <div className="mb-4"><ErrorNote text={err} /></div>}
        {proj.error && proj.status === 'storyboarded' && (
          <div className="mb-4"><ErrorNote text={proj.error} onRetry={() => void analyze()} /></div>
        )}

        {a && (
          <div className="space-y-6 sf-in">
            {/* Мир */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-2">Мир</h3>
              <div className="flex flex-wrap gap-2 text-sm">
                <Tag tone="lime">{a.world.location}</Tag>
                <Tag>{a.world.timeOfDay}</Tag>
                <Tag>{a.world.light}</Tag>
                {a.world.weather && <Tag>{a.world.weather}</Tag>}
              </div>
              {(a.world.reflections.length > 0 ||
                a.world.background.length > 0 ||
                (a.world.overlayText ?? []).length > 0) && (
                <div className="mt-2 text-xs text-mut space-y-1">
                  {a.world.background.length > 0 && (
                    <div>Фон: {a.world.background.join(' · ')}</div>
                  )}
                  {a.world.reflections.length > 0 && (
                    <div className="text-warn/80">
                      Отражения (утечка identity): {a.world.reflections.join(' · ')}
                    </div>
                  )}
                  {(a.world.overlayText ?? []).length > 0 && (
                    <div>Оверлеи (галочка «Убрать текст» снимет): {(a.world.overlayText ?? []).join(' · ')}</div>
                  )}
                </div>
              )}
            </div>

            {/* Сцены */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-2">
                Сцены · {a.storyboard.length}
              </h3>
              <div className="space-y-1.5">
                {a.storyboard.map((s) => (
                  <div
                    key={s.index}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm rounded-lg bg-panel2 border border-line px-3 py-2"
                  >
                    <span className="font-mono text-xs text-lime shrink-0">
                      {s.startSec.toFixed(1)}–{s.endSec.toFixed(1)}с
                    </span>
                    <span className="text-ink/90">{s.action}</span>
                    <span className="text-mut text-xs">{s.camera} · {s.framing}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Субъекты */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-2">
                Субъекты для замены
              </h3>
              <div className="grid sm:grid-cols-2 gap-2">
                {a.subjects.map((s, i) => (
                  <div key={i} className="rounded-lg bg-panel2 border border-line px-3 py-2 text-sm">
                    <div className="font-semibold">
                      {s.kind} <span className="text-xs text-dim font-normal">· {s.prominence}</span>
                    </div>
                    <div className="text-mut text-xs mt-1">{s.description}</div>
                    <div className="text-xs mt-1">
                      <span className="text-dim">поза:</span> {s.pose}
                    </div>
                    {s.contact.length > 0 && (
                      <div className="text-xs">
                        <span className="text-dim">контакт:</span> {s.contact.join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Карта рисков — wow */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-dim mb-2">
                Карта рисков артефактов · {a.risks.length}
              </h3>
              <div className="space-y-2">
                {a.risks.map((r, i) => (
                  <div key={i} className="rounded-xl border border-line bg-panel2 p-3">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <Tag tone={RISK_TONE[r.artifactType]}>
                        {ARTIFACTS[r.artifactType].ru.split(' — ')[0]}
                      </Tag>
                      <span className="text-sm font-semibold">{r.moment}</span>
                    </div>
                    <div className="text-xs text-mut mb-2">{r.why}</div>
                    <button
                      type="button"
                      title="Кликни — скопировать строку"
                      onClick={() => void copyText(r.suppressorLine)}
                      className="w-full text-left font-mono text-[12px] leading-relaxed text-lime/90 bg-black/30 border border-lime/15 rounded-lg px-2.5 py-1.5 hover:border-lime/40 transition-colors"
                    >
                      {r.suppressorLine}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Теги */}
            <div className="flex flex-wrap gap-1.5">
              {a.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </div>

            <GenerateBar proj={proj} reload={reload} />
          </div>
        )}
      </div>
    </Card>
  );
}

export function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; label: string }>;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line2 bg-panel2 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 rounded-md font-semibold transition-colors ${
            value === o.v ? 'bg-lime text-black' : 'text-mut hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GenerateBar({ proj, reload }: { proj: ProjectFull; reload: () => void }) {
  const [lang, setLang] = useState<'en' | 'ru'>(prefs.lang);
  const [err, setErr] = useState<string | null>(null);
  const busy = proj.status === 'generating';
  const hasPrompts = proj.prompts.length > 0;

  const go = async () => {
    setErr(null);
    prefs.lang = lang;
    try {
      await api.generate(proj.id, { lang });
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl border border-lime/25 bg-lime/5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-mut">Промт старт-кадра:</span>
          <Seg value={lang} onChange={setLang} options={[{ v: 'en', label: 'EN' }, { v: 'ru', label: 'RU' }]} />
        </div>
        <span className="text-xs text-dim">эндпоинт: Seedance 2.0 · модель подбирается автоматически</span>
        <div className="flex-1" />
        <Button kind="primary" onClick={() => void go()} busy={busy} disabled={proj.refs.length === 0}>
          {busy ? 'Куются промты…' : hasPrompts ? 'Перегенерировать промты' : '⚡ Сгенерировать промты'}
        </Button>
      </div>
      {proj.refs.length === 0 && (
        <div className="text-xs text-warn mt-2">Сначала добавь хотя бы один референс модели (шаг 2)</div>
      )}
      {err && <div className="mt-3"><ErrorNote text={err} /></div>}
      {proj.error && proj.status === 'analyzed' && (
        <div className="mt-3"><ErrorNote text={proj.error} /></div>
      )}
    </div>
  );
}
