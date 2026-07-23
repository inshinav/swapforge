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

NEXT: P4.1 — флаг в UI. (1) server: в HealthInfo (shared/api-types.ts) опц. поле carouselStudio?: boolean; в routes.ts /api/health хэндлере отдать config.carouselStudio && (!config.carouselOwnerOnly || роль запрашивающего owner — ВНИМАНИЕ: /api/health публичный и юзера не знает → отдаём просто config.carouselStudio, а owner-only скрытие делает /api/me? Проверить где клиент берёт health: web/src/App.tsx:81/217 — health public + me. Решение: carouselStudio в health = флаг вкл; ownerOnly-скрытие оставить серверным роутам (404) и НЕ показывать таб если health.carouselStudio && ownerOnly && !isOwner — для этого нужно и ownerOnly поле или производный boolean в /api/me. Простейшее: в MeInfo (auth/routes GET /api/me) добавить carouselStudio: config.carouselStudio && (!config.carouselOwnerOnly || user.role===owner) — клиент читает из me). (2) web/src/App.tsx: View union + VIEW_HASHES + resolveView гейт по me.carouselStudio (хэш #carousel без флага → start), MobileNav пункт {view:carousel, icon:▤, label:Карусели} + desktop TabBtn, ветка в main → экран-заглушка CarouselStudio (P4.2 наполнит). (3) web/src/api.ts: методы carouselList/Create/Get/Delete/Ideas/PickIdea/StoryboardGen/StoryboardPatch/Caption/Quote/Generate/fileUrl/packs/ideationPrices (мутации post() c csrfHeader). Тесты: web App.test — таб виден только с флагом, хэш гейтится; server: /api/me содержит carouselStudio по флагу+роли. Check: typecheck + test (оба воркспейса) + lint. Коммит feat(carousel): UI flag plumbing (P4.1).
