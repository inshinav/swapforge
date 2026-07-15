# SwapForge

Интеллектуальный генератор промтов для subject-swap видео через **ByteDance Seedance 2.0 Video Edit** (WaveSpeed). Внутренний инструмент INSHIN LAB.

**Вход:** исходный ролик (mp4/mov, до ~15 с) + референсы с ролями (модель / транспорт / объекты).
**Выход:** два промта — стартовый кадр для GPT Image (ChatGPT) и хирургический KEEP/REPLACE/GUARDRAILS-контракт для Seedance — плюс параметр-блок WaveSpeed. Библиотека проектов с фидбеком по таксономии артефактов замыкает learning loop: удачные прошлые проекты подмешиваются few-shot'ом в новые генерации.

Прод: **https://swapforge.inshinlab.com** (basic auth, systemd `swapforge`, порт 4315).

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
OPENAI_MODEL=gpt-5.5
STORAGE_CAP_GB=10
```

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
npm run dev:web      # vite, порт 5195, проксирует /api
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
