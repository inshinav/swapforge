# Carousel Studio — SPEC (источник истины)

> Статус: утверждено Alex 23.07.2026 (через план-ревью Claude Fable 5).
> История: исходный SPEC.md не существовал; документ составлен из брифа Alex + разведки кодовой базы
> + независимого адверс-ревью дизайна (16 найденных проблем вшиты сюда). Решения ниже — финальные;
> изменения только через Alex.

## §0 Жёсткие правила (нарушение = стоп)

1. Фича-флаг `carousel_studio` (env `CAROUSEL_STUDIO=1`), **выключен по умолчанию**; выключен → роуты не регистрируются (404), UI-раздел скрыт, `#carousel`-хэш не резолвится.
2. **Ноль изменений поведения существующих video-swap путей.** Полный существующий тест-suite обязан быть зелёным после каждого коммита.
3. Миграции **только аддитивные** (CREATE TABLE IF NOT EXISTS / ensureColumn / MIGRATIONS-массив). Никаких table rebuild (в т.ч. поэтому `flow_attempts` не расширяем).
4. Промты к image-модели — **на английском**.
5. Reference Miner **адаптирует структуру/идеи** вирусных постов — никогда не копирует изображения или подписи; замайненные картинки **никогда** не подаются референсами в генерацию (валидация в коде, не только промтом).
6. Неудачные/замодерированные генерации **никогда не списывают кредиты** (модель hold→settle, §7).
7. Секреты только через env.
8. Абстракции **ImageProvider** и **ReferenceProvider** — вендоры сменяемы.
9. Биллинг-маржа `priceCredits()` / `USER_MARGIN_PCT` (скрытая ×1.25) — **FROZEN**: вызывается как есть, не модифицируется.

## §1 Продукт

Carousel Studio — второй продукт SwapForge рядом со свап-видео: пользователь выбирает свою модель
(из существующего конструктора моделей V4), получает идеи каруселей, правит раскадровку, жмёт
«Сгенерировать» → получает 2–10 согласованных UGC-слайдов + подпись, экспорт ZIP / отправка в
Telegram. Позиционирование: карусели для IG/TikTok с консистентным персонажем без фотосессий.

## §2 Пайплайн генерации (gpt-image-2)

- **Провайдер:** OpenAI Images API, endpoint `images/edits`. Модель: env `CAROUSEL_IMAGE_MODEL`,
  **default = `config.openaiImageModel`** (gpt-image-2). Обе модели обязаны попадать в `ourModels()`
  litellm-фильтра (иначе цена null → settle 0, тихо бесплатно). 2–4 reference images на вызов.
- **Размер:** env `CAROUSEL_SLIDE_SIZE`, default **1024×1280** (честный 4:5, кратно 16 — допустим
  только у гибких моделей). Гард `imageModelFlexible()`: негибкая модель → 1024×1536 + центр-кроп
  до 4:5 перед финализацией. Формат 1:1 = 1024×1024. Финализация: ffmpeg lanczos → 1080×1350 /
  1080×1080, sRGB. Quality: env (default `high`).
- **Тайминг честно:** слайды v1 строго последовательны (anchor-цепочка) — 10 слайдов ≈ 15–30 мин
  wall-clock (60–120 с/слайд на quality high + QC). UI проектируется под это: пер-слайд прогресс,
  уход со страницы безопасен. Параллелизация слайдов 2..N после QC якоря — оптимизация ПОСЛЕ v1.
- **Модерация:** `moderationLadder` из startframe бесполезен для карусельных промтов (заточен под
  FIGURE-фразы видео-доктрины) — у карусели **своя лестница смягчения** (тиеринг UGC-блоков
  кожи/фигуры); реюз только `isModerationRefusal()`.
- **Референсы на слайд (2–4, порядок фиксирован и объявлен в промте явно):**
  [1] identity-референсы модели из model card (1–2 фото), [2] anchor — слайд-якорь (для слайдов
  2..N), [3] опционально product/outfit-референс пользователя. Нумерация в промте явная
  («Reference image 1 is the person's identity…») — по образцу неприкосновенной нумерации видео-пайплайна.
- **Anchor chaining:** слайд 1 генерируется первым только с identity-рефами → проходит QC →
  становится anchor. Слайды 2..N получают identity-рефы + anchor как референс консистентности
  (одежда/локация/свет/цветокор). Ре-генерация слайда anchor не меняет; смена anchor = пере-генерация
  слайдов 2..N — явное действие пользователя с предупреждением о цене.
- **Структура промта слайда (EN, детерминированная сборка из версионируемых констант, не свободный
  текст LLM):** scene block (из storyboard) + identity block (из note/auto_note модели) + UGC realism
  block + LocationPack block + anti-artifact guardrails + формат/кадрирование.
- **UGC realism blocks** (библиотека, выбирается storyboard-ом): candid phone photo, imperfect
  framing, natural skin texture (no beauty-retouch), mixed/available lighting, slight motion blur
  where natural, casual amateur composition, no studio look, no watermark/text. Пресеты интенсивности:
  `raw` / `casual` / `polished`.
- **LocationPack:** `{id, name, scenes[]}`; scene = `{id, name, promptBlock EN (место+свет+время
  суток+фактура), форматы}`. Первый пак — **Miami** (~12 сцен: South Beach sand/lifeguard tower,
  Ocean Drive art-deco night neon, Wynwood murals, Brickell rooftop pool, marina/yacht deck,
  palm-lined residential street, beach boardwalk golden hour, luxury hotel lobby, open-air cafe,
  convertible on causeway, gym interior, penthouse balcony sunset). Пак — данные (ts-константа +
  zod); новые паки добавляются без изменения движка.

## §3 Reference Miner

- **ReferenceProvider абстракция**; первая реализация — **Apify** (официальные акторы IG/TikTok
  scraper), токен env `APIFY_TOKEN`. Вызовы — по существующему outbound-HTTP паттерну (submit → poll).
- **Вход майнинга: аккаунты руками ИЛИ автоподбор (P9)** — персона → LLM-темы с хэштегами → hashtag-скрейп → топ-авторы по лайкам → обычный profile-майнинг (ER честный). Холды майнера скоупятся ПОДБОРКОЙ (collectionId — тот же скоуп у LLM-гейта тем и vision). Легаси-вход: только аккаунты** (profile-scrape несёт followersCount — ER считается честно).
  Хэштеги — фаза 2 (требуют доборного profile-pass по авторам топ-N, отдельная цена). Лимит постов
  default 100, кап 200.
- **Virality-фильтр (детерминированный, до vision):** карусели/фото-посты; ER = (likes+comments)/followers
  ≥ порог (env, default 3%); likes ≥ мин (default 2000); свежесть ≤ 90 дней; топ-N (default 20) по ER.
- **PatternCards (vision-LLM):** по каждому отобранному посту — структурная карточка: hook-тип
  1-го слайда, число слайдов, роль каждого слайда (hook/context/payoff/CTA), композиционные приёмы,
  стиль подписи (структура, НЕ текст), гипотеза «почему залетело», теги ниши. В PatternCard не
  сохраняется текст подписи и сами изображения не используются для генерации — только миниатюра +
  URL источника (атрибуция в подборке) и структурные признаки. Промт vision-анализа явно запрещает
  перенос уникальных деталей.
- **«Подборки» (collections):** имя+seed+фильтры → запуск майнинга (кредитная цена, §7) → PatternCards
  в подборке; карточки можно смотреть, лайкать/архивировать и «Использовать в идеях» — тогда
  Idea/Storyboard движки получают структурные признаки как few-shot контекст.
- **Легальный guardrail в коде:** mined-изображения — отдельный класс ассетов; генерационный пайплайн
  валидирует, что путей из mined-класса нет среди референсов (unit-тест доказывает reject); подписи
  источников не попадают в контекст Caption Engine.

## §4 Движки (LLM, существующий provider-слой)

- **Idea Engine:** model card (persona, ниша) + LocationPack + выбранные PatternCards (опц.) +
  пожелание пользователя (опц.) → 5 идей `{title RU, hook RU, концепция, slide_count,
  location_scene ids, ugc-пресет}`. UI-тексты RU, промт-инжиниринг EN.
- **Storyboard Engine:** идея → `{slides[]: {idx, role, scene_id, action/pose EN, outfit note EN,
  camera EN, refs plan}}` + anchor-стратегия. Пользователь правит слайды и slide_count до генерации.
- **Caption Engine:** идея+раскадровка+persona → подпись (EN default / RU по выбору) + 10–15 хэштегов
  + hook-первая строка. Структуру может подсказывать PatternCard, текст всегда оригинальный.
- Все три — JSON по zod-схеме (dual-паттерн: zod + строгая JSON Schema), ретраи на невалидный JSON
  по существующему паттерну. schemaName == `SEED_TOKENS`-ключ == task (§7, таблица имён).

## §5 QC

После каждого слайда — vision-QC: (a) identity match vs референсы модели 0–10, (b) артефакты
(руки/пальцы/текст/лишние конечности/пластиковая кожа) 0–10, (c) UGC-реализм 0–10, (d) соответствие
storyboard-сцене. Пороги env (default: identity ≥7, артефакты ≥6, реализм ≥6). Провал → 1
автоматический ре-трай с усиленным guardrail-блоком (без доплаты) → снова провал → слайд
`needs_review`. **Все QC- и ретрай-вызовы несут `meta.generationId = slideId` и явный `meta.userId`** —
их стоимость исключается из settle вместе со слайдом при его провале. Moderation-block → слайд
`moderated`; «возврат» = исключение из settle (операции рефанда нет, §7).

**Ревью-фаза:** hold остаётся открытой пока статус `qc_review`; ручные ретраи `needs_review`-слайда
(до K=2) возможны только в этом окне (гейт требует открытую hold). TTL ревью env
`CAROUSEL_REVIEW_TTL_H=24` → авто-принятие оставшихся → settle. UI показывает окно ревью явно.

## §6 Экспорт и доставка

ZIP: `slide-01.jpg … slide-NN.jpg` (1080×1350 / 1080×1080, sRGB, ≤4MB/слайд) + `caption.txt` +
`meta.json` (идея, локации, дата). Реализация ZIP — свой STORED-writer без новых зависимостей.
«Отправить в Telegram»: sendMediaGroup требует 2–10 медиа → при 1 принятом слайде фолбэк `sendPhoto`;
бот не может писать без нажатого Start → прекол `sendChatAction`, на 403 RU-подсказка «открой бота
и нажми Start». Слайды — свой раздел стора; ретеншн §10.

## §7 Прайсинг (hold→settle; margin frozen)

- **Модель списания:** hold (резерв) при старте → settle ФАКТА при успехе → release при провале.
  Charge-строка в леджере пишется только на settle → «неудачное бесплатно» автоматически.
- **Смета** (на кнопке, до старта): forecast-токены (`SEED_TOKENS.carousel_slide`) × slide_count ×
  litellm-цена модели (`priceForCached`) + QC × slide_count + caption → totalUsd → frozen
  `priceCredits()` → кредиты. Env-цен для image-модели нет; единственная env-цена фичи —
  `MINER_RUN_COST_USD_PER_100` (Apify вне litellm).
- **Settle по атрибуции, не по временному окну** (секундная гранулярность двоит счёт на стыках):
  ран получает run-id; вызовы рана пишут `usage_events.generation_id` = slideId (image+QC+ретраи)
  или run-id (caption). Факт = SUM(cost_usd) по id-множеству рана МИНУС строки failed/moderated
  слайдов → `priceCredits(факт)`, кап = hold. 0 успешных слайдов → `releaseHold(id, 0)`.
  `meta.userId` обязателен во всех карусельных вызовах.
- **АНТИ-ЭКСПЛОЙТ (правило всех carousel-вызовов placeHold):** `placeHold` молча реюзает существующую
  open-hold на scope-id, а settle капится её суммой → генерация под копеечным ideation-холдом
  списалась бы в центы. Правило: **`reused:true` = 409 Conflict**; перед стартом генерации прекол
  `openHoldForProject(carouselId)` → есть open → 409. Гейт-ветка сверяет `hold.user_id ===
  carousel.user_id`.
- **Идеация (идеи/раскадровка/подпись) = синхронные микро-холды** внутри запроса: quote → placeHold
  (правило выше) → вызов → settle факта. Цена на кнопке («Идеи · ≈$0.03»), без confirm-диалогов.
  Во время `generating`/`qc_review` идеация закрыта статус-гейтом (409).
- **`reconcileCarouselHolds()` на буте — статус-матрица:** open hold + карусель НЕ в
  `generating`/`qc_review(<TTL)` → `releaseHold(id, 0)`; `generating` → resume рана; `done` c open
  hold → settle по факту; `qc_review` старше TTL → авто-принятие + settle. Существующий
  `reconcileOrphanHolds` карусельные холды не трогает (INNER JOIN на generations — проверено).
- QC-авто-ретрай и K=2 ручных ретраев — себестоимость поглощается заведением (settle капится холдом).
- **Таблица имён (один источник):** `SEED_TOKENS`-ключ == zod schemaName == `recordUsage.task`:
  `carousel_slide` (image), `carousel_qc`, `carousel_idea`, `carousel_storyboard`, `carousel_caption`,
  `carousel_pattern` (vision-карточки), `carousel_discover` (темы автоподбора, P9).
- Косметика: `settleHold` получает аддитивный опц. параметр note (default — старый текст
  'списание по факту рендера'), чтобы леджер не врал про карусели.

## §8 Данные (аддитивно)

Новые таблицы: `carousel_projects` (user, model/variant ref, статус-машина
draft→storyboard→generating→qc_review→done/failed, идея/раскадровка/подпись JSON, location_pack,
quote-снапшот, run-id), `carousel_slides` (project, idx, статус
pending→generating→qc→done|needs_review|moderated|failed, prompt JSON, файлы, anchor-флаг, qc JSON,
счётчики ретраев), `collections`, `pattern_cards` (прямой FK `collection_id` — подборка 1:N карточки,
join-таблица не нужна в v1), `mining_runs` (seed, статус, apify_run_id, статистика, cost).
Существующие таблицы не меняются (кроме оговорённых аддитивных касаний §9-таблицы плана).

## §9 API и UI

- API (auth автоматом через глобальный default-deny + CSRF; всё за флагом):
  `/api/carousel/projects` CRUD, `.../ideas`, `.../storyboard`, `.../caption`, `.../generate`,
  `.../slides/:id/retry`, `.../accept`, `.../export.zip`, `.../send-tg`, `.../file/:file`;
  `/api/miner/collections` CRUD, `.../mine`, `.../patterns`. Zod-схемы в shared/.
- UI: раздел «Карусели» (нижняя навигация + desktop-таб, hash-роут за флагом): список проектов →
  визард (Модель → Идеи → Раскадровка → Генерация с пер-слайд прогрессом → Результат: галерея,
  QC-бейджи, ретраи, подпись, экспорт) + «Подборки» (майнинг, лента PatternCards). Стиль — тёмная
  Linear-эстетика, lime #C6F24E, RU-тексты, состояния loading/empty/error/shortfall→пополнение.

## §10 Наблюдаемость, лимиты, стор

- Лимиты: параллельность на пользователя = 1 (глобально `CAROUSEL_CONCURRENCY=2`), слайдов ≤10
  (`CAROUSEL_MAX_SLIDES`), дневные капы kinds `carousel`/`miner` через `consumeDailyLimit`.
- **Стор-связка:** карусельные байты входят в глобальный кап, но существующие эвикшены чистят только
  `projects/` → обязательна карусельная эвикция в `cleanupStorageLifecycle` (keep-last-N на юзера),
  транзиент-свип, thumb-кэш майнера с TTL, учёт в `userUsageBytes`. Иначе под давлением диска
  вытесняются чужие видео — косвенное нарушение правила §0.2.
- Затраты в `usage_events` → monthSummary автоматически. Админ: сводка каруселей/затрат/холдов;
  алерт «резервы >30 мин» шумит на легитимных ранах — carousel-aware порог (решение в P7.1).

## §11 Фазы

0. **Foundation** — ветка, docs, флаг, env, таблицы, ImageProvider/ReferenceProvider интерфейсы + моки, гейт-ветка.
1. **Image pipeline core** — блоки промтов, Miami LocationPack, сборщик, openai-провайдер, anchor-цепочка, QC.
2. **Carousel job E2E** — прайсинг, биллинг-глю, воркер, стор, роуты v1, ffmpeg-финализация.
3. **Движки** — Idea/Storyboard/Caption + микро-холды.
4. **Web UI** — раздел за флагом, визард, поллинг, результат.
5. **Reference Miner** — Apify, mining runs, virality, PatternCards, подборки, легальные гарды.
6. **Экспорт и Telegram** — ZIP, notify-модуль.
7. **Hardening & launch** — лимиты, админ, гайд, E2E-смоук, launch-gate, план включения флага.

Детализация фаз в задачи — `PLAN.md` (соседний файл). Прогресс и точка продолжения — `PROGRESS.md`.
