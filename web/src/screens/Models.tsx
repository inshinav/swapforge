// Конструктор моделей: персонаж → варианты образа (кнопки) → реф-листы с нотами.
// Качество кнопки = качество ноты: «Описать автоматически» даёт черновик по анатомии
// фирменных пресетов, юзер правит руками. Всё приватно, шаринга нет.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ModelRefInfo } from '@shared/api-types';
import { REF_ROLES, type RefRole } from '@shared/taxonomy';
import { api } from '../api';

const ROLE_OPTIONS = Object.entries(REF_ROLES) as Array<[RefRole, { ru: string; en: string }]>;
import { Button, Card, Empty, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

export default function Models() {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    api
      .models()
      .then(setModels)
      .catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(reload, [reload]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setErr('');
    try {
      const { id } = await api.createModel(name);
      await api.addModelVariant(id, 'базовый', '');
      setNewName('');
      reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4 sf-in">
      <Card glow>
        <SectionTitle
          title="Мои модели"
          hint="создай персонажа один раз — его кнопки появятся на экране свапа"
        />
        <div className="p-5 space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              placeholder="Имя модели — например MotoLola"
              className="flex-1 min-w-[220px] rounded-lg bg-panel2 border border-line px-3 py-2 text-sm outline-none focus:border-lime/50"
            />
            <Button kind="primary" busy={creating} disabled={!newName.trim()} onClick={() => void create()}>
              + Создать модель
            </Button>
          </div>
          {err && <ErrorNote text={err} />}
          <SheetTips />
        </div>
      </Card>

      {models === null ? (
        <div className="flex items-center gap-2 text-sm text-mut px-2">
          <Spinner size={14} /> загружаю модели…
        </div>
      ) : models.length === 0 ? (
        <Empty
          icon="✨"
          title="Моделей пока нет"
          sub="Создай первую: имя → реф-листы → кнопка на экране свапа готова"
        />
      ) : (
        models.map((m) => <ModelCard key={m.id} model={m} onChanged={reload} />)
      )}
    </div>
  );
}

/** Советы по листам — зеркало docs/prompting-logic §7, тем же паттерном, что в RefsSection. */
function SheetTips() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="text-xs text-dim hover:text-lime">
        {open ? '▾' : '▸'} какие листы дают лучший результат?
      </button>
      {open && (
        <ul className="mt-2 text-xs text-mut space-y-1 rounded-lg border border-line bg-panel2 px-3 py-2.5">
          <li>
            <b className="text-ink">Модель:</b> реф-лист «все ракурсы» лочит identity сильнее любых слов;
            минимум — чёткое фронтальное лицо при хорошем свете + фигура в полный рост в нужном аутфите.
          </li>
          <li>
            <b className="text-ink">Техника:</b> чистый вид 3/4 без людей в кадре; она подставится только
            если такая техника есть в исходнике — это уже прописано в автоописании.
          </li>
          <li>
            <b className="text-ink">Свет:</b> чем ближе свет и ракурс листа к будущим роликам — тем чище свап.
          </li>
          <li>
            <b className="text-ink">Нота:</b> «Описать автоматически» даёт черновик — проверь цвета и детали,
            ключевые дискриминаторы держи КАПСОМ («платиново-БЕЛЫЕ волосы», «ОДНА КОСА»).
          </li>
        </ul>
      )}
    </div>
  );
}

function ModelCard({ model, onChanged }: { model: ModelInfo; onChanged: () => void }) {
  const [sel, setSel] = useState<string | 'shared'>(model.variants[0]?.id ?? 'shared');
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [newVariant, setNewVariant] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    // выбранный вариант мог быть удалён — откатываемся на первый
    if (sel !== 'shared' && !model.variants.some((v) => v.id === sel)) {
      setSel(model.variants[0]?.id ?? 'shared');
    }
  }, [model.variants, sel]);

  const act = async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const refsShown = model.refs.filter((r) => (sel === 'shared' ? r.variantId === null : r.variantId === sel));

  const upload = async (file: File) => {
    setUploading(true);
    setErr('');
    setWarnings([]);
    try {
      const role = sel === 'shared' ? 'vehicle' : 'model';
      const res = await api.addModelRef(model.id, file, role, sel === 'shared' ? null : sel);
      setWarnings(res.warnings);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addVariant = () => {
    const title = newVariant.trim();
    if (!title) return;
    setNewVariant('');
    void act(() => api.addModelVariant(model.id, title));
  };

  return (
    <Card>
      <div className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <InlineName
            value={model.name}
            onSave={(name) => void act(() => api.renameModel(model.id, name))}
          />
          <Tag tone="mut">{model.variants.length} кнопк{plural(model.variants.length)}</Tag>
          <div className="flex-1" />
          {confirmDel ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-danger">удалить модель и все листы?</span>
              <Button kind="danger" className="!py-1 !px-2 text-xs" onClick={() => void act(() => api.deleteModel(model.id))}>
                да, удалить
              </Button>
              <Button kind="ghost" className="!py-1 !px-2 text-xs" onClick={() => setConfirmDel(false)}>
                отмена
              </Button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="text-xs text-dim hover:text-danger">
              удалить
            </button>
          )}
        </div>

        {/* Варианты (кнопки свапа) + общие рефы */}
        <div className="flex flex-wrap items-center gap-1.5">
          {model.variants.map((v) => (
            <VariantChip
              key={v.id}
              active={sel === v.id}
              title={v.title}
              onSelect={() => setSel(v.id)}
              onRename={(t) => void act(() => api.patchModelVariant(model.id, v.id, { title: t }))}
              onDelete={
                model.variants.length > 1
                  ? () => void act(() => api.deleteModelVariant(model.id, v.id))
                  : undefined
              }
            />
          ))}
          <button
            type="button"
            onClick={() => setSel('shared')}
            className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
              sel === 'shared'
                ? 'border-lime/60 bg-lime/10 text-ink'
                : 'border-line text-mut hover:text-ink'
            }`}
            title="Техника и объекты, общие для всех кнопок модели (мотоцикл и т.п.)"
          >
            🏍 общее
          </button>
          <span className="flex items-center gap-1 w-full sm:w-auto">
            <input
              value={newVariant}
              onChange={(e) => setNewVariant(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addVariant();
              }}
              placeholder="+ вариант (коса…)"
              className="min-h-10 flex-1 sm:w-36 rounded-lg bg-panel2 border border-line px-2 py-1 text-xs outline-none focus:border-lime/50"
            />
            <Button
              kind="ghost"
              disabled={!newVariant.trim()}
              className="min-h-10 !px-3 text-xs"
              onClick={addVariant}
            >
              Добавить
            </Button>
          </span>
        </div>

        {sel === 'shared' && (
          <p className="text-xs text-dim">
            Общие рефы едут с каждой кнопкой модели: мотоцикл/машина/объект. Подставятся в свап,
            только если такая техника есть в исходнике.
          </p>
        )}

        {/* Реф-листы выбранного варианта */}
        <div className="grid sm:grid-cols-2 gap-3">
          {refsShown.map((r) => (
            <RefTile key={r.id} modelId={model.id} r={r} onChanged={onChanged} onErr={setErr} />
          ))}
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="rounded-xl border border-dashed border-line2 hover:border-lime/40 bg-panel2/50 min-h-28 flex flex-col items-center justify-center gap-1 text-sm text-mut transition-colors disabled:opacity-50"
          >
            {uploading ? <Spinner /> : <span className="text-xl">＋</span>}
            {sel === 'shared' ? 'добавить технику/объект' : 'добавить реф-лист'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </div>
        {warnings.map((w) => (
          <p key={w} className="text-xs text-warn">⚠ {w}</p>
        ))}
        {err && <ErrorNote text={err} />}
      </div>
    </Card>
  );
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'а';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'и';
  return '';
}

function InlineName({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing) {
    return (
      <button
        type="button"
        className="text-lg font-bold hover:text-lime transition-colors"
        onClick={() => setEditing(true)}
        title="Переименовать"
      >
        {value}
      </button>
    );
  }
  return (
    <input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (v.trim() && v.trim() !== value) onSave(v.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setV(value);
          setEditing(false);
        }
      }}
      className="rounded-lg bg-panel2 border border-lime/50 px-2 py-1 text-lg font-bold outline-none"
    />
  );
}

function VariantChip({
  active,
  title,
  onSelect,
  onRename,
  onDelete,
}: {
  active: boolean;
  title: string;
  onSelect: () => void;
  onRename: (t: string) => void;
  onDelete?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(title);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setV(title), [title]);
  const save = () => {
    const next = v.trim();
    if (next && next !== title) onRename(next);
    else setV(title);
    setEditing(false);
  };
  if (editing) {
    return (
      <span className="flex items-center gap-1 rounded-lg border border-lime/50 bg-panel2 p-1">
        <input
          autoFocus
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              setV(title);
              setEditing(false);
            }
          }}
          className="w-28 min-h-8 rounded-md bg-panel border border-line px-2 py-1 text-xs outline-none"
        />
        <button type="button" onClick={save} className="min-w-8 min-h-8 rounded-md text-ok hover:bg-ok/10" aria-label="Сохранить название">
          ✓
        </button>
        <button
          type="button"
          onClick={() => {
            setV(title);
            setEditing(false);
          }}
          className="min-w-8 min-h-8 rounded-md text-dim hover:text-ink"
          aria-label="Отменить переименование"
        >
          ×
        </button>
      </span>
    );
  }
  return (
    <span
      className={`group flex items-center rounded-lg text-xs border transition-colors ${
        active ? 'border-lime/60 bg-lime/10 text-ink' : 'border-line text-mut hover:text-ink'
      }`}
    >
      <button type="button" onClick={onSelect} className="min-h-10 px-2.5 py-1 text-left">
        ⚡ {title}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-8 min-h-10 text-dim hover:text-lime opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
        aria-label={`Переименовать вариант «${title}»`}
      >
        ✎
      </button>
      {onDelete && (
        confirming ? (
          <span className="flex items-center pr-1">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
              className="min-h-8 px-1.5 text-[10px] text-danger"
            >
              удалить?
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="min-w-7 min-h-8 text-dim" aria-label="Отменить удаление">
              нет
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="min-w-8 min-h-10 text-dim hover:text-danger opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
            aria-label={`Удалить вариант «${title}»`}
            title="Удалить вариант (и его листы)"
          >
            ×
          </button>
        )
      )}
    </span>
  );
}

function RefTile({
  modelId,
  r,
  onChanged,
  onErr,
}: {
  modelId: string;
  r: ModelRefInfo;
  onChanged: () => void;
  onErr: (e: string) => void;
}) {
  const [note, setNote] = useState(r.note);
  const [describing, setDescribing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => setNote(r.note), [r.note]);

  const saveNote = async () => {
    if (note === r.note) return;
    setSaving(true);
    try {
      await api.patchModelRef(modelId, r.id, { note });
      onChanged();
    } catch (e) {
      onErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const describe = async () => {
    setDescribing(true);
    onErr('');
    try {
      const res = await api.describeModelRef(modelId, r.id);
      setNote(res.note); // черновик в редактируемое поле — сохранение кнопкой/blur-ом
    } catch (e) {
      onErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDescribing(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-panel2 overflow-hidden">
      <img
        src={api.modelFileUrl(modelId, r.file)}
        alt=""
        className="w-full h-32 object-cover object-top"
      />
      <div className="p-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <select
            value={r.role}
            onChange={(e) => {
              void api
                .patchModelRef(modelId, r.id, { role: e.target.value })
                .then(onChanged)
                .catch((er: Error) => onErr(er.message));
            }}
            className="rounded-md bg-panel border border-line text-xs px-1.5 py-1 outline-none"
          >
            {ROLE_OPTIONS.map(([role, labels]) => (
              <option key={role} value={role}>
                {labels.ru}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          {confirmDel ? (
            <span className="flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => {
                  void api
                    .deleteModelRef(modelId, r.id)
                    .then(onChanged)
                    .catch((er: Error) => onErr(er.message));
                }}
                className="text-danger"
              >
                удалить?
              </button>
              <button type="button" onClick={() => setConfirmDel(false)} className="text-dim hover:text-ink">
                нет
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="text-xs text-dim hover:text-danger">
              удалить
            </button>
          )}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder="Нота для промт-райтера: identity, аутфит, КАПСОМ ключевое…"
          className="w-full rounded-md bg-panel border border-line text-xs px-2 py-1.5 outline-none focus:border-lime/50 resize-y sf-scroll"
        />
        <div className="flex items-center gap-2">
          <Button
            kind="ghost"
            busy={describing}
            className="!py-1 !px-2 text-xs"
            onClick={() => void describe()}
            title="Vision-модель напишет черновик ноты по этому листу — отредактируй и сохрани"
          >
            ✨ Описать автоматически
          </Button>
          {note !== r.note && (
            <Button
              kind="primary"
              busy={saving}
              className="!py-1 !px-2 text-xs"
              onClick={() => void saveNote()}
            >
              Сохранить ноту
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
