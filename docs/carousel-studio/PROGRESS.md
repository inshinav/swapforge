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

NEXT: P3.1 — движок идей + микро-hold роут. (1) server/src/engine/carousel/ideas.ts: IDEAS_SYSTEM (EN: креативный директор UGC-каруселей; вход persona-нота модели + список сцен LocationPack + опц. пожелание юзера + опц. PatternCard-структуры; выход 3-5 идей строго по IDEAS_JSON_SCHEMA; title/hook/concept RU, промт-крафт EN); runIdeaEngine({carouselId, userId, wish?, patternHints?}, llm?) → собирает parts (persona note из variantRefs role=model note/auto_note, сцены пака карусели id+name+promptBlock кратко), getLlm().structured({schemaName:CAROUSEL_TASKS.idea, schema:IDEAS_JSON_SCHEMA, models: modelChainFor(generate), meta:{carouselId, userId, generationId: opId}}) — ВАЖНО: opId прокидывается параметром для атрибуции микро-hold; парс CarouselIdeasZ. (2) Роут POST /api/carousel/projects/:id/ideas {wish?}: статус-гейт (draft|storyboard, 409 при generating/qc_review), withIdeationHold({carouselId,userId,task:carousel_idea}, opId => runIdeaEngine(...opId)) → 402/409 маппинг как в generate; выбранная идея: POST .../idea {index} → пишет idea_json + slide_count из идеи + location scenes; status остаётся draft. (3) Тесты server/test/carousel-ideas.test.ts: fake llm возвращает 3 идеи → роут кладёт их в ответ; выбор идеи пишет idea_json/slide_count; статус-гейт 409; невалидный JSON llm → 502 и hold released (баланс не тронут). Check: typecheck+test -w server+lint. Коммит feat(carousel): idea engine + micro-hold route (P3.1). Затем P3.2 storyboard (аналогично, PATCH-правки слайдов в draft/storyboard), P3.3 caption, P3.4 few-shot слот.
