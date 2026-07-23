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

NEXT: P6.1 — server/src/zip-store.ts: STORED-zip БЕЗ новых зависимостей (local file header + central directory + EOCD, метод 0, CRC32 таблицей; PNG/JPEG уже сжаты). API: buildStoredZip(entries: Array<{name: string; data: Buffer}>): Buffer. Роут GET /api/carousel/projects/:id/export.zip (routes-carousel): статус done|qc_review, слайды status=done по idx: файл = final_file ?? file → slide-01.jpg…, caption.txt (caption+хэштеги, если есть), meta.json (title/idea/сцены/дата, БЕЗ внутренних id) → reply.type(application/zip) + Content-Disposition attachment filename=carousel-<id8>.zip. Тест server/test/carousel-export.test.ts: собрать zip из 2 фикстур → распарсить структуру (читать central directory руками или проверить сигнатуры PK + имена + размеры + CRC против zlib.crc32? в node нет crc32 — своя функция, сверить с известным значением фикстуры) + inject-тест роута (200, content-type, non-done → 409). Затем P6.2 telegram/notify.ts (sendMediaGroup 2–10, sendPhoto при 1, sendChatAction-прекол 403→подсказка Start; fetch-инжект; кнопка «В Telegram» уже в UI заглушкой) + уведомление о готовности карусели в воркере (best-effort). Активировать кнопки экспорта/TG в CarouselStudio.tsx (заменить disabled на живые: ZIP = <a href>, TG = post). Check: exit-коды typecheck/test/lint. Коммиты feat(carousel): zip export (P6.1); feat(carousel): telegram delivery (P6.2).
