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

NEXT: P2.1 — прайсинг карусели. (1) В server/src/pricing.ts АДДИТИВНО: добавить в SEED_TOKENS записи carousel_slide (tin~3400,tout~5700 — как start_frame), carousel_qc (tin~2500,tout~400), carousel_idea (tin~1500,tout~1200), carousel_storyboard (tin~1500,tout~1500), carousel_caption (tin~800,tout~600); в taskModel() маппинг: carousel_slide→config.carouselImageModel, carousel_qc/idea/storyboard/caption→модель по аналогии с describe/generate-цепочками; в ourModels() добавить config.carouselImageModel И config.openaiImageModel уже там? проверить — carouselImageModel default==openaiImageModel, но при override оба обязаны быть в фильтре (иначе цена null → settle 0, SPEC §7). (2) Новый server/src/engine/carousel/pricing.ts: buildCarouselQuote(slideCount) → {totalUsd, breakdown} = slide_count×(carousel_slide по priceForCached) + slide_count×carousel_qc + carousel_caption; buildIdeationQuote(task) для микро-холдов идеации. Тест server/test/carousel-pricing.test.ts: с фикс-манифестом (pricing_cache сид) смета детерминирована, priceForCached(config.carouselImageModel)!==null, quote растёт с slide_count. Check: npm run typecheck && npm run test -w server && npm run lint. Коммит feat(carousel): pricing — seed tokens + quote builder (P2.1). Тикнуть P2.1, hash+NEXT про P2.2 (billing.ts: hold/settle/release + reused→409 + reconcile по матрице SPEC §7).
