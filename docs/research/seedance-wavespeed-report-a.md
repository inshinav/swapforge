# Seedance 2.0 Video-Edit на WaveSpeedAI: техническое руководство по точечной замене персонажа и объекта

## TL;DR
- **Endpoint `bytedance/seedance-2.0/video-edit` (и `-fast/video-edit`) на WaveSpeedAI реально существует и подтверждён документацией**: он принимает `prompt`, `video`, `reference_images`, `reference_audios`, `duration`, `aspect_ratio`, `resolution`, `enable_web_search`, `generate_audio` и заявлен как сохраняющий движение, композицию и идентичность исходного видео («Faces, objects, and camera movement from the input video stay consistent through the edit»). Это лучший из доступных инструментов под задачу «заменить только девушку (и иногда объект), сохранив оригинал».
- **Ключевой рычаг под вашу задачу — `generate_audio: false`** (сохраняет оригинальную аудиодорожку) и **явное перечисление в промпте того, что менять и что сохранять**; при этом **seed, negative prompt, mask, start-frame и weight-синтаксис для этого endpoint документацией НЕ подтверждены** — не стройте на них продакшн.
- **Практический вывод: делайте замену в один edit, если объект жёстко контактирует с телом (мотоцикл, шлем, одежда); делайте два последовательных edit только если объект отделён от персонажа** — повторный прогон документированно накапливает деградацию. Черновики гоняйте на `-fast` при 480p, финал — на standard при 720p/1080p.

## Key Findings

**1. Endpoint подтверждён и стабилен (уровень: подтверждённый факт).** WaveSpeedAI публикует полную схему модели `bytedance/seedance-2.0/video-edit` и её вариант `bytedance/seedance-2.0-fast/video-edit`. Вызов: `POST https://api.wavespeed.ai/api/v3/bytedance/seedance-2.0/video-edit`, ответ — prediction id, затем поллинг `GET https://api.wavespeed.ai/api/v3/predictions/{id}/result`, результат в `data.outputs[0]`. Префикс `Edit the input video.` добавляется к вашему промпту автоматически, поэтому фокусируйтесь на описании самой правки.

**2. Video-Edit — это НЕ image-to-video и НЕ reference-to-video (подтверждённый факт).** Различие принципиальное:
- **Video-Edit** (`/seedance-2.0/video-edit`): главный вход — `video` (готовый клип), а `reference_images` — вспомогательные. Модель «переписывает» указанные элементы, сохраняя движение/композицию/тайминг исходника. Именно этот endpoint нужен под вашу задачу.
- **Image-to-Video** (`/seedance-2.0/image-to-video`): вход — стартовое изображение (`image_url`), движение генерируется с нуля. Оригинального видео нет.
- **Reference-to-Video** (`/seedance-2.0/reference-to-video`, есть на fal.ai; на WaveSpeed отдельным endpoint не выделен): мультимодальная сборка «с нуля» из набора `image_urls`/`video_urls`/`audio_urls` с `@Image1/@Video1` синтаксисом — это генерация нового клипа, а не редактирование существующего.

**3. Endpoint изначально спроектирован под сохранение оригинала (подтверждённый факт).** Дословная формулировка на странице модели WaveSpeedAI: «Subject and motion preservation — Faces, objects, and camera movement from the input video stay consistent through the edit». Это ровно ваш сценарий.

**4. `generate_audio: false` сохраняет оригинальный звук (подтверждённый факт).** В UI-схеме прямо сказано: «Whether to generate native audio for the edited output. Defaults to true. When set to false, the input video's audio track is preserved on the output instead». Для «настоящего снятого видео» это критично.

**5. Повторные прогоны деградируют картинку (вероятный практический факт, несколько источников).** Прогон уже сгенерированного видео обратно как исходника ухудшает изображение, и повреждения накапливаются с каждым проходом; первым проявляется «пятнистость» цвета на лицах.

**6. По объективным замерам ByteDance модель — лидер по сохранению исходника (подтверждённый факт).** По препринту arXiv:2604.14148 (Table 9) Seedance 2.0 занимает первое место по всем шести измерениям I2V (motion quality 3.35, video prompt following 3.46, image preservation 3.31), «while no competitor exceeds 3.18»; по Table 10 на motion quality её satisfaction rate 43.88% — «over 3× the runner-up Kling 3.0 (12.00%)», а source image preservation достигает 91.37% usability. Это и есть техническая база того, что video-edit хорошо держит движение и идентичность.

## Details

### Вопрос 1 — Параметры, лимиты, цены WaveSpeed video-edit

**Подтверждено документацией WaveSpeed (таблица параметров модели):**

| Параметр | Обяз. | Значение |
|---|---|---|
| `prompt` | Да | Описание правки. Префикс `Edit the input video.` добавляется автоматически. |
| `video` | Да | URL входного видео. Длиннее 15 с — обрезается до первых 15 с; короче 2 с — дополняется последним кадром до 2 с. |
| `reference_images` | Нет | Референс-изображения для стиля/идентичности. |
| `reference_audios` | Нет | Референс-аудио. |
| `duration` | Нет | 4–15 с; авто-детект из входного видео. |
| `aspect_ratio` | Нет | `16:9`, `9:16`, `4:3`, `3:4`, `1:1`, `21:9`; адаптируется к входу. |
| `resolution` | Нет | `480p`, `720p` (по умолчанию), `1080p`. |
| `enable_web_search` | Нет | Веб-поиск для контекста. |
| `generate_audio` | Нет | По умолчанию `true`; `false` — сохраняет оригинальную дорожку. |

**Цены (подтверждено WaveSpeed).** Биллинг посекундный за `input duration + output duration`. Базовая цена запуска — «starts at $0.75 per run». Потарифно: 480p — $0.075/с, 720p — $0.15/с, 1080p — $0.375/с. Пример: вход 5 с + выход 5 с = 10 оплачиваемых секунд → 480p $0.75, 720p $1.50, 1080p $3.75. Вход 12 с + выход 12 с = 24 с → 480p $1.80, 720p $3.60, 1080p $9.00. **Fast-вариант:** WaveSpeedAI указывает по семейству Seedance 2.0 Fast «a consistent 17–33% cost reduction across all resolution and duration combinations» (не строго 19% — эту цифру уточняйте в playground для конкретного разрешения/длительности).

**Лимиты файлов референсов (уровень: другой провайдер / кросс-провайдерная схема ByteDance — на странице WaveSpeed video-edit НЕ указаны явно):** до 9 изображений (формат jpeg/png/webp/bmp/tiff/gif/heic/heif, <30 МБ, стороны 300–6000 px, соотношение сторон 0.4–2.5); до 3 видео (mp4/mov, ≤50 МБ, 2–15 с, FPS 24–60); до 3 аудио (mp3/wav, ≤15 МБ); суммарно до 12 файлов. Аудио не работает без визуального референса. **Важно: это лимиты общей мультимодальной схемы Seedance 2.0 у сторонних хостов (Atlas Cloud/BytePlus); для WaveSpeed video-edit точные лимиты `reference_images` в схеме не опубликованы — проверяйте в playground.**

### Вопрос 2 — Порядок reference_images и обращение к ним в промпте

**Подтверждено (кросс-провайдер):** порядок важен. Официальная логика ByteDance/BytePlus и fal.ai: изображения нумеруются в порядке передачи в массиве, и в промпте к ним обращаются по этому порядковому номеру. **Синтаксис обращения различается по провайдерам и НЕ является единым стандартом:**
- **`@Image1`, `@Video1`, `@Audio1`** — стиль, документированный в блоге WaveSpeed и на fal.ai; в рабочем примере официального BytePlus SDK (по данным стороннего туториала) также используется `@Image1`.
- **`[Image1]`** — конвенция Replicate.
- **`image 1` / `Image 1`** — конвенция fal/Atlas Cloud.

**Критическое предупреждение по вашему endpoint (уровень: неподтверждённая гипотеза для video-edit).** Синтаксис `@Image1` документирован WaveSpeed в **блоге и для reference-to-video**, но **на официальной странице схемы `seedance-2.0/video-edit` он НЕ описан**. Более того, у video-edit нет поля `video_urls` — есть единственный `video`, поэтому обращение `@Video1` к «исходному видео» на этом endpoint неприменимо так, как в reference-to-video. Практический безопасный подход: описывать референсы **естественным языком по порядку** («the woman's face and body follow the first reference image; the motorcycle matches the second reference image») и параллельно A/B-тестировать `@Image1`/`the first image`. Не считайте `@`-синтаксис гарантированным для этого endpoint, пока не проверите его на своём аккаунте.

**Отдельно: «роли» reference-ов.** Ходовая в интернете схема с ролями `subject/environment/motion/object` — это **конструкция стороннего агрегатора (apiyi.com), а НЕ официальная схема**. Реальный `content[]`-массив BytePlus использует роли `reference_image / first_frame / last_frame / reference_video / reference_audio`. WaveSpeed video-edit ролей у изображений в схеме вообще не выставляет. Не полагайтесь на «role: subject».

### Вопрос 3 — Разделение источников identity / motion / environment / object в промпте

Поскольку в video-edit **исходное видео уже само по себе является источником motion + environment + camera**, вам НЕ нужно описывать их как отдельный «источник» — их достаточно защитить формулировкой «keep unchanged». Рабочая модель (несколько практиков):
- **Identity (новая модель)** → из `reference_images` (первое изображение): «the woman's face, body and skin match the first reference image».
- **Object (новый объект)** → из `reference_images` (следующее изображение): «the motorcycle matches the second reference image».
- **Motion / pose / timing / camera / environment / lighting** → из `video` (исходник): «keep the exact same body motion, pose, camera movement, framing, background, and lighting as the input video».
- Общий принцип от практиков: «text defines the world, images lock identity, video guides movement» — но в video-edit роль «video guides movement» уже выполняет исходный клип.

### Вопрос 4 — Структура промпта для точечной замены персонажа

Подтверждённый практикой шаблон (OpusClip, PromeAI, ima studio, seedanceai.cc):
1. **Команда замены + что именно менять:** «Replace only the woman with the woman from the first reference image.»
2. **Явный список того, что НЕ трогать:** «Keep all camera movement, lighting, background, hand positions, timing and body motion exactly as they are.»
3. **Привязка масштаба/позиции:** «The new woman matches the same scale, position and body pose as the original throughout the entire video.»

Ключ (по нескольким источникам): чем жёстче зафиксировано «что сохранить», тем выше сохранность оригинала. Формулируйте позитивно (Seedance не поддерживает negative prompt — см. вопрос 7). Первые 20–30 слов несут наибольший вес — начинайте с субъекта и действия.

### Вопрос 5 — Как не дать измениться фону, камере, движению, позе, контакту

**Вероятные практические приёмы (несколько источников):**
- Явно перечислить «protected region»: «Keep the subject unchanged: silhouette, contact points, reflections», «Keep camera, timing, background unchanged».
- Менять по одному элементу за прогон; прямо сообщать модели, что не должно двигаться.
- Строка-ограничитель против отсебятины: «Do not introduce new elements; only continue existing motion.»
- Короткая длительность (6–8 с) резко снижает дрейф (тест WaveSpeed/Dora: после 12 с появляются смены костюма и цвета в середине кадра).

### Вопрос 6 — Temporal consistency лица, тела, одежды, объекта

- Модель объективно сильна в консистентности (см. Key Finding 6: лидерство по image preservation и motion quality в SeedVideoBench-2.0, arXiv:2604.14148). Это подтверждённый факт из препринта ByteDance.
- **Практика:** держите клип коротким (3–8 с — «sweet spot»); референс-фото модели — высокого разрешения, ровный свет, лицо/тело без резких теней; не смешивайте разные ракурсы/температуру света в референсах (это провоцирует «усреднение» черт); 2 согласованных референса лучше 6 разнородных (по замеру одного практика — снижение дрейфа примерно на 60% при сокращении с 6 фото до 2).
- Для заменяемого объекта — фиксируйте отличительные детали и требуйте «logo/details stay sharp and readable».

### Вопрос 7 — Ошибки рук, ног, пальцев, контакта с мотоциклом, геометрии объекта

**Подтверждённый факт: Seedance 2.0 НЕ поддерживает negative prompt.** Фразы «no distorted hands», «no blur» могут усиливать нежелательное, т.к. модель читает существительное как контент. **Заменяйте на позитивные формулировки:** «five fingers on each hand, natural hand-object contact», «sharp, in focus».

**Вероятные практические приёмы:**
- Медленные, плавные жесты вместо быстрых; крупные руки в кадре, а не мелкие вдали.
- Не прятать руки за объектами и не перекрывать их.
- Для контакта тела с мотоциклом: явно описать точки контакта («hands firmly on the handlebars, feet on the pegs»), требовать «consistent hand-grip on the handlebars».
- Для геометрии объекта: «straight lines stay straight, the object keeps rigid geometry, no melting edges».
- Если руки не важны — кадрировать так, чтобы их не было.
- «Bug-report»-подход для точечной починки: изолировать проблемный сегмент (+0.5 с с обеих сторон), описать ошибку как баг («frames 24–40: right hand deforms»), задать анатомические/геометрические ограничения и потребовать «continuity with surrounding frames».

### Вопрос 8 — Один edit vs два последовательных

**Подтверждённый факт (несколько источников):** повторный прогон сгенерированного видео как нового исходника накапливает деградацию (пятна на лицах, «crunchy» края, рассинхрон грейда). Отсюда рекомендация:

- **Один edit (предпочтительно), когда объект жёстко контактирует с телом** (мотоцикл, шлем, одежда): «Replace the woman with [ref1] and the motorcycle with [ref2] in a single edit; keep motion, camera, lighting, background unchanged.» Плюс: нет второй генерации → нет второй потери качества; контакт тело-объект решается согласованно. Минус: модели нужно удержать две замены сразу — риск, что при перегрузе «плывёт» приоритетное (лицо).
- **Два последовательных edit — только если объект отделён от персонажа** (например, автомобиль на фоне). Плюс: проще формулировать и отлаживать по одному. Минус: второй прогон — документированная деградация; выше суммарная цена (биллинг за input+output обоих прогонов).
- **Компромисс (вероятный приём):** первый edit — персонаж, затем **точечный «repair»-edit** только на коротком проблемном сегменте (1–2 с) с описанием как bug-report, а не второй полноразмерный прогон.

### Вопрос 9 — Сохранение исходного аудио

**Подтверждённый факт:** `generate_audio: false` → «the input video's audio track is preserved on the output instead». Отдельного параметра audio-passthrough/volume в схеме video-edit нет; `reference_audios` — это про генерацию нового звука, а не про сохранение оригинала. Для вашей задачи (реализм «снятого видео») ставьте `generate_audio: false`.

### Вопрос 10 — Вертикаль 9:16 и чёрные полосы

- **Подтверждённый факт:** `aspect_ratio` поддерживает `9:16`; если не задан — адаптируется к входу. Значит, для вертикального исходника корректный путь — либо не задавать `aspect_ratio` (адаптация к входу), либо явно `9:16`.
- **Летербоксинг (вероятная причина, кросс-провайдер):** чёрные полосы/горизонтальный выход возникают, когда соотношение сторон референс-изображений/входа конфликтует с целевым. Зафиксированный на GitHub баг Krea: при landscape-референсе в наборе `--aspect 9:16` игнорировался и выдавался 1280×720. Лечение: приводить референсы к портретному кропу до загрузки (padding/scale через ffmpeg) либо убирать landscape-референсы; и/или полагаться на адаптацию к входу.
- **Практика:** выбирайте ratio до генерации, вертикальный исходник → вертикальные референсы; не кропите горизонтальный выход в 9:16 постфактум (потеря качества при транскодировании).

### Вопрос 11 — Preprocessing исходного видео

**Вероятные практические приёмы (несколько источников):**
- **Длительность/обрезка:** резать исходник до самых релевантных 4–8 с (WaveSpeed «Pro tip»: 4–15 с; практики — 6–8 с для минимизации дрейфа). Обрезать «хвосты» с лишними микродвижениями (практик Dora: снимать по 4–6 кадров с начала/конца).
- **Один идей-вектор на клип:** либо двигается субъект, либо камера — не всё сразу.
- **FPS:** модель работает в 24 fps (кинематографический стандарт, естественный motion blur); кросс-провайдерный лимит входного видео — FPS 24–60.
- **Разрешение/кодек:** mp4/mov, стороны 300–6000 px, ≤50 МБ (кросс-провайдер). Не подавать пере-сжатый мыльный исходник — «низкое качество на входе = низкое качество на выходе».
- **Качество референс-фото модели:** высокое разрешение, ровный фронтальный/трёхчетвертной свет, без резких теней на лице, отличительная одежда/аксессуары; не давать один композит-коллаж (лицо получит мало пикселей → дрейф). Соотношение сторон референса согласовать с целевым выходом.

### Вопрос 12 — Standard vs Fast для character replacement

- **Подтверждено (схема):** оба варианта используют одинаковую схему и параметры; fast — дешевле (17–33% по семейству) и быстрее. По документации WaveSpeed оба поддерживают 480p/720p/1080p.
- **Вероятный практический консенсус (несколько провайдеров):** standard даёт более высокую итоговую фидельность, стабильнее текстуры/лица, лучше держит плотное движение и мелкие детали; fast — для итераций, таймингов, черновиков. Рабочий паттерн: **находишь промпт/референсы/ракурс на fast (480p), финал гонишь на standard (720p/1080p).** Для character replacement, где важна идентичность лица и контакт с объектом, финал — только standard.
- Замечание: сравнения «standard vs fast» у ряда провайдеров относятся к T2V/I2V, но паттерн «fast=черновик, standard=финал» практики распространяют и на video-edit.

---

## Recommendations

### 10 главных практических правил
1. **Используйте именно `seedance-2.0/video-edit`** (не image-to-video, не reference-to-video) — только он сохраняет motion/camera/environment исходника.
2. **Ставьте `generate_audio: false`** — сохраняете оригинальный звук и «эффект снятого видео».
3. **В промпте явно перечисляйте, что сохранить** (camera, motion, pose, background, lighting, timing, contact points) — это главный рычаг реализма.
4. **Меняйте персонаж и жёстко контактирующий объект (мотоцикл/шлем/одежда) в один edit**, а не двумя прогонами — второй прогон деградирует картинку.
5. **Черновики на `-fast` 480p, финал на standard 720p/1080p.**
6. **Держите клип 4–8 с** — длиннее растёт дрейф идентичности и «смена костюма».
7. **Референс-фото модели: высокое разрешение, ровный свет, отличительная одежда, без коллажей;** 2 согласованных лучше 6 разнородных.
8. **Никаких negative prompt** — формулируйте позитивно («five fingers», «sharp, in focus»).
9. **Согласуйте соотношение сторон референсов с целевым `aspect_ratio`** (для 9:16 — портретные референсы), иначе летербоксинг.
10. **Меняйте по одному параметру за итерацию** и ведите лог (seed недоступен — фиксируйте prompt/inputs/версию модели).

### Рекомендуемый порядок reference images
1. **Первое изображение — лицо/тело новой модели** (identity, самый приоритетный якорь). Крупный чистый портрет.
2. **Второе изображение — одежда модели** (если требуется и её нет на первом фото).
3. **Третье изображение — заменяемый объект** (мотоцикл/шлем/автомобиль), чётко, изолированно, при хорошем свете.

Обращайтесь к ним в промпте по порядку и естественным языком («the first reference image», «the second reference image»); `@Image1` пробуйте, но не полагайтесь как на гарантию для этого endpoint.

### Оптимальная модульная структура промпта (video-edit)
```
[EDIT COMMAND] Replace only the woman (and the <object>) in the video.
[IDENTITY]     The woman's face, body, hair and skin match the first reference image.
[OBJECT]       The <object> matches the second reference image (same shape, color, logo).
[PRESERVE]     Keep the exact same body motion, pose, hand positions, camera movement,
               framing, background, location, lighting, shadows, reflections and timing
               as the input video.
[CONTACT]      Keep natural, consistent contact between the woman and the <object>
               (hands on the handlebars, feet on the pegs), five fingers on each hand.
[REALISM]      Preserve the original live-action look, motion blur and film grain.
               Do not introduce new elements; do not restyle the scene.
```

### Короткий production-промпт — замена только девушки (English)
> Edit the input video. Replace only the woman with the woman from the first reference image — same face, body, hair and skin tone. Keep the exact same body motion, pose, hand and finger positions, camera movement, framing, background, location, lighting, shadows and timing as the original. Preserve the real live-action look, motion blur and film grain. Natural anatomy, five fingers on each hand. Do not restyle the scene or add new elements.

### Промпт — замена девушки и мотоцикла (English)
> Edit the input video. Replace only two things: (1) the woman, matching the face, body, hair and skin of the first reference image; (2) the motorcycle, matching the shape, color and details of the second reference image. Keep everything else identical to the input video: body motion, riding pose, hand grip on the handlebars, feet on the pegs, camera movement, framing, road, background, lighting, shadows and reflections, and timing. Keep rigid, correct motorcycle geometry and consistent hand-object contact. Preserve the original live-action realism, motion blur and film grain. Do not add new elements or restyle the scene.

### Вариант с first-frame reference
**Не подтверждён для video-edit endpoint.** `first_frame`/`last_frame` — роли из image-to-video / reference-схемы (fal: `end_image_url`; BytePlus `content[]` role `first_frame`). На странице схемы `seedance-2.0/video-edit` полей start/end-frame нет. Использовать технику first-frame нужно на другом endpoint (image-to-video), что противоречит задаче «сохранить исходное видео». **Рекомендация: не полагаться на first-frame внутри video-edit, пока WaveSpeed не подтвердит поле в схеме.** Если нужна проверка — вынесите тест в A/B-план (прогон-эксперимент), но по умолчанию считайте технику недоступной для этого endpoint.

### Вредные / бесполезные формулировки в промптах
- Negative prompt любого вида: «no distorted hands», «no blur», «don't show text» — усиливают нежелательное.
- Перегруз стилевыми прилагательными («epic», «cinematic vibe», «cool») — размывают правку.
- Множество действий в одном клипе — провоцирует деформацию.
- «Regenerate the whole scene» вместо точечной правки — теряете сохранность оригинала.
- Указание формата/длительности/fps словами в промпте («9:16, 15s, 4K») — это параметры, а не текст.
- Полагание на `@Image1`, `seed`, `mask`, `negative_prompt`, `start_frame`, weight-синтаксис («@Image1 70% weight») как на гарантированные функции video-edit — они не подтверждены схемой.

### Таблица: проблема → вероятная причина → фикс prompt → фикс inputs
| Проблема | Вероятная причина | Фикс в prompt | Фикс в inputs |
|---|---|---|---|
| Меняется фон/локация | Не зафиксировано «preserve» | Добавить «keep background, location, lighting unchanged» | Короче клип; убрать лишние референсы фона |
| Дрейф лица модели | Длинный клип / разнородные референсы | «face matches the first reference image throughout» | 3–8 с; 1–2 согласованных чистых портрета |
| Плывут руки/пальцы | Быстрые жесты, мелкие руки, negative prompt | Позитивно: «five fingers, natural grip»; замедлить жест | Кадрировать крупнее руки; исходник без быстрых жестов |
| «Тает» мотоцикл/геометрия | Перегруз замены, слабый референс объекта | «rigid geometry, straight lines stay straight» | Чёткое изолированное фото объекта, хороший свет |
| Рассинхрон контакта тело-объект | Раздельные прогоны | Делать в один edit; «consistent hand-object contact» | Один edit вместо двух |
| Летербоксинг/чёрные полосы | Конфликт ratio референсов и выхода | — | Портретные референсы для 9:16; ffmpeg-паддинг; не задавать ratio (адаптация к входу) |
| Пропал/переозвучен звук | `generate_audio: true` | — | `generate_audio: false` |
| Общая деградация после доработки | Повторный прогон вывода как входа | Точечный repair 1–2 с вместо полного прогона | Не гонять выход обратно как исходник многократно |
| Мыльный результат | Пере-сжатый исходник/референс | — | Исходник и фото — высокое разрешение, ≤50 МБ видео |
| Отсебятина (новые объекты) | Слишком общий промпт | «Do not introduce new elements» | — |

### Минимальный A/B-план (8–12 генераций)
Все прогоны — на `-fast`, 480p, длительность фикс. (напр. 6 с), один и тот же исходник и референсы, меняем ровно один фактор за прогон.
1. Базовый промпт, только замена девушки, `generate_audio:false`.
2. То же + усиленный блок PRESERVE (расширенный список «keep unchanged»).
3. То же + жёсткая привязка масштаба/позиции.
4. Референсы: 1 портрет.
5. Референсы: 2 согласованных портрета (сравнить с №4 на дрейф).
6. Синтаксис ссылок: естественный язык.
7. Синтаксис ссылок: `@Image1` (сравнить с №6 на сохранность идентичности).
8. Замена девушки + объект в ОДИН edit.
9. Замена девушки, затем отдельный edit объекта (два прогона) — сравнить деградацию с №8.
10. aspect_ratio не задан (адаптация к входу) при вертикальном исходнике.
11. Явный `9:16` + портретные референсы — проверить летербоксинг (сравнить с №10).
12. Победивший промпт — финал на standard 720p/1080p (контроль качества).

Метрики на каждом прогоне: сохранность фона/камеры/тайминга; стабильность лица; руки/пальцы; контакт с объектом; геометрия объекта; наличие летербокса; сохранность звука.

### Пример JSON-запроса к WaveSpeedAI (без API-ключа)
```json
POST https://api.wavespeed.ai/api/v3/bytedance/seedance-2.0/video-edit
Content-Type: application/json
Authorization: Bearer <WAVESPEED_API_KEY>

{
  "prompt": "Edit the input video. Replace only the woman with the woman from the first reference image (same face, body, hair, skin). Keep the exact same body motion, pose, hand positions, camera movement, framing, background, location, lighting, shadows and timing as the original. Preserve the live-action look, motion blur and film grain. Five fingers on each hand. Do not restyle the scene or add new elements.",
  "video": "https://your-host.com/source-clip.mp4",
  "reference_images": [
    "https://your-host.com/model-face-body.jpg"
  ],
  "aspect_ratio": "9:16",
  "resolution": "720p",
  "duration": 6,
  "enable_web_search": false,
  "generate_audio": false
}
```
Поллинг результата:
```json
GET https://api.wavespeed.ai/api/v3/predictions/{request_id}/result
Authorization: Bearer <WAVESPEED_API_KEY>
// при status = "completed" читать data.outputs[0]
```

## Caveats
- **Не подтверждены документацией video-edit endpoint и не должны использоваться как гарантированные:** `seed`, `negative_prompt`, `mask`, `start_frame`/`first_frame`, weight-синтаксис («@Image1 70% weight»), сам синтаксис `@Image1` для этого конкретного endpoint. Всё это встречается либо в блогах, либо у других endpoint/провайдеров.
- **Лимиты `reference_images` (кол-во, размер) для WaveSpeed video-edit в явной схеме не опубликованы** — приведённые числа (9 изображений, <30 МБ, 300–6000 px) взяты из общей мультимодальной схемы Seedance 2.0 у сторонних хостов (Atlas Cloud/BytePlus); проверяйте в playground WaveSpeed.
- **Ролевая схема `subject/environment/motion/object`** — конструкция стороннего агрегатора (apiyi.com), а не официальная; официальный `content[]` BytePlus использует роли `reference_image/first_frame/last_frame/reference_video/reference_audio`. Не полагайтесь на «role: subject».
- **Официальные страницы BytePlus ModelArk (schema video-edit) технически не читаются стандартным фетчером** (JS-SPA) — часть кросс-провайдерных деталей подтверждена через сторонние хосты и SDK-туториалы, а не напрямую из первичной схемы.
- **Ограничение контента:** ByteDance-гайдрелсы блокируют реальные узнаваемые лица/знаменитостей; при дрейфе лицо может «съехать» к реальному публичному человеку и генерация будет отклонена на ревью. Держите идентичность стабильной.
- **Fast vs standard по разрешению:** WaveSpeed-документация даёт fast video-edit 480p/720p/1080p, но у ряда других провайдеров fast ограничен 720p — при переносе пайплайна между провайдерами проверяйте потолок разрешения. Точный % экономии Fast — 17–33% в зависимости от разрешения/длительности; уточняйте в playground.
- Все цены и лимиты актуальны на 19 июля 2026 и могут меняться; сверяйтесь с playground и API-reference WaveSpeed перед продакшном.