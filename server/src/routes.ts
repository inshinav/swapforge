import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { config, llmKeyPresent, llmModelName } from './config';
import { getDb } from './db';
import { registerAuthRoutes } from './auth/routes';
import { registerModelRoutes } from './routes-models';
import { registerBillingRoutes } from './billing/routes';
import { registerAdminRoutes } from './admin/routes';
import { openHoldForProject, placeHold, priceCredits } from './billing/credits';
import { forceReleaseProjectHold, releaseHoldForDeletedProject, toUserEstimate } from './billing/flow';
import { requireOwner } from './auth/middleware';
import { applyModelVariant } from './models';
import { ffmpegAvailable, probe } from './ffmpeg';
import { BUSY_STATUSES, isQueued } from './jobs';
import {
  dataUsageBytes,
  deleteProjectFiles,
  enforceStorageCap,
  ensureProjectDirs,
  invalidateUserUsage,
  projectDir,
  refsDir,
  safeMediaPath,
  userUsageBytes,
} from './storage';
import { advanceFlow, startAnalysis, startGeneration, startStoryboard } from './engine/pipeline';
import { generateStartFrame } from './engine/startframe';
import {
  RenderGateError,
  cancelQueued,
  cancelQueuedForProject,
  parseGenerateAudio,
  projectHasActiveGeneration,
  promoteNext,
  recheckGeneration,
  retryGeneration,
  startRender,
} from './engine/render';
import { LIMIT_MESSAGE, consumeDailyLimit } from './limits';
import { renderLegalPage } from './legal';
import { nextStageOf, parseFlags, snapshotProject } from './engine/orchestrator';
import { PRESETS, applyPreset, getPreset, presetFilePath } from './presets';
import { classifyRef } from './engine/classify';
import { buildEstimate, getBalanceCached, pricingDates } from './pricing';
import { monthSummary } from './usage';
import { toFull, toSummary, type DbProject } from './rows';
import { ARTIFACT_TYPES, type ArtifactType } from '../../shared/taxonomy';
import type { HealthInfo, PricingInfo, RefInfo } from '../../shared/api-types';
import type { Analysis } from '../../shared/analysis';
import { referenceAuditMessage, referenceAuditPause } from './engine/reference-audit';

const BUSY = BUSY_STATUSES;
const VIDEO_MIME: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'application/octet-stream': '.mp4',
};
const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MEDIA_CT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function bad(reply: FastifyReply, code: number, msg: string) {
  return reply.code(code).send({ error: msg });
}

/** Кросс-сайтовые form-POST под basic auth отклоняем (Sec-Fetch-Site шлют все браузеры). */
function crossSite(req: FastifyRequest): boolean {
  const s = req.headers['sec-fetch-site'];
  return typeof s === 'string' && s !== 'same-origin' && s !== 'same-site' && s !== 'none';
}

/** Кап ручных LLM-роутов «под капотом» (не-владелец): analyze/generate/iterate/startframe. */
function manualLlmAllowed(req: FastifyRequest): boolean {
  if (req.user!.role === 'owner') return true;
  return consumeDailyLimit(req.user!.id, 'manual_llm', config.limitManualLlmPerDay).allowed;
}

function projectHasQueuedGeneration(projectId: string): boolean {
  return !!getDb()
    .prepare(`SELECT 1 FROM generations WHERE project_id = ? AND status = 'queued' LIMIT 1`)
    .get(projectId);
}

/** Единственный вход к проекту: только строка ТЕКУЩЕГО пользователя. Чужой id = 404 (не оракул). */
function getOwnedProject(req: FastifyRequest, id: string): DbProject | undefined {
  if (!req.user) return undefined;
  return getDb()
    .prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`)
    .get(id, req.user.id) as DbProject | undefined;
}

/** Любое изменение пакета референсов требует нового совместного vision-аудита. */
function invalidateReferenceAnalysis(projectId: string): void {
  getDb()
    .prepare(
      `UPDATE projects
          SET analysis_json = NULL, tags_json = NULL, error = NULL,
              status = CASE WHEN frames_json IS NOT NULL THEN 'storyboarded' ELSE status END
        WHERE id = ?`,
    )
    .run(projectId);
}

interface OwnedGen {
  id: string;
  project_id: string;
  version: number;
  feedback_id: string | null;
  status: string;
}

/** Генерация через JOIN к владельцу проекта — genId-роуты не обходят тенантность. */
function getOwnedGeneration(req: FastifyRequest, genId: string): OwnedGen | undefined {
  if (!req.user) return undefined;
  return getDb()
    .prepare(
      `SELECT g.id, g.project_id, g.version, g.feedback_id, g.status
         FROM generations g JOIN projects p ON p.id = g.project_id
        WHERE g.id = ? AND p.user_id = ?`,
    )
    .get(genId, req.user.id) as OwnedGen | undefined;
}

function fieldValue(fields: unknown, name: string): string {
  const f = (fields as Record<string, { value?: unknown } | undefined>)?.[name];
  return typeof f?.value === 'string' ? f.value : '';
}

let ffmpegOk: boolean | null = null;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  registerAuthRoutes(app);
  registerModelRoutes(app);
  registerBillingRoutes(app);
  registerAdminRoutes(app);

  // Юридические страницы: серверный HTML вне SPA (явный роут выигрывает у fallback-а)
  app.get('/legal/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const html = renderLegalPage(slug);
    if (!html) return bad(reply, 404, 'Страница не найдена');
    reply.type('text/html; charset=utf-8');
    return reply.send(html);
  });

  // Публичный health минимален (аноним видит только «жив + версия + имя auth-бота»);
  // операторские поля (модель/диск/ключи) — владельцу.
  app.get('/api/health', async (req): Promise<HealthInfo> => {
    const base: HealthInfo = {
      ok: true,
      version: config.version,
      tgBot: config.telegramBotName || null,
      devAuth: config.devAuthBypass && !config.isProduction,
    };
    if (req.user?.role !== 'owner') return base;
    if (ffmpegOk === null) ffmpegOk = await ffmpegAvailable();
    const dataBytes = dataUsageBytes();
    return {
      ...base,
      provider: config.llmProvider,
      model: llmModelName(),
      keyPresent: llmKeyPresent(),
      ffmpeg: ffmpegOk,
      dataBytes,
      storageCapBytes: config.storageCapBytes,
      diskUsedPct: Math.round((dataBytes / config.storageCapBytes) * 100),
    };
  });

  // ── Цены и расход (USD оператора — только владельцу) ─────────────────────

  app.get('/api/pricing', { preHandler: requireOwner }, async (): Promise<PricingInfo> => {
    const balanceUsd = await getBalanceCached();
    const dates = pricingDates();
    return {
      balanceUsd,
      litellmFetchedAt: dates.litellm,
      wavespeedFetchedAt: dates.wavespeed,
    };
  });

  app.get('/api/usage/summary', { preHandler: requireOwner }, async (req, reply) => {
    const q = (req.query ?? {}) as { month?: string };
    const month = q.month ?? new Date().toISOString().slice(0, 7);
    try {
      return monthSummary(month);
    } catch (e) {
      return bad(reply, 400, e instanceof Error ? e.message : String(e));
    }
  });

  app.get('/api/projects/:id/estimate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    try {
      const est = await buildEstimate(p);
      // Не-владельцу — только итоговая пользовательская цена, без себестоимости оператора.
      return req.user!.role === 'owner' ? est : toUserEstimate(est, req.user!.id);
    } catch (e) {
      return bad(reply, 502, `Смета недоступна: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // ── Проекты ──────────────────────────────────────────────────────────────

  app.post('/api/projects', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    // Анти-абьюз не-владельца: персональный кап хранилища + дневной кап проектов.
    // Проверки ДО чтения файла — не принимаем сотни МБ ради отказа.
    if (req.user!.role !== 'owner') {
      if (userUsageBytes(req.user!.id) >= config.userStorageCapBytes) {
        return bad(
          reply,
          413,
          `Твоё хранилище заполнено (${Math.round(config.userStorageCapBytes / 1024 ** 3)} ГБ) — удали старые проекты в Библиотеке`,
        );
      }
      const lim = consumeDailyLimit(req.user!.id, 'projects', config.limitProjectsPerDay);
      if (!lim.allowed) return bad(reply, 429, `${LIMIT_MESSAGE} (проектов сегодня: ${lim.count})`);
    }
    const part = await req.file();
    if (!part) return bad(reply, 400, 'Нет файла — приложи ролик (mp4/mov)');
    const ext = VIDEO_MIME[part.mimetype];
    if (!ext) {
      part.file.resume(); // дочитать стрим, иначе сокет рвётся до отправки ответа
      return bad(reply, 415, `Неподдерживаемый тип видео: ${part.mimetype}. Нужен mp4 или mov`);
    }

    const id = randomUUID();
    ensureProjectDirs(id);
    const videoFile = `source${ext}`;
    const dest = path.join(projectDir(id), videoFile);
    try {
      await streamPipeline(part.file, fs.createWriteStream(dest));
      if (part.file.truncated) {
        deleteProjectFiles(id);
        return bad(reply, 413, `Видео больше лимита ${Math.round(config.maxVideoBytes / 1024 ** 2)} МБ`);
      }
      const meta = await probe(dest).catch((e: Error) => {
        throw new Error(`Не удалось прочитать видео: ${e.message}`);
      });
      if (meta.durationSec > 60) {
        deleteProjectFiles(id);
        return bad(reply, 422, `Ролик ${Math.round(meta.durationSec)}с — слишком длинный. Seedance работает с 4–15 с, обрежь до ≤60 с`);
      }
      const title = fieldValue(part.fields, 'title') || part.filename || 'Без названия';
      getDb()
        .prepare(
          `INSERT INTO projects (id, title, status, video_file, video_bytes, meta_json, user_id)
           VALUES (?, ?, 'uploaded', ?, ?, ?, ?)`,
        )
        .run(id, title.slice(0, 200), videoFile, meta.sizeBytes, JSON.stringify(meta), req.user!.id);
      startStoryboard(id);
      const { purged } = enforceStorageCap();
      if (purged.length) app.log.info({ purged }, 'ротация: удалены исходники старых проектов');
      invalidateUserUsage(req.user!.id);
      return { id };
    } catch (e) {
      deleteProjectFiles(id);
      getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
      return bad(reply, 422, e instanceof Error ? e.message : String(e));
    }
  });

  app.get('/api/projects', async (req) => {
    const rows = getDb()
      .prepare(`SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`)
      .all(req.user!.id) as unknown as DbProject[];
    return rows.map(toSummary);
  });

  app.get('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    const full = toFull(p);
    // Не-владельцу USD не существует: счётчики нулятся, из генераций вычищаются
    // цены провайдеров; вместо них — пользовательский резерв в USD (спишется по факту)
    if (req.user!.role !== 'owner') {
      full.costs = {
        projectUsd: 0,
        activeRun: null,
        heldUsd: (openHoldForProject(id)?.credits ?? 0) / 100 || null,
      };
      full.generations = full.generations.map((g) => ({
        ...g,
        costEst: null,
        costActualUsd: null,
        costSource: null,
      }));
    }
    return full;
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Дождись окончания текущей задачи');
    if (projectHasActiveGeneration(id)) {
      return bad(reply, 409, 'Идёт рендер этого проекта — дождись окончания');
    }
    // queued-задачи проекта отменяются каскадом, резерв возвращается ДО удаления строк
    cancelQueuedForProject(id);
    releaseHoldForDeletedProject(id);
    getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    deleteProjectFiles(id);
    invalidateUserUsage(req.user!.id);
    return { ok: true };
  });

  // ── Пресеты референсов ───────────────────────────────────────────────────

  app.get('/api/presets', async () => {
    return PRESETS.map((p) => ({
      id: p.id,
      title: p.title,
      hint: p.hint,
      refs: p.refs.map((r) => ({ role: r.role, note: r.note })),
      thumb: `api/presets/${p.id}/file/${p.refs[0]!.file}`,
    }));
  });

  app.get('/api/presets/:id/file/:file', async (req, reply) => {
    const { id, file } = req.params as { id: string; file: string };
    const preset = getPreset(id);
    const full = preset ? presetFilePath(preset, file) : null;
    if (!full) return bad(reply, 404, 'Файл пресета не найден');
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.type(MEDIA_CT[path.extname(full).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(full));
  });

  // ── One-click свап и рендеры ─────────────────────────────────────────────

  app.post('/api/projects/:id/swap', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    const { id } = req.params as { id: string };
    let p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    // Занятый ЧУЖИМ рендером слот больше не отбивает: свап дойдёт до рендера и встанет
    // в FIFO-очередь. Блокируем только повторный запуск ЭТОГО проекта.
    if (projectHasActiveGeneration(id) || projectHasQueuedGeneration(id)) {
      return bad(reply, 409, 'Рендер этого проекта уже идёт или в очереди — дождись');
    }
    if (!p.video_file || p.video_purged === 1) {
      return bad(reply, 409, 'Исходник очищен ротацией — залей ролик заново');
    }
    if (!llmKeyPresent()) return bad(reply, 503, 'LLM-ключ не настроен на сервере');

    const body = (req.body ?? {}) as {
      flags?: { removeText?: boolean; enhanceFigure?: boolean };
      generateAudio?: boolean;
      lang?: string;
      confirmUnknownCost?: boolean;
      /** v4: пожелания к ролику (подчинены доктрине; лучше не использовать — менее стабильно). */
      wish?: string;
      /** v4: кнопка-вариант модели пользователя. */
      variantId?: string;
      /** legacy-алиас захардкоженных пресетов (уходит после чекпоинта этапа 1). */
      preset?: string;
      /** Явное решение продолжить при предупреждениях (blocker этим не обходится). */
      confirmReferenceRisks?: boolean;
    };

    // Кнопка модели: подкладываем реф-листы варианта в чистый проект — дальше всё как обычно
    if (body.variantId) {
      try {
        applyModelVariant(req.user!.id, id, body.variantId);
        invalidateReferenceAnalysis(id);
        p = getOwnedProject(req, id)!;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return bad(reply, msg.includes('не найдена') ? 404 : 409, msg);
      }
    } else if (body.preset) {
      const preset = getPreset(body.preset);
      if (!preset) return bad(reply, 404, 'Неизвестный пресет');
      try {
        applyPreset(id, preset);
        invalidateReferenceAnalysis(id);
        p = getOwnedProject(req, id)!;
      } catch (e) {
        return bad(reply, 409, e instanceof Error ? e.message : String(e));
      }
    }

    const hasModelRef = getDb()
      .prepare(`SELECT 1 FROM refs WHERE project_id = ? AND role = 'model' LIMIT 1`)
      .get(id);
    if (!hasModelRef) return bad(reply, 409, 'Нужен хотя бы один референс с ролью «модель»');

    // Аудит идёт до промтов/рендера. Blocker непреодолим, warning требует отдельного
    // решения пользователя; оба пути происходят ДО нового денежного резерва.
    let analysis = p.analysis_json ? (JSON.parse(p.analysis_json) as Analysis) : null;
    const auditPause = referenceAuditPause(analysis);
    if (analysis?.referenceAudit && auditPause === 'blocked') {
      return bad(reply, 409, referenceAuditMessage(analysis.referenceAudit, auditPause));
    }
    if (analysis?.referenceAudit && auditPause === 'review') {
      if (!body.confirmReferenceRisks) {
        return bad(reply, 409, referenceAuditMessage(analysis.referenceAudit, auditPause));
      }
      analysis = {
        ...analysis,
        referenceAudit: { ...analysis.referenceAudit, accepted: true },
      };
      const json = JSON.stringify(analysis);
      getDb().prepare(`UPDATE projects SET analysis_json = ?, error = NULL WHERE id = ?`).run(json, id);
      p = { ...p, analysis_json: json, error: null };
    }
    // Звук: если тело его не прислало — берём сохранённую настройку проекта («под капотом»),
    // а не дефолт: иначе свежий PATCH затирался бы протухшим значением из UI
    const flagsJson = JSON.stringify({
      removeText: !!body.flags?.removeText,
      enhanceFigure: !!body.flags?.enhanceFigure,
      wish: typeof body.wish === 'string' ? body.wish.trim().slice(0, 500) : '',
      generateAudio:
        body.generateAudio === undefined ? parseGenerateAudio(p.flags_json) : !!body.generateAudio,
    });

    // Гвард запуска по деньгам: смета WaveSpeed против живого баланса ОПЕРАТОРА
    // (работает для всех: пустой баланс сервиса не запускает даже богатого кредитами).
    // Тексты для не-владельца — без USD.
    const isOwner = req.user!.role === 'owner';
    const draft = { ...p, flags_json: flagsJson };
    const est = await buildEstimate(draft);
    if (est.wavespeed.usd === null) {
      if (!isOwner) {
        return bad(reply, 409, 'Смета временно недоступна — попробуй чуть позже');
      }
      if (!body.confirmUnknownCost) {
        return bad(reply, 409, `Оценка WaveSpeed недоступна (${est.wavespeed.unavailableReason ?? '?'}) — подтверди запуск явно`);
      }
    } else if (est.balanceUsd !== null && est.wavespeed.usd > est.balanceUsd - 0.05) {
      return bad(
        reply,
        409,
        isOwner
          ? `Не хватает баланса WaveSpeed: рендер ≈ $${est.wavespeed.usd.toFixed(2)}, на счету $${est.balanceUsd.toFixed(2)} — пополни и жми ещё раз`
          : 'Рендер временно недоступен — попробуй позже, деньги не списаны',
      );
    }

    // Решаем, что запустим, ДО кредитного резерва: failed-ветка ниже возвращает 409
    // без запуска работы — резерв там ставить нельзя (иначе кредиты повиснут, F1).
    const snap = snapshotProject({ ...p, flags_json: flagsJson });
    const stage = nextStageOf(snap);
    if (stage === 'done' && snap.latestGenStatus !== 'done') {
      // failed: авто-пересабмит запрещён (деньги) — направляем к безопасным кнопкам
      return bad(
        reply,
        409,
        'Рендер этой версии уже падал — в карточке ролика жми «Проверить ещё раз» (бесплатно) или «Повторить рендер»',
      );
    }

    // Кредитный резерв не-владельца на ВЕСЬ флоу (перечитка баланса — внутри sync-транзакции)
    if (!isOwner) {
      const holdCredits = priceCredits(est.totalUsd ?? est.wavespeed.usd ?? 0);
      const hold = placeHold(req.user!.id, id, holdCredits);
      if (!hold.ok) {
        return bad(
          reply,
          402,
          `Нужно $${(hold.needCredits / 100).toFixed(2)}, на балансе $${(hold.availableCredits / 100).toFixed(2)}`,
        );
      }
    }

    getDb()
      .prepare(
        `UPDATE projects SET flags_json = ?, flow = 'auto', flow_started_at = datetime('now'), error = NULL WHERE id = ?`,
      )
      .run(flagsJson, id);

    // Повторный свап при готовом рендере ('done') — прямой рендер; иначе весь флоу.
    // Если запуск рендера отбит гейтом — возвращаем резерв (работа не пошла, F1).
    if (stage === 'done') {
      try {
        startRender(id, snap.latestVersion);
      } catch (e) {
        // рендер так и не стартовал (гейт/гонка) — возвращаем весь резерв
        forceReleaseProjectHold(id, undefined, 'запуск рендера отклонён');
        if (e instanceof RenderGateError) return bad(reply, e.httpStatus, e.message);
        throw e;
      }
    } else {
      advanceFlow(id);
    }
    return { ok: true, estimate: isOwner ? est : toUserEstimate(est, req.user!.id) };
  });

  // Точечное обновление флагов без запуска (сейчас — режим звука «под капотом»)
  app.patch('/api/projects/:id/flags', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    const body = (req.body ?? {}) as { generateAudio?: boolean };
    if (typeof body.generateAudio !== 'boolean') return bad(reply, 400, 'Нечего обновлять');
    let current: Record<string, unknown> = {};
    try {
      current = p.flags_json ? (JSON.parse(p.flags_json) as Record<string, unknown>) : {};
    } catch {
      /* кривой JSON перезапишем */
    }
    getDb()
      .prepare(`UPDATE projects SET flags_json = ? WHERE id = ?`)
      .run(JSON.stringify({ ...current, generateAudio: body.generateAudio }), id);
    return { ok: true };
  });

  app.post('/api/projects/:id/generations', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    const body = (req.body ?? {}) as { version?: number };
    const version = body.version ?? snapshotProject(p).latestVersion;
    if (!version) return bad(reply, 409, 'Сначала сгенерируй промты');
    try {
      const genId = startRender(id, version);
      return { id: genId };
    } catch (e) {
      if (e instanceof RenderGateError) return bad(reply, e.httpStatus, e.message);
      throw e;
    }
  });

  app.post('/api/generations/:genId/retry', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    const { genId } = req.params as { genId: string };
    if (!getOwnedGeneration(req, genId)) return bad(reply, 404, 'Генерация не найдена');
    try {
      return { id: await retryGeneration(genId) };
    } catch (e) {
      if (e instanceof RenderGateError) return bad(reply, e.httpStatus, e.message);
      throw e;
    }
  });

  // Отмена своей задачи из FIFO-очереди: резерв возвращается, очередь едет дальше
  app.post('/api/generations/:genId/cancel-queue', async (req, reply) => {
    const { genId } = req.params as { genId: string };
    if (!getOwnedGeneration(req, genId)) return bad(reply, 404, 'Генерация не найдена');
    if (!cancelQueued(genId)) return bad(reply, 409, 'Задача уже не в очереди');
    promoteNext();
    return { ok: true };
  });

  app.post('/api/generations/:genId/recheck', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    const { genId } = req.params as { genId: string };
    if (!getOwnedGeneration(req, genId)) return bad(reply, 404, 'Генерация не найдена');
    try {
      const status = await recheckGeneration(genId);
      return { status };
    } catch (e) {
      if (e instanceof RenderGateError) return bad(reply, e.httpStatus, e.message);
      return bad(reply, 502, e instanceof Error ? e.message : String(e));
    }
  });

  app.post('/api/generations/:genId/rating', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    const { genId } = req.params as { genId: string };
    const db = getDb();
    const gen = getOwnedGeneration(req, genId);
    if (!gen) return bad(reply, 404, 'Генерация не найдена');
    if (gen.status !== 'done') return bad(reply, 409, 'Оценивать можно только готовый ролик');
    const body = (req.body ?? {}) as { rating?: number; artifacts?: string[]; notes?: string };
    const rating = body.rating === 1 ? 1 : body.rating === -1 ? -1 : null;
    if (rating === null) return bad(reply, 400, 'rating должен быть 1 или -1');
    const artifacts = (body.artifacts ?? []).filter((a): a is ArtifactType =>
      (ARTIFACT_TYPES as string[]).includes(a),
    );
    const notes = (body.notes ?? '').slice(0, 2000);

    // Зеркало в feedback: UPDATE-in-place, чтобы флип 👍→👎 не оставлял мусор в few-shot
    let feedbackId = gen.feedback_id;
    if (feedbackId) {
      db.prepare(`UPDATE feedback SET worked = ?, artifacts_json = ?, notes = ? WHERE id = ?`).run(
        rating === 1 ? 1 : 0,
        JSON.stringify(artifacts),
        notes,
        feedbackId,
      );
    } else {
      feedbackId = randomUUID();
      db.prepare(
        `INSERT INTO feedback (id, project_id, version, worked, artifacts_json, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(feedbackId, gen.project_id, gen.version, rating === 1 ? 1 : 0, JSON.stringify(artifacts), notes);
    }
    db.prepare(
      `UPDATE generations SET rating = ?, artifacts_json = ?, notes = ?, feedback_id = ? WHERE id = ?`,
    ).run(rating, JSON.stringify(artifacts), notes, feedbackId, genId);
    return { ok: true };
  });

  // ── Референсы ────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/refs', async (req, reply) => {
    if (crossSite(req)) return bad(reply, 403, 'Кросс-сайтовый запрос отклонён');
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id) || projectHasActiveGeneration(id) || projectHasQueuedGeneration(id)) {
      return bad(reply, 409, 'Дождись окончания текущей задачи, затем меняй референсы');
    }
    if (req.user!.role !== 'owner' && userUsageBytes(req.user!.id) >= config.userStorageCapBytes) {
      return bad(reply, 413, 'Твоё хранилище заполнено — удали старые проекты в Библиотеке');
    }
    const part = await req.file({ limits: { fileSize: config.maxImageBytes } });
    if (!part) return bad(reply, 400, 'Нет файла референса');
    const ext = IMAGE_MIME[part.mimetype];
    if (!ext) {
      part.file.resume();
      return bad(reply, 415, `Референс должен быть jpg/png/webp, а не ${part.mimetype}`);
    }
    const roleField = fieldValue(part.fields, 'role') || 'auto';
    if (!['auto', 'model', 'vehicle', 'object'].includes(roleField)) {
      part.file.resume();
      return bad(reply, 400, 'Неизвестная роль');
    }
    const note = fieldValue(part.fields, 'note').slice(0, 300);

    const refId = randomUUID();
    const file = `ref_${refId.slice(0, 8)}${ext}`;
    const dest = path.join(refsDir(id), file);
    try {
      await streamPipeline(part.file, fs.createWriteStream(dest));
    } catch (e) {
      fs.rmSync(dest, { force: true }); // оборванная загрузка не оставляет сирот
      throw e;
    }
    if (part.file.truncated) {
      fs.rmSync(dest, { force: true });
      return bad(reply, 413, `Фото больше лимита ${Math.round(config.maxImageBytes / 1024 ** 2)} МБ`);
    }
    const db = getDb();

    invalidateUserUsage(req.user!.id);

    // роль: явная от пользователя → vision-классификатор → позиционная эвристика
    let role = roleField;
    let roleSource: 'manual' | 'auto' | 'heuristic' = 'manual';
    let autoNote = '';
    if (roleField === 'auto') {
      // кап платного vision-классификатора; превышение = тихий фолбэк на эвристику
      const classifyAllowed =
        req.user!.role === 'owner' ||
        consumeDailyLimit(req.user!.id, 'classify', config.limitClassifyPerDay).allowed;
      const cls = classifyAllowed ? await classifyRef(id, file) : null;
      if (cls) {
        role = cls.role;
        roleSource = 'auto';
        autoNote = cls.note;
      } else {
        const have = db
          .prepare(
            `SELECT SUM(role = 'model') AS m, SUM(role = 'vehicle') AS v FROM refs WHERE project_id = ?`,
          )
          .get(id) as { m: number | null; v: number | null };
        role = !have.m ? 'model' : !have.v ? 'vehicle' : 'object';
        roleSource = 'heuristic';
      }
    }

    const maxIdx = db
      .prepare(`SELECT COALESCE(MAX(idx), -1) AS m FROM refs WHERE project_id = ?`)
      .get(id) as { m: number };
    db.prepare(
      `INSERT INTO refs (id, project_id, idx, role, file, note, role_source, auto_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(refId, id, maxIdx.m + 1, role, file, note, roleSource, autoNote);
    invalidateReferenceAnalysis(id);
    return { id: refId, file, role, roleSource };
  });

  app.patch('/api/projects/:id/refs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id) || projectHasActiveGeneration(id) || projectHasQueuedGeneration(id)) {
      return bad(reply, 409, 'Дождись окончания текущей задачи, затем меняй референсы');
    }
    const body = (req.body ?? {}) as {
      order?: string[];
      updates?: Array<{ id: string; role?: string; note?: string }>;
    };
    const db = getDb();
    if (Array.isArray(body.order)) {
      const upd = db.prepare(`UPDATE refs SET idx = ? WHERE id = ? AND project_id = ?`);
      body.order.forEach((refId, i) => upd.run(i, refId, id));
    }
    for (const u of body.updates ?? []) {
      if (u.role && ['model', 'vehicle', 'object'].includes(u.role)) {
        // выбранная руками роль — финальная: классификатор её больше не перетирает
        db.prepare(
          `UPDATE refs SET role = ?, role_source = 'manual' WHERE id = ? AND project_id = ?`,
        ).run(u.role, u.id, id);
      }
      if (typeof u.note === 'string') {
        db.prepare(`UPDATE refs SET note = ? WHERE id = ? AND project_id = ?`).run(
          u.note.slice(0, 300),
          u.id,
          id,
        );
      }
    }
    if ((body.order?.length ?? 0) > 0 || (body.updates?.length ?? 0) > 0) {
      invalidateReferenceAnalysis(id);
    }
    return { ok: true };
  });

  app.delete('/api/projects/:id/refs/:refId', async (req, reply) => {
    const { id, refId } = req.params as { id: string; refId: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id) || projectHasActiveGeneration(id) || projectHasQueuedGeneration(id)) {
      return bad(reply, 409, 'Дождись окончания текущей задачи, затем меняй референсы');
    }
    const db = getDb();
    const ref = db
      .prepare(`SELECT file FROM refs WHERE id = ? AND project_id = ?`)
      .get(refId, id) as { file: string } | undefined;
    if (!ref) return bad(reply, 404, 'Референс не найден');
    db.prepare(`DELETE FROM refs WHERE id = ?`).run(refId);
    fs.rmSync(path.join(refsDir(id), ref.file), { force: true });
    // переупаковка порядка
    const rest = db
      .prepare(`SELECT id FROM refs WHERE project_id = ? ORDER BY idx ASC`)
      .all(id) as Array<{ id: string }>;
    const upd = db.prepare(`UPDATE refs SET idx = ? WHERE id = ?`);
    rest.forEach((r, i) => upd.run(i, r.id));
    invalidateReferenceAnalysis(id);
    return { ok: true };
  });

  // ── Пайплайн ─────────────────────────────────────────────────────────────

  app.post('/api/projects/:id/storyboard', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    if (!p.video_file || p.video_purged === 1)
      return bad(reply, 409, 'Исходное видео недоступно (очищено ротацией)');
    startStoryboard(id);
    return { ok: true };
  });

  app.post('/api/projects/:id/analyze', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    if (!p.frames_json) return bad(reply, 409, 'Сначала должна завершиться раскадровка');
    if (!llmKeyPresent()) return bad(reply, 503, 'LLM-ключ не настроен на сервере');
    if (!manualLlmAllowed(req)) return bad(reply, 429, LIMIT_MESSAGE);
    startAnalysis(id);
    return { ok: true };
  });

  app.post('/api/projects/:id/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    if (!p.analysis_json) return bad(reply, 409, 'Сначала нужен анализ ролика');
    const analysis = JSON.parse(p.analysis_json) as Analysis;
    const auditPause = referenceAuditPause(analysis);
    if (analysis.referenceAudit && auditPause) {
      return bad(reply, 409, referenceAuditMessage(analysis.referenceAudit, auditPause));
    }
    const refCount = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM refs WHERE project_id = ?`)
      .get(id) as { c: number };
    if (refCount.c === 0) return bad(reply, 409, 'Добавь хотя бы один референс (модель)');
    if (!manualLlmAllowed(req)) return bad(reply, 429, LIMIT_MESSAGE);
    const body = (req.body ?? {}) as { lang?: string };
    startGeneration(id, {
      lang: body.lang === 'ru' ? 'ru' : 'en',
      iteration: null,
    });
    return { ok: true };
  });

  app.post('/api/projects/:id/feedback', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    const body = (req.body ?? {}) as {
      version?: number;
      worked?: boolean;
      artifacts?: string[];
      notes?: string;
    };
    if (!body.version) return bad(reply, 400, 'Не указана версия промта');
    const versionExists = getDb()
      .prepare(`SELECT 1 FROM prompts WHERE project_id = ? AND version = ? LIMIT 1`)
      .get(id, body.version);
    if (!versionExists) return bad(reply, 404, 'Версия промта не найдена');
    const artifacts = (body.artifacts ?? []).filter((a): a is ArtifactType =>
      (ARTIFACT_TYPES as string[]).includes(a),
    );
    getDb()
      .prepare(
        `INSERT INTO feedback (id, project_id, version, worked, artifacts_json, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        id,
        body.version,
        body.worked ? 1 : 0,
        JSON.stringify(artifacts),
        (body.notes ?? '').slice(0, 2000),
      );
    return { ok: true };
  });

  app.post('/api/projects/:id/iterate', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (BUSY.has(p.status) || isQueued(id)) return bad(reply, 409, 'Уже идёт задача — подожди');
    const body = (req.body ?? {}) as {
      version?: number;
      artifacts?: string[];
      notes?: string;
      lang?: string;
    };
    if (!body.version) return bad(reply, 400, 'Не указана версия промта');
    const db = getDb();
    const prev = db
      .prepare(`SELECT kind, text, flags_json FROM prompts WHERE project_id = ? AND version = ?`)
      .all(id, body.version) as Array<{ kind: string; text: string; flags_json: string | null }>;
    const prevVideo = prev.find((r) => r.kind === 'video')?.text;
    const prevImage = prev.find((r) => r.kind === 'image')?.text;
    if (!prevVideo || !prevImage) return bad(reply, 404, 'Версия промта не найдена');
    if (!manualLlmAllowed(req)) return bad(reply, 429, LIMIT_MESSAGE);
    const artifacts = (body.artifacts ?? []).filter((a): a is ArtifactType =>
      (ARTIFACT_TYPES as string[]).includes(a),
    );
    const notes = (body.notes ?? '').slice(0, 2000);
    // фидбек «не сработало» фиксируем автоматически
    db.prepare(
      `INSERT INTO feedback (id, project_id, version, worked, artifacts_json, notes)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(randomUUID(), id, body.version, JSON.stringify(artifacts), notes);
    // итерация наследует флаги исходной версии, а не текущие галочки проекта
    const inherited = parseFlags(prev[0]?.flags_json);
    // Галочки проекта синхронизируем с итерируемой версией: иначе advanceFlow увидит
    // несовпадение флагов и молча перегенерирует БЕЗ таргет-фиксов (двойная LLM-трата
    // + рендер обычных промтов вместо итерации). generateAudio не трогаем.
    let curFlags: Record<string, unknown> = {};
    try {
      curFlags = p.flags_json ? (JSON.parse(p.flags_json) as Record<string, unknown>) : {};
    } catch {
      /* кривой JSON перезапишем */
    }
    db.prepare(`UPDATE projects SET flags_json = ? WHERE id = ?`).run(
      JSON.stringify({
        ...curFlags,
        removeText: inherited.removeText,
        enhanceFigure: inherited.enhanceFigure,
        wish: inherited.wish,
      }),
      id,
    );
    startGeneration(id, {
      lang: body.lang === 'ru' ? 'ru' : 'en',
      iteration: { prevVideoPrompt: prevVideo, prevImagePrompt: prevImage, artifacts, notes },
      flagsOverride: inherited,
    });
    return { ok: true };
  });

  // Стартовый кадр по Images API: длинный await прямо в роуте (nginx timeout 300с покрывает)
  app.post('/api/projects/:id/startframe', async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    if (!p.meta_json) return bad(reply, 409, 'Нет метаданных видео');
    const body = (req.body ?? {}) as { version?: number };
    const db = getDb();
    const version =
      body.version ??
      (db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM prompts WHERE project_id = ?`).get(id) as { v: number }).v;
    const promptRow = db
      .prepare(`SELECT text FROM prompts WHERE project_id = ? AND version = ? AND kind = 'image' LIMIT 1`)
      .get(id, version) as { text: string } | undefined;
    if (!promptRow) return bad(reply, 409, 'Сначала сгенерируй промты (нужен imagePrompt)');
    const refs = db
      .prepare(`SELECT id, idx, role, file, note FROM refs WHERE project_id = ? ORDER BY idx ASC`)
      .all(id) as unknown as RefInfo[];
    if (refs.length === 0) return bad(reply, 409, 'Нет референсов');
    if (!manualLlmAllowed(req)) return bad(reply, 429, LIMIT_MESSAGE);
    try {
      const file = await generateStartFrame(id, version, promptRow.text, refs, JSON.parse(p.meta_json));
      return { file, version };
    } catch (e) {
      return bad(reply, 502, e instanceof Error ? e.message : String(e));
    }
  });

  // ── Медиа ────────────────────────────────────────────────────────────────

  app.get('/api/projects/:id/media/:sub/:file', async (req, reply) => {
    const { id, sub, file } = req.params as { id: string; sub: string; file: string };
    const p = getOwnedProject(req, id);
    if (!p) return bad(reply, 404, 'Проект не найден');
    let full: string | null = null;
    if (sub === 'frames' || sub === 'refs' || sub === 'start' || sub === 'renders') {
      full = safeMediaPath(id, sub, file);
    } else if (sub === 'src' && p.video_file && file === p.video_file) {
      full = safeMediaPath(id, '.', file);
    }
    if (!full) return bad(reply, 404, 'Файл не найден');
    const ct = MEDIA_CT[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('Accept-Ranges', 'bytes');
    reply.type(ct);

    // Range — чтобы <video> умел перемотку и не ждал полной догрузки исходника
    const size = fs.statSync(full).size;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2]!, 10));
        const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
        if (start <= end && start < size) {
          reply.code(206);
          reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
          reply.header('Content-Length', end - start + 1);
          return reply.send(fs.createReadStream(full, { start, end }));
        }
        reply.header('Content-Range', `bytes */${size}`);
        return reply.code(416).send();
      }
    }
    reply.header('Content-Length', size);
    return reply.send(fs.createReadStream(full));
  });
}

export type { FastifyRequest };
