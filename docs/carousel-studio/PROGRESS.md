# Carousel Studio — PROGRESS

> Формат записи: `дата — Px.y — <commit hash> — что сделано (1 строка)`; внизу файла — ровно один
> актуальный `NEXT: <точное следующее действие для холодного старта с нулевой памятью>`.
> Правила чтения на старте сессии — в PLAN.md «Протокол сборки».

---

- 2026-07-23 — P0.1 — bda7a90 — ветка feature/carousel-studio, материализованы SPEC/PLAN/PROGRESS из утверждённого плана.
- 2026-07-23 — P0.2 — bd0a44a — config.ts: карусельная секция env-ключей (флаг выкл по умолчанию); suite 292/292.
- 2026-07-23 — P0.3 — c25d309 — db.ts: 5 таблиц + индексы (pattern_cards прямой FK, SPEC §8 обновлён); тест carousel-db; suite 297/297. Правило: git add только явные пути.
- 2026-07-23 — P0.4 — b2fd2f2 — shared/carousel.ts: статусы=CHECK БД, CAROUSEL_TASKS, dual-схемы 5 движков + DTO; suite 301/301.
- 2026-07-23 — P0.5 — 1ea6208 — image/{provider,mock} + config.carouselImageProvider (mock = дев-E2E без трат); suite 305/305.
- 2026-07-23 — P0.6 — deffc7a — гейт: carouselId-ветка requireActiveAttempt (fail-closed, чужая hold отвергается), meta.carouselId в llm-слое, маппинг в recordUsage импелов; 7 тестов. ГЕЙТ ФАЗЫ 0: 312 server + 12 web + lint + build.
- 2026-07-23 — P1.1 — c0dae1e — blocks.ts: UGC-пресеты/гардрейлы/identity/anchor/product/format + карусельная лестница модерации; снапшоты.
- 2026-07-23 — P1.2 — 7981910 — locations.ts: Miami-пак 12 сцен как данные (zod), реестр.
- 2026-07-23 — P1.3 — 8f8dc6a — prompt.ts: детерминированный сборщик, нумерация рефов = порядок массива, мягкий кап 260.
- 2026-07-23 — P1.4 — 7092486 — image/openai.ts: боевой edits-провайдер (инъекция для тестов, лестница→moderated-результат, size-гард, usage-атрибуция); 8 тестов.
- 2026-07-23 — P1.6 — 52abbb2 — qc.ts: vision-QC через llm-слой, qcPasses чистый, sceneMatch мягкий (сделан до P1.5 — зависимость).
- 2026-07-23 — P1.5 — 6f5b85d — generate.ts: anchor-цепочка с чекпоинтами (якорь фатален, слайды деградируют, resume, RETRY_BOOST, QC-сбой→needs_review) + carousel dir-хелперы storage.ts; 8 тестов. ГЕЙТ ФАЗЫ 1: 339 server + 12 web + lint + build.

- 2026-07-23 — P2.1 — 4078ac9 (+фикс 35aaaae) — pricing: UsageTask+5, SEED_TOKENS, taskModel-маппинги, carousel-модель в ourModels(); quote-билдеры; 4 теста. Урок: пайп на tail маскирует exit-код — проверять линт отдельно.
- 2026-07-23 — P2.2 — c83d901 — billing.ts: reused→HoldConflictError, startGenerationHold (прекол+свежая hold+run_id/quote), settle по id-атрибуции с капом, withIdeationHold, reconcile-матрица, autoAcceptReview; settleHold+note (аддитивно), review_deadline колонка; 9 тестов.
- 2026-07-23 — P2.3 — 151b742 — worker.ts: FIFO по carousel_projects.status, кап 2/пер-юзер 1, исходы done/qc_review+дедлайн/failed+release, resume+reconcile в index.ts за флагом; 5 тестов.
- 2026-07-23 — P2.4 — cbbf536 — storage: safeCarouselPath, байты в userUsageBytes, cleanupCarousels в lifecycle (защита активных/ревью/холдов); 3 теста. Suite 360/360.

- 2026-07-23 — P2.5 — 1e1b56c — routes-carousel.ts v1 за флагом (CRUD/quote/generate 409/402+shortfall/file-гард, carouselOwnerOnly=404); 6 inject-тестов, гонка воркера закрыта блокирующим провайдером.
- 2026-07-23 — P2.6 — ef1b554 — finalize.ts: cover+кроп lanczos → 1080×1350/1080×1080 sRGB, best-effort в done-пути; run() из ffmpeg.ts экспортирован аддитивно; 4 теста c probe-сверкой. ГЕЙТ ФАЗЫ 2: 370 server + 12 web + lint + typecheck + build зелёные.

- 2026-07-23 — P3.1–P3.4 — ef91c57 — ОДНИМ коммитом (осознанное отступление: движки переплетены общим engines.ts и роут-файлом): ideas/storyboard/caption на persona+сцены+patternHintsBlock (few-shot слот P3.4), микро-hold роуты (цена на кнопке, битый LLM-JSON→502+возврат), PATCH-раскадровка с нормализацией idx, авто-подпись в воркере (run_id атрибуция, best-effort), LLM тест-シーム setCarouselLlmForTests; 7 тестов. Suite 377/377.

- 2026-07-23 — P4.1–P4.5 — d3d1663 — UI: MeInfo.carouselStudio, view/hash/nav за флагом, полный экран CarouselStudio.tsx (список/создание, идеи с ценой, редактор раскадровки, прогресс с поллингом, ревью accept/retry 2, подпись, shortfall→пополнение) + серверные роуты accept/retry + ApiError.body; 378+14 тестов.
- 2026-07-23 — P4.G — 1228052 (dev-энтрипоинт) + этот фикс-коммит — E2E на mock (0 трат): идея→раскадровка→генерация→результат, подпись авто, JPEG 1080 отдаются. Найдено и починено 2 бага: owner-квота (unmetered) и сброс #carousel до загрузки сессии. Launch-конфиг swapforge-carousel-api в глобальном ~/.claude/launch.json (cmd-обёртка в scratchpad, при потере пересоздать: cd server && npx tsx watch src/dev-carousel.ts).

NEXT: P5.1 — server/src/apify.ts по шаблону wavespeed.ts: createApify({apiKey?, baseUrl?=https://api.apify.com, fetchImpl?, retryBaseMs?}) c api<T>() (Bearer config.apifyToken), ApifyError{status,retryable: 429||>=500}, withRetry exp-backoff; методы: startActorRun(actorId, input) → {runId} (POST /v2/acts/:actorId/runs), getRun(runId) → {status, defaultDatasetId} (GET /v2/actor-runs/:id), datasetItems<T>(datasetId, {limit}) → T[] (GET /v2/datasets/:id/items). Таймауты: submit 60s, poll 30s, items 120s. Тест server/test/carousel-apify.test.ts с fetchImpl-фейком: happy, 429-ретрай, 500 без ретрая на submit? (нет — submit ретраим ТОЛЬКО 429 как wavespeed, чтобы не задвоить ран), сетевой таймаут → retryable. Затем P5.2 mining run (см. PLAN). Check: typecheck+test -w server+lint. Коммит feat(carousel): apify client (P5.1).
