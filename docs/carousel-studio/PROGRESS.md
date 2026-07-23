# Carousel Studio — PROGRESS

> Формат записи: `дата — Px.y — <commit hash> — что сделано (1 строка)` затем строка
> `NEXT: <точное следующее действие для холодного старта с нулевой памятью>`.
> Правила чтения на старте сессии — в PLAN.md «Протокол сборки».

---

- 2026-07-23 — P0.1 — bda7a90 — ветка feature/carousel-studio, материализованы SPEC.md/PLAN.md/PROGRESS.md из утверждённого плана.

- 2026-07-23 — P0.2 — bd0a44a — config.ts: карусельная секция env-ключей (флаг выкл по умолчанию); suite 292/292 + typecheck зелёные.

- 2026-07-23 — P0.3 — (hash в след. записи) — db.ts: 5 карусельных таблиц + индексы (pattern_cards с прямым FK на collections вместо collection_items — SPEC §8 обновлён); тест carousel-db.test.ts (5 кейсов: существование, каскады, CHECK, уникальность (carousel_id,idx), санити видео-таблиц); suite 297/297.

NEXT: P0.4 — создать shared/carousel.ts по SPEC §3/§4/§5: статус-юнионы (CarouselStatus, SlideStatus, MiningStatus — строго как CHECK в db.ts), zod-схемы + JSON Schema (dual-паттерн как shared/analysis.ts): CarouselIdeaZ {title, hook, concept, slideCount 2..10, sceneIds[], ugcPreset raw|casual|polished} + IDEAS_JSON_SCHEMA (массив 5 идей, schemaName 'carousel_idea'), StoryboardZ {slides[]: {idx, role hook|context|payoff|cta, sceneId, action, outfit, camera, useProductRef?}} ('carousel_storyboard'), CaptionZ {caption, hashtags[10..15], hookLine} ('carousel_caption'), QcZ {identity 0..10, artifacts 0..10, realism 0..10, sceneMatch bool, notes} ('carousel_qc'), PatternCardZ {hookType, slideCount, slideRoles[], composition[], captionStyle, whyItWorks, nicheTags[]} + DTO для API (CarouselInfo, SlideInfo, CollectionInfo, PatternCardInfo, MiningRunInfo, CarouselQuoteInfo). Тест server/test/carousel-schemas.test.ts (или в shared — но vitest только в server/web: класть в server/test): фикстуры валидируются, битые отклоняются. Check: npm run typecheck && npm run test -w server. Коммит feat(carousel): shared schemas+DTO (P0.4). Тикнуть, записать hash+NEXT про P0.5 (image/provider.ts интерфейс+мок).
