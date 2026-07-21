// Встроенные референс-паки: фирменные листы «все ракурсы» хранятся в репо и
// подкладываются в проект одной кнопкой — дальше конвейер работает с ними как
// с обычными рефами (нумерация, старт-кадр, WaveSpeed reference_images).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from './db';
import { refsDir, ensureProjectDirs } from './storage';
import type { RefRole } from '../../shared/taxonomy';
import { MAX_PROJECT_REFS, ReferenceLimitError } from './engine/reference-manifest';

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

const BIKE_LUNARIA: PresetRefDef = {
  file: 'lunaria-bike.jpg',
  role: 'vehicle',
  note: 'Kawasaki Ninja ZX-6R Lunaria: ЧЁРНЫЙ с РОЗОВЫМИ акцентами — розовые диски колёс, розовые линии на обтекателях, розовые детали подножек; референс-лист со всех ракурсов. Использовать ТОЛЬКО если в исходнике есть мотоцикл; если мотоцикла в кадре нет — полностью игнорировать этот референс',
};

/** Общая часть описания Lunaria: identity одна, аутфиты меняются по пресету. */
const LUNARIA =
  'Lunaria — референс-лист со всех ракурсов: платиново-БЕЛЫЕ волосы (растрёпанный шегги-боб с чёлкой), карие глаза, веснушки, мягкая улыбка; нижние ряды листа — она же в РОЗОВОМ шлеме с кошачьими ушами + отдельные панели экипировки';

/** Общая часть описания fox-образа: хвост и уши — ЧАСТЬ ОБРАЗА, промты обязаны их сохранять. */
const FOX =
  'MotoLola в fox-образе — референс-лист со всех ракурсов: чёрно-оранжевый мотокостюм с белыми акцентами и лисьей мордой на груди, пышный меховой воротник, ПУШИСТЫЙ ЛИСИЙ ХВОСТ (часть образа — всегда сохранять на модели в кадре), меховые манжеты и опушка на ботинках; нижний ряд листа — она же в чёрном шлеме с МЕХОВЫМИ ЛИСЬИМИ УШАМИ и лисьим принтом';

/** Мотолук без fox-элементов: отдельный костюм и шлем не должны смешиваться с fox-вариантами. */
const MOTOLOOK =
  'MotoLola в мотолуке — референс-лист со всех ракурсов: чёрный облегающий кожаный мотокомбинезон с ярко-оранжевыми панелями и кантами, чёрно-оранжевые перчатки и мотоботинки; нижний ряд листа — тот же образ в чёрном полноразмерном шлеме с кошачьими ушами и оранжевой графикой, с поднятым и опущенным визором и сзади. Сохранять лицо, веснушки и рыжий цвет волос; НЕ добавлять лисий хвост, мех или другие элементы fox-образа';

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
  {
    id: 'motolola-moto-loose',
    title: 'MotoLola · мотолук · распущенные',
    hint: 'чёрно-оранжевый мотокомбинезон и шлем с кошачьими ушами, волосы распущены; Kawasaki подставится только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'motolola-moto-loose.png',
        role: 'model',
        note: `${MOTOLOOK}; длинные РАСПУЩЕННЫЕ волнистые рыжие волосы`,
      },
      BIKE_REF,
    ],
  },
  {
    id: 'motolola-moto-braid',
    title: 'MotoLola · мотолук · коса',
    hint: 'чёрно-оранжевый мотокомбинезон и шлем с кошачьими ушами, одна коса; Kawasaki подставится только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'motolola-moto-braid.png',
        role: 'model',
        note: `${MOTOLOOK}; рыжие волосы заплетены в ОДНУ ДЛИННУЮ КОСУ через плечо`,
      },
      BIKE_REF,
    ],
  },
  {
    id: 'motolola-moto-twinbraids',
    title: 'MotoLola · мотолук · две косы',
    hint: 'чёрно-оранжевый мотокомбинезон и шлем с кошачьими ушами, две косы; Kawasaki подставится только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'motolola-moto-twinbraids.png',
        role: 'model',
        note: `${MOTOLOOK}; рыжие волосы заплетены в ДВЕ ДЛИННЫЕ КОСЫ по бокам`,
      },
      BIKE_REF,
    ],
  },
  {
    id: 'lunaria-moto',
    title: 'Lunaria · мото',
    hint: 'белые волосы, чёрно-розовая экипировка; её чёрно-розовый Kawasaki подставится, только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'lunaria-moto.jpg',
        role: 'model',
        note: `${LUNARIA}. Аутфит: чёрная кроп-косуха с РОЗОВЫМИ полосами, розовый топ, чёрные мото-леггинсы с розовыми линиями, чёрно-розовые мото-перчатки и ботинки; шлем — розовый кат-ушастый`,
      },
      BIKE_LUNARIA,
    ],
  },
  {
    id: 'lunaria-sport',
    title: 'Lunaria · спорт',
    hint: 'белые волосы, спортивный образ; её чёрно-розовый Kawasaki подставится, только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'lunaria-sport.jpg',
        role: 'model',
        note: `${LUNARIA}. Аутфит: белый спортивный топ, ЛАВАНДОВЫЕ леггинсы Nike, белые носки Nike и белые кроссовки`,
      },
      BIKE_LUNARIA,
    ],
  },
  {
    id: 'lunaria-kawaii',
    title: 'Lunaria · кавай',
    hint: 'белые волосы, розовый кавай-образ; её чёрно-розовый Kawasaki подставится, только если в кадре есть мотоцикл',
    refs: [
      {
        file: 'lunaria-kawaii.jpg',
        role: 'model',
        note: `${LUNARIA}. Аутфит: розово-белый лонгслив с вырезом и принтом зайчика на спине, розовая плиссированная МИНИ-ЮБКА, белые гольфы с розовыми полосками, бело-розовые кроссовки Nike`,
      },
      BIKE_LUNARIA,
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
  if (preset.refs.length > MAX_PROJECT_REFS) throw new ReferenceLimitError(preset.refs.length);
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
