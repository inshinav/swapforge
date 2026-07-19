import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@shared/api-types';
import { api } from '../api';
import { Button, Empty, ErrorNote, Spinner, Tag } from '../ui';

const STATUS_RU: Record<string, string> = {
  uploaded: 'загружен',
  storyboarding: 'раскадровка…',
  storyboarded: 'раскадрован',
  analyzing: 'анализ…',
  analyzed: 'проанализирован',
  generating: 'генерация…',
  startframing: 'старт-кадр…',
  complete: 'промты готовы',
  error: 'ошибка',
};

export default function Library({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [onlyWorked, setOnlyWorked] = useState(false);

  const load = () => {
    api
      .projects()
      .then(setItems)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  if (err) return <ErrorNote text={err} onRetry={load} />;
  if (!items)
    return (
      <div className="flex justify-center py-24">
        <Spinner size={22} />
      </div>
    );

  const shown = onlyWorked ? items.filter((p) => p.worked === true) : items;

  return (
    <div className="sf-in">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4">
        <h1 className="font-bold text-lg">Библиотека</h1>
        <span className="text-xs text-dim">{items.length} проектов</span>
        <label className="w-full sm:w-auto sm:ml-auto flex items-center gap-2 text-xs text-mut cursor-pointer">
          <input
            type="checkbox"
            checked={onlyWorked}
            onChange={(e) => setOnlyWorked(e.target.checked)}
            className="accent-[#C6F24E]"
          />
          только сработавшие
        </label>
      </div>

      {shown.length === 0 ? (
        <Empty
          icon="🗂️"
          title={onlyWorked ? 'Пока нет сработавших свапов' : 'Библиотека пуста'}
          sub="Готовые работы появятся здесь"
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {shown.map((p) => (
            <LibCard key={p.id} p={p} onOpen={onOpen} onDeleted={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function LibCard({
  p,
  onOpen,
  onDeleted,
}: {
  p: ProjectSummary;
  onOpen: (id: string) => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const busy = ['storyboarding', 'analyzing', 'generating', 'startframing'].includes(p.status);

  return (
    <div className="rounded-xl border border-line bg-panel overflow-hidden group hover:border-line2 transition-colors">
      <button type="button" className="block w-full text-left" onClick={() => onOpen(p.id)}>
        <div className="relative aspect-[9/12] bg-panel2">
          {p.thumb ? (
            <img
              src={api.mediaUrl(p.id, 'frames', p.thumb)}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-2xl">🎬</div>
          )}
          <div className="absolute top-2 left-2 flex flex-col items-start gap-1">
            {p.latestRender && (
              <Tag tone="lime">
                ▶ рендер{p.latestRender.rating === 1 ? ' 👍' : p.latestRender.rating === -1 ? ' 👎' : ''}
              </Tag>
            )}
            {p.worked === true && <Tag tone="ok">✓ сработало</Tag>}
            {p.worked === false && <Tag tone="danger">артефакты</Tag>}
            {busy && <Tag tone="lime">{STATUS_RU[p.status]}</Tag>}
            {p.status === 'error' && <Tag tone="danger">ошибка</Tag>}
          </div>
          {p.videoPurged && (
            <div className="absolute bottom-2 left-2">
              <Tag>видео очищено</Tag>
            </div>
          )}
        </div>
        <div className="p-3">
          <div className="text-sm font-semibold truncate">{p.title}</div>
          <div className="text-[11px] text-dim mt-0.5">
            {new Date(p.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString('ru-RU', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {p.promptVersions > 0 && ` · ${p.promptVersions} верс.`}
          </div>
          {p.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {p.tags.slice(0, 4).map((t) => (
                <span key={t} className="text-[10px] text-mut border border-line rounded-full px-1.5 py-px">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>
      <div className="px-3 pb-3 flex gap-2">
        {confirming ? (
          <>
            <Button kind="danger" className="!py-1 !px-2 text-xs flex-1" onClick={() => void api.deleteProject(p.id).then(onDeleted)}>
              Удалить навсегда
            </Button>
            <Button kind="ghost" className="!py-1 !px-2 text-xs" onClick={() => setConfirming(false)}>
              Отмена
            </Button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="min-h-11 px-2 text-[11px] text-dim hover:text-danger transition-colors ml-auto opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          >
            удалить
          </button>
        )}
      </div>
    </div>
  );
}
