# Carousel Studio — PROGRESS

> Формат записи: `дата — Px.y — <commit hash> — что сделано (1 строка)`; внизу файла — ровно один
> актуальный `NEXT: <точное следующее действие для холодного старта с нулевой памятью>`.
> Правила чтения на старте сессии — в PLAN.md «Протокол сборки».

---

- 2026-07-23 — P0.1 — bda7a90 — ветка feature/carousel-studio, материализованы SPEC.md/PLAN.md/PROGRESS.md из утверждённого плана.
- 2026-07-23 — P0.2 — bd0a44a — config.ts: карусельная секция env-ключей (флаг выкл по умолчанию); suite 292/292.
- 2026-07-23 — P0.3 — c25d309 — db.ts: 5 таблиц + индексы (pattern_cards прямой FK, SPEC §8 обновлён); тест carousel-db (5 кейсов); suite 297/297. Правило: git add только явные пути (git add -A подмёл чужие untracked-доки, коммит переделан).
- 2026-07-23 — P0.4 — b2fd2f2 — shared/carousel.ts: статусы=CHECK БД, CAROUSEL_TASKS (5 имён — единый источник SPEC §7), dual-схемы 5 движков + DTO; тест схем; suite 301/301.
- 2026-07-23 — P0.5 — 1ea6208 — image/{provider,mock,openai-заглушка} + config.carouselImageProvider (mock = дев-E2E без трат); тест селектора/мока; suite 305/305.
- 2026-07-23 — P0.6 — (hash этого коммита) — гейт: carouselId-ветка в requireActiveAttempt (fail-closed; чужая hold отвергается через WHERE user_id=владелец карусели), meta.carouselId в llm/provider.ts, маппинг meta.carouselId→projectId в recordUsage обоих LLM-импелов; 7 тестов гейта. ГЕЙТ ФАЗЫ 0: server 312/312, web 12/12, lint, typecheck, build — зелёные.

NEXT: P1.1 — создать server/src/engine/carousel/blocks.ts: версионируемые EN-константы промт-блоков по SPEC §2 — (1) UGC_PRESETS: Record<'raw'|'casual'|'polished', string> (candid phone photo, imperfect framing, natural skin texture no beauty-retouch, mixed/available lighting, slight motion blur where natural, casual amateur composition, no studio look, no watermark/text — интенсивность нарастает от polished к raw); (2) ANTI_ARTIFACT_GUARDRAILS (руки/пальцы/текст/лишние конечности/пластиковая кожа — запреты); (3) buildIdentityBlock(modelNote: string, refCount: number) — «Reference image 1..N is the person's identity…» + note дословно; (4) FORMAT_BLOCK(size) — кадрирование 4:5/1:1, no borders/watermarks; (5) MODERATION_TIERS — карусельная лестница смягчения: массив трансформаций UGC-блока (например убрать «natural skin texture» → нейтральная формулировка) для P1.4. Snapshot-тесты в server/test/carousel-blocks.test.ts (фиксируют дословный текст блоков). Check: npm run typecheck && npm run test -w server && npm run lint. Коммит feat(carousel): prompt blocks library (P1.1). Тикнуть P1.1, записать hash+NEXT про P1.2 (locations.ts Miami-пак ~12 сцен по списку SPEC §2).
