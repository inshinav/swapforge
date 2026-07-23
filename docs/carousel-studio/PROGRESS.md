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

- 2026-07-23 — P5.1 — a528c4f (+фикс 825f064: конфиг-ошибка не ретраится) — apify.ts по шаблону wavespeed (429-only сабмит, инжект fetch); 4 теста. Урок №2: grep-гейты ловят слова в именах тестов — гейтить ТОЛЬКО exit-кодами.
- 2026-07-23 — P5.2–5.5,5.7 — ce40212 — miner core: run.ts (hold→актор с персистом run-id→фильтр→карточки→settle/полный возврат, resume на буте), virality.ts (чистый, таблица), patterns.ts (структура-only, thumb-кэш+TTL-свип), routes-miner (лимит дня kind=miner, thumb-роут), PatternCards→идеи через structure_json, assertNoMinedPaths в generate.ts, carousel_pattern в прайсинге; 7 тестов.
- 2026-07-23 — P5.6 — 9b7b3ac — UI подборок: создание/майнинг с ценой и поллингом/плитки с атрибуцией/♥; лайкнутые карточки → few-shot идей чекбоксом.

- 2026-07-23 — P6.1–6.2 — b6a0ead — zip-store.ts (STORED, 0 deps, CRC-эталон), export.zip, send-tg multipart-аплоадом (слайды за auth — URL для TG не работают), уведомление о готовности, живые кнопки UI; 6 тестов.
- 2026-07-23 — P7.1–7.2 — 40e3e55 — дневной кап carousel, owner-сводка /api/carousel/admin/summary, алерт холдов НЕ тронут (решение: принятый шум, источник виден в сводке), гайд-секция RU с легал-заметкой.
- 2026-07-23 — P7.3–7.4 — (этот коммит) — браузер-чек: подборки рендерятся, живой ZIP скачивается (200/PK/27КБ), TG-кнопка на месте. ФИНАЛ-ГЕЙТ: 395 server + 14 web + lint + typecheck + build + npm audit (0 vulns) — всё зелёное.

СТАТУС: ФАЗЫ 0–7 ЗАВЕРШЕНЫ. Фича полностью за флагом CAROUSEL_STUDIO (выкл по умолчанию), видео-пути не тронуты (весь исходный suite зелёный на каждом коммите).

ПЛАН ВКЛЮЧЕНИЯ ФЛАГА (за Alex):
1. Мердж feature/carousel-studio в main (ветка запушена на origin) → деплой обычным путём (пуш в main → ssh deploy.sh). Прод останется ИНЕРТЕН: флаг выключен, роутов нет, UI скрыт.
2. В /etc/swapforge.env добавить: CAROUSEL_STUDIO=1, CAROUSEL_STUDIO_OWNER_ONLY=1, APIFY_TOKEN=<токен> (для майнера; без него майнинг честно падает с понятной ошибкой, карусели работают) → systemctl restart swapforge.
3. Owner-приёмка: 1 карусель на реальном gpt-image-2 (3 слайда ≈ /usr/bin/bash.6–0.8 по прайсу litellm) + 1 майнинг-ран ≤. Проверить: слайды/QC/подпись/ZIP/TG-доставку (нажать Start у бота!), settle в леджере.
4. Убрать CAROUSEL_STUDIO_OWNER_ONLY → рестарт → фича у всех. Дневные капы: 10 каруселей / 3 майнинга на юзера.
ROLLBACK: убрать CAROUSEL_STUDIO из env → рестарт (роуты исчезают, UI скрыт; данные остаются, бут-реконсиляция вернёт зависшие холды).
