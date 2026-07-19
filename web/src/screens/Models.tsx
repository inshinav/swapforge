// Конструктор моделей: персонаж → варианты образа (кнопки) → реф-листы с нотами.
// Качество кнопки = качество ноты: «Описать автоматически» даёт черновик по анатомии
// фирменных пресетов, юзер правит руками. Всё приватно, шаринга нет.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ModelRefInfo, ModelVariantInfo } from '@shared/api-types';
import { REF_ROLES, type RefRole } from '@shared/taxonomy';
import { api } from '../api';
import ReferenceExamples from '../ReferenceExamples';

const ROLE_OPTIONS = Object.entries(REF_ROLES) as Array<[RefRole, { ru: string; en: string }]>;
const MODEL_ONLY_HINT = 'Модель в одном образе со всех ракурсов';
const MODEL_OBJECT_HINT = 'Модель + объект или транспорт';
type PresetKind = 'model' | 'model_object';
import { Button, Card, Empty, ErrorNote, SectionTitle, Spinner, Tag } from '../ui';

export default function Models({ guided = false, onProgressChange }: { guided?: boolean; onProgressChange?: () => void }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => {
    api
      .models()
      .then((next) => {
        setModels(next);
        onProgressChange?.();
      })
      .catch((e: Error) => setErr(e.message));
  }, [onProgressChange]);

  useEffect(reload, [reload]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setErr('');
    try {
      const { id } = await api.createModel(name);
      await api.addModelVariant(id, 'Базовый образ', MODEL_ONLY_HINT);
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
        <SectionTitle title={guided ? 'Модель и пресеты' : 'Мои модели'} />
        <div className="p-5 space-y-3">
          {guided && (
            <div className="rounded-xl border border-lime/35 bg-lime/5 px-4 py-3 text-sm">
              <div className="font-semibold">Сначала создай модель, затем добавь референсы</div>
              <div className="text-xs text-mut mt-1">Лицо крупно · полный рост · профиль или 3/4. Для другого образа или задачи добавь отдельный пресет.</div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void create()}
              placeholder="Имя модели"
              className="flex-1 min-w-[220px] min-h-11 rounded-lg bg-panel2 border border-line px-3 py-2 text-sm outline-none focus:border-lime/50"
            />
            <Button kind="primary" busy={creating} disabled={!newName.trim()} onClick={() => void create()}>
              Создать
            </Button>
          </div>
          {err && <ErrorNote text={err} />}
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
          sub="Создай модель и добавь её референс"
        />
      ) : (
        models.map((m) => <ModelCard key={m.id} model={m} onChanged={reload} />)
      )}
    </div>
  );
}

function ModelCard({ model, onChanged }: { model: ModelInfo; onChanged: () => void }) {
  const [sel, setSel] = useState<string | 'shared'>(model.variants[0]?.id ?? 'shared');
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [addingPreset, setAddingPreset] = useState(false);
  const [newVariant, setNewVariant] = useState('');
  const [newKind, setNewKind] = useState<PresetKind>('model');
  const [creatingVariant, setCreatingVariant] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadRoleRef = useRef<RefRole>('model');
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

  const selectedVariant = sel === 'shared' ? null : model.variants.find((v) => v.id === sel) ?? null;
  const sharedRefs = model.refs.filter((r) => r.variantId === null);
  const ownRefs = sel === 'shared' ? sharedRefs : model.refs.filter((r) => r.variantId === sel);
  const includedRefs = sel === 'shared' ? sharedRefs : [...ownRefs, ...sharedRefs];
  const presetKind = selectedVariant ? getPresetKind(selectedVariant, includedRefs) : null;
  const modelRefCount = includedRefs.filter((r) => r.role === 'model').length;
  const objectRefCount = includedRefs.filter((r) => r.role !== 'model').length;

  const openUpload = (role: RefRole) => {
    uploadRoleRef.current = role;
    fileRef.current?.click();
  };

  const upload = async (files: FileList) => {
    setUploading(true);
    setErr('');
    setWarnings([]);
    try {
      const nextWarnings: string[] = [];
      for (const file of Array.from(files)) {
        const res = await api.addModelRef(
          model.id,
          file,
          uploadRoleRef.current,
          sel === 'shared' ? null : sel,
        );
        nextWarnings.push(...res.warnings);
      }
      setWarnings(nextWarnings);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const addVariant = async () => {
    const title = newVariant.trim();
    if (!title) return;
    setCreatingVariant(true);
    setErr('');
    try {
      await api.addModelVariant(
        model.id,
        title,
        newKind === 'model_object' ? MODEL_OBJECT_HINT : MODEL_ONLY_HINT,
      );
      setNewVariant('');
      setNewKind('model');
      setAddingPreset(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingVariant(false);
    }
  };

  return (
    <Card>
      <div className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <InlineName
            value={model.name}
            onSave={(name) => void act(() => api.renameModel(model.id, name))}
          />
          <Tag tone="mut">{model.variants.length} пресет{pluralPreset(model.variants.length)}</Tag>
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
            <button type="button" onClick={() => setConfirmDel(true)} className="min-h-11 px-2 text-xs text-dim hover:text-danger">
              удалить
            </button>
          )}
        </div>

        {/* Пресеты (варианты модели / кнопки свапа) + общие рефы */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {model.variants.map((v) => (
              <VariantChip
                key={v.id}
                active={sel === v.id}
                title={v.title}
                summary={variantSummary(v, model.refs)}
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
              className={`min-h-11 px-3 py-1 rounded-lg text-xs border transition-colors ${
                sel === 'shared'
                  ? 'border-lime/60 bg-lime/10 text-ink'
                  : 'border-line text-mut hover:text-ink'
              }`}
              title="Техника и объекты, которые попадут во все пресеты этой модели"
            >
              Общее · {sharedRefs.length}
            </button>
            <button
              type="button"
              onClick={() => setAddingPreset((value) => !value)}
              className="min-h-11 px-3 py-1 rounded-lg text-xs border border-dashed border-line2 text-mut hover:border-lime/40 hover:text-ink"
            >
              ＋ Новый пресет
            </button>
          </div>

          {addingPreset && (
            <div className="rounded-xl border border-line bg-panel2 p-3 space-y-3">
              <div className="text-sm font-semibold">Что будет в пресете?</div>
              <div className="grid sm:grid-cols-2 gap-2">
                <PresetKindButton
                  active={newKind === 'model'}
                  title="Только модель"
                  sub="Один лук со всех ракурсов"
                  onClick={() => setNewKind('model')}
                />
                <PresetKindButton
                  active={newKind === 'model_object'}
                  title="Модель + объект"
                  sub="Например, модель и мотоцикл"
                  onClick={() => setNewKind('model_object')}
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={newVariant}
                  onChange={(e) => setNewVariant(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addVariant();
                  }}
                  placeholder="Название: чёрный лук, реклама мотоцикла…"
                  className="min-h-11 flex-1 min-w-0 rounded-lg bg-panel border border-line px-3 py-2 text-sm outline-none focus:border-lime/50"
                />
                <Button
                  kind="primary"
                  busy={creatingVariant}
                  disabled={!newVariant.trim()}
                  className="min-h-11 !px-4 text-sm"
                  onClick={() => void addVariant()}
                >
                  Создать пресет
                </Button>
              </div>
            </div>
          )}
        </div>

        {selectedVariant && presetKind && (
          <div className="rounded-xl border border-line bg-panel2/70 p-3 sm:p-4 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-dim">Состав пресета «{selectedVariant.title}»</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Tag tone={modelRefCount >= 1 ? 'ok' : 'mut'}>Фото модели · {modelRefCount}</Tag>
                  {presetKind === 'model_object' && (
                    <Tag tone={objectRefCount >= 1 ? 'ok' : 'mut'}>Объект / транспорт · {objectRefCount}</Tag>
                  )}
                  {sharedRefs.length > 0 && <Tag tone="mut">Из них общих · {sharedRefs.length}</Tag>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5 w-full sm:w-auto">
                <PresetKindButton
                  compact
                  active={presetKind === 'model'}
                  title="Только модель"
                  onClick={() => void act(() => api.patchModelVariant(model.id, selectedVariant.id, { hint: MODEL_ONLY_HINT }))}
                />
                <PresetKindButton
                  compact
                  active={presetKind === 'model_object'}
                  title="+ объект"
                  onClick={() => void act(() => api.patchModelVariant(model.id, selectedVariant.id, { hint: MODEL_OBJECT_HINT }))}
                />
              </div>
            </div>

            <div className="text-xs text-mut">
              {modelRefCount >= 1 ? '✓ Модель добавлена' : 'Добавь модель: лицо, полный рост и профиль или 3/4'}
              {presetKind === 'model_object' && (
                <span className="block mt-1">
                  {objectRefCount >= 1 ? '✓ Объект добавлен' : '0/1 · добавь мотоцикл, товар или другой важный объект'}
                </span>
              )}
              <span className="block mt-1 text-dim">Один референс-лист со всеми ракурсами или 3–5 отдельных фото. Везде должен быть один образ.</span>
              <span className="block mt-1 text-lime">Добавляй фото по одному или несколько сразу — новые файлы дополняют пресет.</span>
            </div>

            <details className="rounded-lg border border-line bg-panel">
              <summary className="min-h-11 cursor-pointer px-3 py-2.5 text-sm font-semibold text-lime">
                Показать хороший пример
              </summary>
              <div className="border-t border-line p-3">
                <ReferenceExamples
                  key={`${selectedVariant.id}:${presetKind}`}
                  compact
                  initial={presetKind === 'model_object' ? 'object' : 'look'}
                />
              </div>
            </details>

            <div className={`grid gap-2 ${presetKind === 'model_object' ? 'sm:grid-cols-3' : 'sm:grid-cols-1'}`}>
              <UploadButton
                disabled={uploading}
                title="Добавить фото модели"
                sub="По одному или несколько"
                onClick={() => openUpload('model')}
              />
              {presetKind === 'model_object' && (
                <>
                  <UploadButton
                    disabled={uploading}
                    title="Добавить транспорт"
                    sub="Мотоцикл, машина…"
                    onClick={() => openUpload('vehicle')}
                  />
                  <UploadButton
                    disabled={uploading}
                    title="Добавить объект"
                    sub="Товар, аксессуар…"
                    onClick={() => openUpload('object')}
                  />
                </>
              )}
            </div>
          </div>
        )}

        {sel === 'shared' && (
          <div className="rounded-xl border border-line bg-panel2/70 p-3 sm:p-4 space-y-3">
            <div>
              <div className="font-semibold text-sm">Общее для всех пресетов</div>
              <p className="text-xs text-dim mt-1">Добавь сюда мотоцикл, машину или товар, если они должны быть доступны в каждом образе.</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              <UploadButton
                disabled={uploading}
                title="Добавить транспорт"
                sub="Мотоцикл, машина…"
                onClick={() => openUpload('vehicle')}
              />
              <UploadButton
                disabled={uploading}
                title="Добавить объект"
                sub="Товар, аксессуар…"
                onClick={() => openUpload('object')}
              />
            </div>
          </div>
        )}

        {uploading && (
          <div className="flex items-center gap-2 text-sm text-mut">
            <Spinner size={14} /> загружаю референсы…
          </div>
        )}

        {/* Реф-листы выбранного варианта. Общие видны внутри каждого пресета. */}
        {includedRefs.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold text-mut">
              {sel === 'shared' ? 'Загруженные общие референсы' : 'Что войдёт в этот пресет'}
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              {includedRefs.map((r) => (
                <RefTile
                  key={r.id}
                  modelId={model.id}
                  r={r}
                  shared={sel !== 'shared' && r.variantId === null}
                  onChanged={onChanged}
                  onErr={setErr}
                />
              ))}
            </div>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) void upload(files);
          }}
        />
        {warnings.map((w) => (
          <p key={w} className="text-xs text-warn">⚠ {w}</p>
        ))}
        {err && <ErrorNote text={err} />}
      </div>
    </Card>
  );
}

function getPresetKind(variant: ModelVariantInfo, refs: ModelRefInfo[]): PresetKind {
  if (variant.hint === MODEL_ONLY_HINT) return 'model';
  if (variant.hint === MODEL_OBJECT_HINT) return 'model_object';
  return refs.some((r) => r.role !== 'model') ? 'model_object' : 'model';
}

function variantSummary(variant: ModelVariantInfo, refs: ModelRefInfo[]): string {
  const included = refs.filter((r) => r.variantId === null || r.variantId === variant.id);
  const models = included.filter((r) => r.role === 'model').length;
  const objects = included.length - models;
  if (included.length === 0) return 'пусто';
  return objects > 0 ? `${models} фото модели · ${objects} объект/транспорт` : `${models} фото модели`;
}

function PresetKindButton({
  active,
  title,
  sub,
  compact = false,
  onClick,
}: {
  active: boolean;
  title: string;
  sub?: string;
  compact?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border text-left transition-colors ${
        compact ? 'min-h-11 px-2.5 py-1.5 text-xs' : 'min-h-16 px-3 py-2'
      } ${active ? 'border-lime/60 bg-lime/10 text-ink' : 'border-line bg-panel text-mut hover:text-ink'}`}
    >
      <span className="block font-semibold">{active ? '✓ ' : ''}{title}</span>
      {sub && <span className="block mt-0.5 text-xs text-dim">{sub}</span>}
    </button>
  );
}

function UploadButton({
  disabled,
  title,
  sub,
  onClick,
}: {
  disabled: boolean;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-16 rounded-lg border border-dashed border-line2 bg-panel px-3 py-2 text-left hover:border-lime/40 transition-colors disabled:opacity-50"
    >
      <span className="block text-sm font-semibold">＋ {title}</span>
      <span className="block mt-0.5 text-xs text-dim">{sub}</span>
    </button>
  );
}

function pluralPreset(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return '';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'а';
  return 'ов';
}

function InlineName({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  if (!editing) {
    return (
      <button
        type="button"
        className="min-h-11 text-lg font-bold hover:text-lime transition-colors"
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
      className="min-h-11 rounded-lg bg-panel2 border border-lime/50 px-2 py-1 text-lg font-bold outline-none"
    />
  );
}

function VariantChip({
  active,
  title,
  summary,
  onSelect,
  onRename,
  onDelete,
}: {
  active: boolean;
  title: string;
  summary: string;
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
          className="w-28 min-h-11 rounded-md bg-panel border border-line px-2 py-1 text-xs outline-none"
        />
        <button type="button" onClick={save} className="min-w-11 min-h-11 rounded-md text-ok hover:bg-ok/10" aria-label="Сохранить название">
          ✓
        </button>
        <button
          type="button"
          onClick={() => {
            setV(title);
            setEditing(false);
          }}
          className="min-w-11 min-h-11 rounded-md text-dim hover:text-ink"
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
      <button type="button" onClick={onSelect} className="min-h-11 px-2.5 py-1 text-left">
        <span className="block font-semibold">{title}</span>
        <span className="block text-[10px] text-dim">{summary}</span>
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="min-w-11 min-h-11 text-dim hover:text-lime opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
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
              className="min-h-11 px-2 text-[10px] text-danger"
            >
              удалить?
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="min-w-11 min-h-11 text-dim" aria-label="Отменить удаление">
              нет
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="min-w-11 min-h-11 text-dim hover:text-danger opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
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
  shared = false,
  onChanged,
  onErr,
}: {
  modelId: string;
  r: ModelRefInfo;
  shared?: boolean;
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
        {shared && (
          <div className="text-[11px] text-lime">Общее · используется во всех пресетах</div>
        )}
        <div className="flex items-center gap-2">
          <select
            value={r.role}
            onChange={(e) => {
              void api
                .patchModelRef(modelId, r.id, { role: e.target.value })
                .then(onChanged)
                .catch((er: Error) => onErr(er.message));
            }}
            className="min-h-11 rounded-md bg-panel border border-line text-xs px-1.5 py-1 outline-none"
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
                className="min-h-11 px-2 text-danger"
              >
                удалить?
              </button>
              <button type="button" onClick={() => setConfirmDel(false)} className="min-h-11 px-2 text-dim hover:text-ink">
                нет
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="min-h-11 px-2 text-xs text-dim hover:text-danger">
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
