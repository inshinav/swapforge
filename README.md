# SwapForge

Интеллектуальный генератор промтов для subject-swap видео через **ByteDance Seedance 2.0 Video Edit** (WaveSpeed). Внутренний инструмент INSHIN LAB.

**Вход:** исходный ролик (mp4/mov, до ~15 с) + референсы с ролями (модель / транспорт / объекты).
**Выход:** два промта — стартовый кадр для GPT Image (ChatGPT) и хирургический KEEP/REPLACE/GUARDRAILS-контракт для Seedance — плюс параметр-блок WaveSpeed. Библиотека проектов с фидбеком по таксономии артефактов замыкает learning loop: удачные прошлые проекты подмешиваются few-shot'ом в новые генерации.

Прод: **https://inshinlab.com/swapforge/** (basic auth; systemd `swapforge`, порт 4315; nginx-сниппет `snippets/swapforge.conf` в server-блоке inshinlab.com срезает префикс — бэкенд живёт на `/`, фронт собран с base `/swapforge/`).

## Пайплайн

```
ролик ──► ffprobe (мета) ──► ffmpeg раскадровка ──► LLM vision-анализ ──► генерация промтов
              │                 first + scene cuts        storyboard / мир /        доктрина + анализ +
              │                 + сетка 2 fps (кап 40)    субъекты / КАРТА РИСКОВ   рефы + few-shot
              │                                           артефактов + теги               │
              ▼                                                                           ▼
         SQLite (projects/refs/prompts/feedback)  ◄──── фидбек (таксономия) ◄──── два промта + параметры
                       │                                       │
                       └── few-shot ретрив (Jaccard по тегам) ◄┘  ← learning loop
```

**Таксономия артефактов** (фидбек → таргетированный фикс при итерации): identity bleed, world drift, temporal drift, pasted-on look, cross-wiring.

**Нумерация референсов** (неприкосновенна): `reference image 1` = стартовый кадр из GPT Image (в промте — явная строка «Reference image 1 is the exact first frame of the edit»), дальше модель и объекты в порядке карточек в UI. Порядок массива `reference_images` в WaveSpeed обязан совпадать с нумерацией в промте — это защита от cross-wiring.

## Структура

```
server/   Fastify 5 + TS, node:sqlite, ffmpeg (spawn), провайдер-слой LLM
  src/engine/     doctrine (системный промт), analyze, generate, similar (few-shot), pipeline (джобы)
  src/llm/        provider (интерфейс) + openai (дефолт gpt-5.5) + anthropic (запасной)
  test/           vitest: движок, схемы, ретрив
web/      Vite + React 19 + Tailwind v4 — тёмный визард (Linear-эстетика, lime #C6F24E)
shared/   zod-схемы анализа, таксономия, DTO
deploy/   swapforge.service (systemd, hardening), nginx conf (basic auth + ACME), deploy.sh
```

Код: `/opt/swapforge`. Данные: `/var/lib/swapforge` (`swapforge.db` + `projects/<id>/{source.mp4, frames/, refs/}`).

## LLM

Провайдер выбирается через env: `LLM_PROVIDER=openai|anthropic` (+ `OPENAI_MODEL` / `ANTHROPIC_MODEL`). Оба пути используют structured output (json_schema strict с фолбэком на json_object) и ретраи на 429/5xx. Анализ шлёт кадры с таймстемпами (scene/first — high detail, сетка — low), генерация дополнительно получает фото рефов и первый кадр — промты несут реальные детали внешности.

## Env (`/etc/swapforge.env`)

```
PORT=4315
HOST=127.0.0.1
DATA_DIR=/var/lib/swapforge
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5              # база для всех задач
OPENAI_MODEL_ANALYZE=gpt-5.5      # vision-анализ ролика (почти весь расход — input-токены кадров)
OPENAI_MODEL_GENERATE=gpt-5.5     # генерация промтов (мало входа, важен максимум интеллекта)
OPENAI_MODEL_IMAGE=gpt-image-2    # стартовый кадр по Images API (edits с реф-фото)
IMAGE_QUALITY=high                # low | medium | high
IMAGE_LONG_SIDE=2048              # длинная сторона кадра (2K), размер подгоняется под AR ролика, кратно 16
STORAGE_CAP_GB=10
```

**Выбор моделей per задача.** `OPENAI_MODEL_ANALYZE` / `OPENAI_MODEL_GENERATE` (для Anthropic — `ANTHROPIC_MODEL_ANALYZE/GENERATE`) перекрывают базовую модель; после правки — `systemctl restart swapforge`. Пресеты:

| Пресет | ANALYZE | GENERATE | Когда |
|---|---|---|---|
| Максимум (дефолт) | `gpt-5.5` | `gpt-5.5` | Единичные прогоны — качество карты рисков решает всё |
| Экономный | `gpt-5.4-mini` | `gpt-5.5` | Анализ жрёт input-токены кадров — mini режет основную статью расхода, промты остаются на флагмане |
| Потолок | `gpt-5.5` | `gpt-5.5-pro` | Если хочется выжать максимум из текста промтов (pro заметно дороже и медленнее) |

На ключе также доступны превью **gpt-5.6-luna / gpt-5.6-sol / gpt-5.6-terra** — это три A/B-варианта следующего поколения. Их можно пробовать в `OPENAI_MODEL_GENERATE` (одна строка + restart); в дефолт не ставим: превью могут менять поведение/исчезать и не гарантируют стабильный structured output. Если какой-то из них начнёт стабильно выигрывать по качеству промтов — переключим дефолт.

**Стартовый кадр по API.** Кнопка «Сгенерировать кадр» в блоке промтов вызывает Images API (`OPENAI_MODEL_IMAGE`, edits): imagePrompt + все реф-фото проекта → PNG в максимальном качестве (`IMAGE_QUALITY=high`, длинная сторона `IMAGE_LONG_SIDE=2048`, размер подогнан под AR ролика, `input_fidelity=high` сохраняет лицо модели). Кадр появляется превью в UI, скачивается одним кликом — это готовый reference image 1 для WaveSpeed. Можно генерить несколько вариантов и выбирать.

**Контроль расхода:** после каждого шага сервис пишет строку `[llm-usage] task=… model=… in=… out=…` — смотреть `journalctl -u swapforge | grep llm-usage`; детальная разбивка по моделям и дням — platform.openai.com/usage, актуальные цены — openai.com/api/pricing. Health (`/swapforge/api/health` и футер UI) показывает активные модели обеих задач.

## Ротация места

Кап на `DATA_DIR` — `STORAGE_CAP_GB` (10 ГБ). При превышении удаляются **только исходные видео** самых старых проектов (кадры, рефы, анализ и промты остаются навсегда — они лёгкие и кормят few-shot). Проверка: на старте сервиса и после каждой загрузки.

## Деплой

```bash
ssh inshinlab-vps
bash /opt/swapforge/deploy/deploy.sh   # git pull → npm ci → build → холодный бэкап БД (keep-5) → restart → health
```

Репо приватный; VPS ходит по read-only deploy-ключу (`~/.ssh/swapforge_ro`, алиас `github.com-swapforge`).

## Разработка

```bash
npm install
npm run dev:server   # tsx watch, порт 4315
npm run dev:web      # vite: http://localhost:5195/swapforge/ (проксирует /swapforge/api → 4315)
npm run typecheck && npm run lint && npm test && npm run build
```

## Как пользоваться (коротко)

1. **Свап → кинуть ролик** (drag&drop). Раскадровка стартует сама.
2. **Референсы**: добавить фото, назначить роли, выставить порядок (это и есть нумерация ref 2, 3, …), в заметке — одежда/детали, если на фото не то.
3. **Проанализировать ролик** → смотри карту рисков.
4. **Сгенерировать промты** (EN/RU для старт-кадра; эндпоинт Seedance 2.0 / Fast).
5. Промт №1 → в ChatGPT с приложенными фото рефов → получить стартовый кадр. Промт №2 + параметр-блок → в WaveSpeed (`reference_images`: старт-кадр первым, дальше рефы по порядку). Первый прогон 720p, финал 1080p.
6. Прогнал — вернись и нажми **«Сработало»** или **«Вылезли артефакты…»** (+ типы из таксономии) → «Перегенерировать с таргет-фиксами». Фидбек делает следующие проекты умнее.

## Roadmap-хуки

- v2: прямой вызов WaveSpeed из сервиса (эндпоинт и поллинг `predictions/<id>/result` уже описаны в параметр-блоке; шов — `engine/pipeline.ts`)
- v3: авто-QC результата (сравнение с исходником, автодетект артефактов, автоитерация)
- v4: мультипользовательский режим
