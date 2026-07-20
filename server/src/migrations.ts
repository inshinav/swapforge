// Exactly-once миграции ДАННЫХ (не DDL — DDL живёт в applySchema идемпотентно).
// Каждая запускается ровно один раз, помечается в schema_migrations, катится в
// BEGIN IMMEDIATE (единый писатель SQLite: никакой другой запрос не вклинится).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PRESETS, presetsDir } from './presets';
import { ensureModelDirs, modelRefsDir } from './storage';

export interface DataMigrationOpts {
  /** telegram_id владельца из env; null (дев/тесты) = owner-миграции откладываются. */
  ownerTelegramId: string | null;
}

interface DataMigration {
  id: string;
  /** false = условия не готовы (нет env) — НЕ помечать применённой, попробуем на следующем буте. */
  up(d: DatabaseSync, opts: DataMigrationOpts): boolean;
}

/** Владелец: ровно одна строка role='owner'; прежние owner-сессии отзываются при ротации. */
export function ensureOwnerUser(d: DatabaseSync, ownerTelegramId: string): string {
  const tgId = Number(ownerTelegramId);
  if (!Number.isFinite(tgId) || tgId <= 0) {
    throw new Error(`OWNER_TELEGRAM_ID должен быть числом, а не «${ownerTelegramId}»`);
  }
  const existing = d.prepare(`SELECT id FROM users WHERE telegram_id = ?`).get(tgId) as
    | { id: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  if (!existing) {
    d.prepare(
      `INSERT INTO users (id, telegram_id, tg_first_name, role) VALUES (?, ?, 'Владелец', 'user')`,
    ).run(id, tgId);
  }
  const previous = d
    .prepare(`SELECT id FROM users WHERE role='owner' AND id<>?`)
    .all(id) as Array<{ id: string }>;
  for (const row of previous) d.prepare(`DELETE FROM sessions WHERE user_id=?`).run(row.id);
  d.prepare(`UPDATE users SET role='user' WHERE role='owner' AND id<>?`).run(id);
  d.prepare(`UPDATE users SET role='owner' WHERE id=?`).run(id);
  return id;
}

const MIGRATIONS: DataMigration[] = [
  {
    // Все легаси-строки single-owner эпохи принадлежат владельцу. usage_events с
    // NULL project_id (история удалённых проектов) — тоже его: до v4 других юзеров не было.
    id: 'm001-owner-and-backfill',
    up(d, opts) {
      if (!opts.ownerTelegramId) return false;
      const ownerId = ensureOwnerUser(d, opts.ownerTelegramId);
      d.prepare(`UPDATE projects SET user_id = ? WHERE user_id IS NULL`).run(ownerId);
      d.prepare(
        `UPDATE generations SET user_id = (SELECT p.user_id FROM projects p WHERE p.id = generations.project_id)
          WHERE user_id IS NULL`,
      ).run();
      d.prepare(
        `UPDATE usage_events SET user_id = COALESCE(
            (SELECT p.user_id FROM projects p WHERE p.id = usage_events.project_id), ?)
          WHERE user_id IS NULL`,
      ).run(ownerId);
      return true;
    },
  },
  {
    // Захардкоженные пресеты v3 → «просто модели владельца» в новой системе:
    // 2 модели × 3 варианта, общий байк каждой модели = shared-реф (variant_id NULL).
    // Ассеты копируются из репо (server/assets/presets) в data-dir; notes verbatim.
    // Откладывается, пока нет владельца или ассетов на диске (репо их несёт — на
    // проде будут; retirement presets.ts — только ПОСЛЕ чекпоинта этой миграции).
    id: 'm002-seed-owner-models',
    up(d, opts) {
      if (!opts.ownerTelegramId) return false;
      const owner = d
        .prepare(`SELECT id FROM users WHERE telegram_id = ?`)
        .get(Number(opts.ownerTelegramId)) as { id: string } | undefined;
      if (!owner) return false;

      const groups = [
        { name: 'MotoLola', prefix: 'motolola-' },
        { name: 'Lunaria', prefix: 'lunaria-' },
      ];
      const wanted = groups.flatMap((g) => PRESETS.filter((p) => p.id.startsWith(g.prefix)));
      if (wanted.length === 0) return true; // пресеты уже вырезаны из кода — сидить нечего
      for (const p of wanted) {
        for (const r of p.refs) {
          if (!fs.existsSync(path.join(presetsDir(), r.file))) return false; // нет ассетов — отложить
        }
      }

      const insertModel = d.prepare(`INSERT INTO models (id, user_id, name) VALUES (?, ?, ?)`);
      const insertVariant = d.prepare(
        `INSERT INTO model_variants (id, model_id, title, hint, idx) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertRef = d.prepare(
        `INSERT INTO model_refs (id, model_id, variant_id, file, role, note, idx) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const g of groups) {
        const presets = PRESETS.filter((p) => p.id.startsWith(g.prefix));
        if (presets.length === 0) continue;
        const modelId = randomUUID();
        insertModel.run(modelId, owner.id, g.name);
        ensureModelDirs(modelId);
        let refIdx = 0;
        const sharedByFile = new Map<string, string>(); // дедуп общего байка между вариантами
        presets.forEach((preset, vi) => {
          const variantId = randomUUID();
          // «MotoLola · распущенные» → вариант «распущенные» (имя модели уже в кнопке)
          const title = preset.title.includes('·')
            ? preset.title.split('·').slice(1).join('·').trim()
            : preset.title;
          insertVariant.run(variantId, modelId, title, preset.hint, vi);
          for (const r of preset.refs) {
            const isShared = r.role !== 'model';
            if (isShared && sharedByFile.has(r.file)) continue;
            fs.copyFileSync(path.join(presetsDir(), r.file), path.join(modelRefsDir(modelId), r.file));
            insertRef.run(randomUUID(), modelId, isShared ? null : variantId, r.file, r.role, r.note, refIdx++);
            if (isShared) sharedByFile.set(r.file, r.file);
          }
        });
      }
      return true;
    },
  },
];

/** Вызывается из getDb() после applySchema; порядок массива = порядок применения. */
export function runDataMigrations(d: DatabaseSync, opts: DataMigrationOpts): void {
  for (const m of MIGRATIONS) {
    const done = d.prepare(`SELECT 1 FROM schema_migrations WHERE id = ?`).get(m.id);
    if (done) continue;
    d.exec('BEGIN IMMEDIATE');
    try {
      const applied = m.up(d, opts);
      if (applied) {
        d.prepare(`INSERT INTO schema_migrations (id) VALUES (?)`).run(m.id);
        d.exec('COMMIT');
        console.log(`[migrate] ${m.id} применена`);
      } else {
        d.exec('ROLLBACK');
        console.warn(`[migrate] ${m.id} отложена: условия не готовы (нет OWNER_TELEGRAM_ID или ассетов)`);
      }
    } catch (e) {
      d.exec('ROLLBACK');
      throw new Error(`Миграция ${m.id} упала: ${e instanceof Error ? e.message : e}`);
    }
  }
}
