# Carousel Studio — PROGRESS

> Формат записи: `дата — Px.y — <commit hash> — что сделано (1 строка)` затем строка
> `NEXT: <точное следующее действие для холодного старта с нулевой памятью>`.
> Правила чтения на старте сессии — в PLAN.md «Протокол сборки».

---

- 2026-07-23 — P0.1 — (hash этого коммита) — ветка feature/carousel-studio, материализованы SPEC.md/PLAN.md/PROGRESS.md из утверждённого плана.

NEXT: P0.2 — в server/src/config.ts добавить (аддитивно, в объект config, НЕ трогая существующие ключи): carouselStudio = env('CAROUSEL_STUDIO')==='1'; carouselOwnerOnly = env('CAROUSEL_STUDIO_OWNER_ONLY')==='1'; apifyToken = env('APIFY_TOKEN'); carouselImageModel = env('CAROUSEL_IMAGE_MODEL') || openaiImageModel-значение; carouselConcurrency (CAROUSEL_CONCURRENCY, 2); carouselMaxSlides (CAROUSEL_MAX_SLIDES, 10); carouselSlideSize (CAROUSEL_SLIDE_SIZE, '1024x1280'); carouselReviewTtlH (CAROUSEL_REVIEW_TTL_H, 24); limitCarouselsPerDay (LIMIT_CAROUSELS_PER_DAY, 10); limitMinerPerDay (LIMIT_MINER_PER_DAY, 3); minerRunCostUsdPer100 (MINER_RUN_COST_USD_PER_100, 1.0); qc-пороги carouselQcIdentityMin/ArtifactsMin/RealismMin (7/6/6). Проверка: npm run typecheck && npm run test -w server. Коммит feat(carousel): config keys behind flag. Затем тикнуть P0.2 в PLAN.md и записать сюда hash+NEXT про P0.3 (таблицы в db.ts applySchema по SPEC §8).
