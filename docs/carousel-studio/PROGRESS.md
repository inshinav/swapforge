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

NEXT: P2.5 — server/src/routes-carousel.ts: registerCarouselRoutes(app) (регистрация в routes.ts::registerRoutes ЗА if (config.carouselStudio); carouselOwnerOnly → каждый роут дополнительно требует req.user.role===owner). Роуты v1 (auth+CSRF автоматом через глобальный requireApiAuth): GET /api/carousel/projects (список свои, DTO CarouselInfo без слайдов), POST /api/carousel/projects {modelId, variantId, slideCount?} → создать draft (валидация: модель принадлежит юзеру через getOwnedModel, slideCount 2..config.carouselMaxSlides), GET /api/carousel/projects/:id (полный CarouselInfo со слайдами из carousel_slides + queuePosition из worker), DELETE (только draft/done/failed без open-hold), GET .../quote?slides=N → carouselQuoteInfo, POST .../generate → статус-гейт (draft|storyboard c storyboard_json), startGenerationHold (HoldConflictError→409, InsufficientCreditsError→402-JSON c shortfall), статус generating, enqueueCarouselRun; GET /api/carousel/:id/file/:file → safeCarouselPath, Cache-Control private. Хелпер toCarouselInfo(row, slides) в routes-carousel.ts. Тесты server/test/carousel-routes.test.ts (образец inject — test/tenancy.test.ts / routes-models): флаг выкл → 404; CRUD; чужая карусель → 404; generate: без storyboard → 409, ок-путь ставит hold и статус, повторный generate → 409, бедный юзер → 402 c shortfall; file-роут отдаёт слайд и режет травёрсал. Check: npm run typecheck && npm run test -w server && npm run lint. Коммит feat(carousel): routes v1 (P2.5). Затем P2.6 (ffmpeg-финализация 1080×1350) и гейт фазы P2.G.
