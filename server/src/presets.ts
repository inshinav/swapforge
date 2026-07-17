// Встроенные референс-паки: фирменные листы «все ракурсы» хранятся в репо и
// подкладываются в проект одной кнопкой — дальше конвейер работает с ними как
// с обычными рефами (нумерация, старт-кадр, WaveSpeed reference_images).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { refsDir, ensureProjectDirs } from './storage';
import type { RefRole } from '../../shared/taxonomy';

export interface PresetRefDef {
  file: string;
  role: RefRole;
  note: string;
}

export interface PresetDef {
  id: string;
  title: string;
  hint: string;
  /** Порядок = нумерация reference image (модель первой — ref 2 после старт-кадра). */
  refs: PresetRefDef[];
}

const BIKE_REF: PresetRefDef = {
  file: 'zx6r.jpg',
  role: 'vehicle',
  note: 'Kawasaki Ninja ZX-6R, оранжево-чёрный — референс-лист со всех ракурсов (бок/фронт/зад/3-четверти/сверху/кокпит). Использовать ТОЛЬКО если в исходнике есть мотоцикл; если мотоцикла в кадре нет — полностью игнорировать этот референс',
};

/** Общая часть описания fox-образа: хвост и уши — ЧАСТЬ ОБРАЗА, промты обязаны их сохранять. */
const FOX =
  'MotoLola в fox-образе — референс-лист со всех ракурсов: чёрно-оранжевый мотокостюм с белыми акцентами и лисьей мордой на груди, пышный меховой воротник, ПУШИСТЫЙ ЛИСИЙ ХВОСТ (часть образа — всегда сохранять на модели в кадре), меховые манжеты и опушка на ботинках; нижний ряд листа — она же в чёрном шлеме с МЕХОВЫМИ ЛИСЬИМИ УШАМИ и лисьим принтом';

export const PRESETS: PresetDef[] = [
  {
    id: 'motolola-loose',
    title: 'MotoLola · распущенные',
    hint: 'fox-образ со всех ракурсов (волосы распущены); Kawasaki подставится, только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'motolola-loose.jpg',
        role: 'model',
        note: `${FOX}; длинные РАСПУЩЕННЫЕ волнистые рыжие волосы`,
      },
      BIKE_REF,
    ],
  },
  {
    id: 'motolola-braid',
    title: 'MotoLola · коса',
    hint: 'fox-образ со всех ракурсов (одна коса); Kawasaki подставится, только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'motolola-braid.jpg',
        role: 'model',
        note: `${FOX}; рыжие волосы заплетены в ОДНУ ДЛИННУЮ КОСУ через плечо`,
      },
      BIKE_REF,
    ],
  },
  {
    id: 'motolola-twinbraids',
    title: 'MotoLola · две косы',
    hint: 'fox-образ со всех ракурсов (две косы); Kawasaki подставится, только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'motolola-twinbraids.jpg',
        role: 'model',
        note: `${FOX}; рыжие волосы заплетены в ДВЕ ДЛИННЫЕ КОСЫ по бокам`,
      },
      BIKE_REF,
    ],
  },
];

/** Каталог ассетов: рядом с кодом (репо), а не в data-dir — версионируется деплоем. */
export function presetsDir(): string {
  return process.env.PRESETS_DIR?.trim() || path.resolve('assets/presets');
}

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function presetFilePath(preset: PresetDef, file: string): string | null {
  if (!preset.refs.some((r) => r.file === file)) return null;
  const full = path.join(presetsDir(), file);
  return fs.existsSync(full) ? full : null;
}

/**
 * Копирует файлы пресета в refs проекта и создаёт строки refs (role_source='preset').
 * Только для проекта без референсов — пресет не смешивается с ручными рефами.
 */
export function applyPreset(projectId: string, preset: PresetDef): void {
  const db = getDb();
  const have = db
    .prepare(`SELECT COUNT(*) AS c FROM refs WHERE project_id = ?`)
    .get(projectId) as { c: number };
  if (have.c > 0) throw new Error('У проекта уже есть референсы — пресет применяется к чистому проекту');

  for (const def of preset.refs) {
    const src = path.join(presetsDir(), def.file);
    if (!fs.existsSync(src)) throw new Error(`Файл пресета не найден на сервере: ${def.file}`);
  }
  ensureProjectDirs(projectId);
  const insert = db.prepare(
    `INSERT INTO refs (id, project_id, idx, role, file, note, role_source, auto_note)
     VALUES (?, ?, ?, ?, ?, ?, 'preset', '')`,
  );
  preset.refs.forEach((def, i) => {
    const refId = randomUUID();
    const ext = path.extname(def.file) || '.jpg';
    const file = `ref_${refId.slice(0, 8)}${ext}`;
    fs.copyFileSync(path.join(presetsDir(), def.file), path.join(refsDir(projectId), file));
    insert.run(refId, projectId, i, def.role, file, def.note);
  });
}
