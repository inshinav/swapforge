# Carousel Studio — PLAN (чекбоксы = правда только после верификации по репо)

> Источник истины по продукту — `SPEC.md`. Этот файл — исполнение.

## Протокол сборки (обязателен, переживает лимиты/крэши)

- Ветка `feature/carousel-studio`. Одна задача = один коммит `feat(carousel): ...`.
- После каждой задачи: прогнать её check → тикнуть чекбокс здесь → дописать в `PROGRESS.md`:
  hash коммита + `NEXT: <точное следующее действие, написанное для холодного старта с нулевой памятью>`.
- Никогда не заканчивать ответ с незакоммиченными изменениями; если сессия может умереть —
  `wip(carousel): checkpoint` + NEXT.
- Каждый старт сессии: прочитать PLAN/PROGRESS, `git status`/`git log`, верифицировать по репо,
  что последняя тикнутая задача РЕАЛЬНО сделана (доверять репо, не чекбоксу), отчёт ≤5 строк,
  продолжать с первой нетикнутой.
- Базовый check: `npm run typecheck && npm run test -w server` (+`-w web` для UI-задач).
  Гейт фазы: `npm run typecheck && npm run lint && npm run test && npm run build`.
  Существующий suite зелёный после каждого коммита — гарантия «ноль изменений видео-путей».

## P0 Foundation

- [x] P0.1 Ветка + docs `SPEC.md`/`PLAN.md`/`PROGRESS.md` — done: файлы в репо — check: файлы + git log.
- [x] P0.2 config.ts: флаги `carouselStudio`/`carouselOwnerOnly`, `APIFY_TOKEN`, `CAROUSEL_IMAGE_MODEL`
      (default = openaiImageModel), `CAROUSEL_CONCURRENCY=2`, `CAROUSEL_MAX_SLIDES=10`,
      `CAROUSEL_SLIDE_SIZE=1024x1280`, `CAROUSEL_REVIEW_TTL_H=24`, `LIMIT_CAROUSELS_PER_DAY`,
      `LIMIT_MINER_PER_DAY`, `MINER_RUN_COST_USD_PER_100`, QC-пороги — done: дефолты выкл/консервативные,
      существующие ключи не тронуты — check: typecheck + suite.
- [x] P0.3 db.ts applySchema: `carousel_projects`, `carousel_slides`, `pattern_cards` (прямой FK на
      `collections`), `mining_runs` + индексы (только CREATE IF NOT EXISTS) — done: бут создаёт,
      существующее нетронуто — check: новый db-тест + suite.
- [x] P0.4 shared/carousel.ts: статусы, DTO, zod+JSON Schema (dual) Idea/Storyboard/Caption/QC/PatternCard —
      done: схемы валидируют фикстуры — check: unit.
- [x] P0.5 server/src/image/provider.ts: интерфейс `ImageProvider.edit(...)` + `getImageProvider()` +
      mock-провайдер — done: mock гоняется в тестах — check: unit.
- [x] P0.6 Гейт: `carouselId` в meta (llm/provider.ts) + ветка в `requireActiveAttempt` (+сверка
      hold.user_id===carousel.user_id) + маппинг `meta.carouselId→projectId` в recordUsage-вызовах
      openai.ts/anthropic.ts — done: старое поведение неизменно (suite), новая ветка fail-closed —
      check: тесты гейта (owner/no-hold/open-hold/чужой hold) + ПОЛНЫЙ suite.
- [x] P0.G Гейт фазы: typecheck+lint+test(312 server/12 web)+build — зелёные.

## P1 Image pipeline core

- [x] P1.1 engine/carousel/blocks.ts: UGC-блоки raw/casual/polished, anti-artifact guardrails,
      identity-блок, format-блок (+RETRY_BOOST) — check: snapshot-тесты.
- [x] P1.2 engine/carousel/locations.ts: LocationPack тип + Miami (12 сцен EN) — done: zod-валидация
      всех сцен — check: unit.
- [x] P1.3 engine/carousel/prompt.ts: `buildSlidePrompt(...)` детерминированная EN-сборка + word-cap —
      check: snapshot-тесты.
- [x] P1.4 image/openai.ts: edits по образцу startframe (toFile, input_fidelity high + фолбэк,
      СВОЯ carousel-лестница модерации + `isModerationRefusal`, size-гард `imageModelFlexible` →
      1024×1536+кроп), `recordUsage({task:'carousel_slide', generationId: slideId, projectId:
      carouselId, userId})` — done: инжект-клиент, юниты ретраи/модерация/size — check: unit.
- [x] P1.5 engine/carousel/generate.ts: anchor-цепочка (слайд 1 → QC → anchor; 2..N с anchor),
      пер-слайд чекпоинты, резюм-безопасность (+carousel dir-хелперы storage.ts) — done: mock-E2E
      все статусы — check: unit.
- [x] P1.6 engine/carousel/qc.ts: vision-QC (schemaName `carousel_qc`), пороги из config, вердикты
      порогами (sceneMatch мягкий); все вызовы с meta.generationId=slideId + userId — check: unit.
- [x] P1.G Гейт фазы: typecheck+lint+test(339 server/12 web)+build — зелёные.

## P2 Job E2E + billing

- [x] P2.1 pricing: SEED_TOKENS.carousel_* (5 задач) + taskModel + **ourModels()** (аддитивно) +
      engine/carousel/pricing.ts `buildCarouselQuote` — done: смета детерминирована,
      priceForCached(carouselModel)!==null — check: unit.
- [x] P2.2 engine/carousel/billing.ts: quote-снапшот; placeHold с правилом **reused→409**; settle по
      id-атрибуции (минус failed/moderated; кап=hold; settleHold с опц. note); releaseHold(0) при
      нуле успешных; reconcileCarouselHolds() по матрице §7 — done: юниты успех/частичный/полный
      fail/крэш/reused/double-click — check: unit.
- [x] P2.3 engine/carousel/worker.ts: FIFO-клейм (глобальный кап, пер-юзер 1), статус-машина,
      resumeCarousels() в index.ts — done: тесты порядка и резюма — check: unit.
- [x] P2.4 storage.ts (аддитивно): carouselDir/ensure/safe-path, userUsageBytes, эвикция в
      cleanupStorageLifecycle + транзиент-свип — check: unit + storage-suite.
- [x] P2.5 routes-carousel.ts v1: CRUD, quote, start (прекол openHoldForProject→409 + hold), status,
      файлы; регистрация за флагом — done: inject-тесты CRUD/tenancy(чужое→404)/CSRF/флаг-выкл→404/409 —
      check: unit.
- [x] P2.6 Финализация ffmpeg: lanczos → 1080×1350 / 1080×1080 sRGB — check: unit (ffmpegAvailable-гард).
- [x] P2.G Гейт фазы: полный typecheck+lint+test+build.

## P3 Движки

- [x] P3.1 engine/carousel/ideas.ts + POST .../ideas (микро-hold: quote→hold(reused→409)→вызов→settle;
      ревизия reconcileCarouselHolds под утёкшие идеация-холды) — done: mock-LLM + billing-юнит
      микро-цикла (крэш между hold и settle → бут-чистка) — check: unit.
- [x] P3.2 engine/carousel/storyboard.ts + ген/PATCH-правки — check: unit.
- [x] P3.3 engine/carousel/caption.ts + роут (+реген) — check: unit.
- [x] P3.4 few-shot слот PatternCards в ideas/storyboard (интерфейс, пока пусто) — check: snapshot.

## P4 Web UI

- [x] P4.1 Флаг в HealthInfo→App.tsx: view 'carousel', пункт «Карусели» (MobileNav+TabBtn), скрыт без
      флага, **#carousel-хэш тоже гейтится** — check: App.test + -w web.
- [x] P4.2 screens/Carousel.tsx: список + создание (модель/вариант); loading/empty/error — check: web unit.
- [x] P4.3 Мастер: идеи (цена на кнопке) → выбор → редактор раскадровки → квота+старт
      (shortfall→onOpenBilling) — check: web unit.
- [x] P4.4 Прогресс: поллинг-хук (клон useProject), пер-слайд стэппер, QC-бейджи, needs_review
      (принять/ретрай K=2), частичные исходы — check: web unit.
- [x] P4.5 Результат: галерея, подпись (копия), заглушки экспорт/TG (активация в P6) — check: web unit.
- [x] P4.G Гейт фазы: полный прогон + локальный E2E на dev-сервере с mock-провайдером (preview-браузер).

## P5 Reference Miner

- [x] P5.1 server/src/apify.ts: createApify({fetchImpl}) по шаблону wavespeed (run→poll→dataset) —
      check: unit (fake fetch).
- [x] P5.2 mining run: mining_runs строка, воркер с персистом apify_run_id, resume, hold/settle
      (reused→409); seed v1 = только аккаунты — check: unit.
- [x] P5.3 engine/miner/virality.ts: чистый фильтр (ER/likes/свежесть/топ-N) — check: табличные тесты.
- [x] P5.4 engine/miner/patterns.ts: vision→PatternCard (структура-only, запрет уникальных деталей,
      подписи источника вне контекста), thumb-кэш TTL — check: unit.
- [x] P5.5 Роуты подборок: CRUD, mine (лимит+hold), лента — inject-тесты tenancy/лимитов — check: unit.
- [x] P5.6 UI «Подборки»: запуск (цена), лента PatternCards (thumb+атрибуция), «Использовать в идеях» —
      check: web unit.
- [x] P5.7 Легальные гарды кодом: reject mined-путей в генерации (unit доказывает), caption-изоляция —
      check: unit.

## P6 Экспорт и Telegram

- [ ] P6.1 zip-store.ts (STORED, без deps) + GET .../export.zip — done: тест распаковывает и сверяет —
      check: unit.
- [ ] P6.2 telegram/notify.ts (sendMediaGroup 2–10 / sendPhoto-фолбэк / sendChatAction-прекол,
      403→RU-подсказка) + «В Telegram» + уведомление о готовности — check: unit (fake fetch).

## P7 Hardening & launch

- [ ] P7.1 Дневные лимиты (kinds carousel/miner) + admin-сводка + carousel-aware порог алерта холдов —
      check: unit.
- [ ] P7.2 Раздел в гайде (RU) + легал-примечание про майнинг — check: build.
- [ ] P7.3 E2E-смоук в preview-браузере на mock-провайдере, фиксы — check: ручной прогон.
- [ ] P7.4 Финал: typecheck+lint+test+build + `bash deploy/launch-gate.sh`, PROGRESS финал,
      план включения флага (owner-only → все) — check: команды зелёные.
