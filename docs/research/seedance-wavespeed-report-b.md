# Глубокое техническое исследование WaveSpeedAI endpoint bytedance/seedance-2.0/video-edit

## Ключевой вывод

Для вашей задачи — заменить в уже существующем реалистичном видео только девушку на вашу AI-модель, иногда дополнительно заменить один объект, и при этом максимально сохранить реальное движение, камеру, окружение, свет и «ощущение снятого видео» — именно `bytedance/seedance-2.0/video-edit` на WaveSpeed выглядит правильной точкой входа. По собственной документации WaveSpeed этот endpoint редактирует **входное видео** по текстовой инструкции, а само входное видео остаётся носителем **identity/composition/motion**; модель переписывает только указанные элементы. Это хорошо совпадает с вашей постановкой. **Уверенность: высокая.** citeturn37view1turn12view1

Главное ограничение исследования на 19 июля 2026 года такое: у WaveSpeed есть **частично противоречащая сама себе документация** по этому endpoint. На одной и той же модели публичные страницы уверенно подтверждают `prompt`, `video`, `reference_images`, `aspect_ratio`, `resolution`, `enable_web_search`, `generate_audio`; в prose-описаниях также явно указаны `duration` и `reference_audios`, но в машиноподобной таблице request-parameters они не перечислены. Поэтому `duration` и `reference_audios` я считаю **вероятно поддерживаемыми, но подтверждёнными слабее, чем остальное**. **Уверенность: высокая в факте расхождения; средняя в поддержке этих двух полей.** citeturn22view4turn37view1turn3view2turn4view5

Вторая ключевая вещь: в экосистеме Seedance в целом есть материалы, где используются конструкции вроде `@Image1`, `@Video1` и формулы наподобие `strictly edit <Video_X>, [Specific_Edits]`. Это встречается у WaveSpeed в обзорном блоге по Seedance 2.0, у официального BytePlus/ModelArk prompt guide и у других провайдеров вроде Renderful. Но **на странице именно WaveSpeed Video Edit endpoint этого синтаксиса нет**: поле `reference_images` задокументировано как обычный массив URL без адресации `@Image1`, и поиск по странице не находит `@Image1`, `mask`, `negative`, `start frame`. Поэтому для этого endpoint нельзя честно утверждать поддержку `@Image1`, `[Image1]`, mask, seed, negative prompt или start frame, пока это не показано live-schema именно в вашем аккаунте WaveSpeed. **Уверенность: высокая.** citeturn30view2turn32search1turn16view0turn37view0turn37view2turn37view3turn37view6

Практический вывод из этого: для вашей задачи safest-path — строить промпт не через «адресацию файлов», а через **семантическое разделение ролей**: кто даёт identity, что остаётся от source video, какой объект заменяется, и что должно остаться полностью неизменным. Если нужна очень стабильная замена девушки плюс жёсткий объектный контакт с мотоциклом/авто/шлемом, наиболее рациональная тактика — сначала протестировать в `fast`, а финальные кадры рендерить в `standard`; при высоком риске геометрических ошибок — чаще выигрывает **двухшаговый workflow**: сначала девушка, потом объект, а не обе замены сразу. Последний тезис — это уже практический вывод, а не прямой факт из документации. **Уверенность: высокая для fast-vs-standard как черновик-vs-финал; средняя для двухшагового workflow.** citeturn22view4turn22view5turn38view0turn14view0turn19view0turn20view4turn20view5

## Что точно подтверждено по WaveSpeed Video Edit

### Endpoint, workflow и базовые лимиты

WaveSpeed использует общий REST base URL `https://api.wavespeed.ai/api/v3`, авторизацию через `Authorization: Bearer ...`, асинхронную схему submit → poll result, статусы `created / processing / completed / failed / cancelled / timeout`, и рекомендует начинать polling примерно раз в 2 секунды, затем увеличивать интервал для длинных задач. Для production вместо polling можно использовать webhook через query-параметр `?webhook=...`. **Уверенность: высокая.** citeturn24view1turn24view2

Для загрузки ассетов WaveSpeed документирует отдельный upload endpoint `POST https://api.wavespeed.ai/api/v3/media/upload/binary`; после upload вы получаете URL, который и передаёте в поля модели. Поддерживаются изображения, видео и аудио; для видео перечислены `MP4, AVI, MOV, WMV, FLV, WebM, MKV, 3GP, OGV`, для аудио — `MP3, WAV, OGG, AAC, FLAC, WebM, M4A, Opus`. **Уверенность: высокая.** citeturn24view0

По лимитам самого Video Edit endpoint WaveSpeed прямо пишет: входные видео длиннее 15 секунд автоматически **обрезаются до первых 15 секунд**, входы короче 2 секунд **паддятся последним кадром до 2 секунд**, а выходная длина документирована как **4–15 секунд**; если длина явно не задана, она автоопределяется на основе входного ролика и затем clamp’ится в диапазон 4–15 секунд. Биллинг считается по сумме **input duration + output duration**. **Уверенность: высокая.** citeturn22view4turn22view5

Официальные материалы ByteDance Seed для Seedance 2.0 в более общем виде говорят, что модель поддерживает четыре модальности входа — text, image, audio, video — и на open platform допускает до **3 videos, 9 images, 3 audio clips**, с длительностью output **4–15 seconds** и native resolutions **480p и 720p**. Важно: это описывает платформу Seedance/Seed в целом, а не специфический WaveSpeed JSON surface. **Уверенность: высокая.** citeturn12view0turn12view3

### Параметры, которые действительно видны в документации

Ниже — разбор полей именно для WaveSpeed `bytedance/seedance-2.0/video-edit` с разделением на более и менее надёжно подтверждённые.

| Поле | Статус в документации WaveSpeed | Практический вердикт |
|---|---|---|
| `prompt` | есть и в prose, и в request schema citeturn22view4turn3view2 | Подтверждено. **Уверенность: высокая** |
| `video` | есть и в prose, и в request schema citeturn22view4turn3view2 | Подтверждено. **Уверенность: высокая** |
| `reference_images` | есть и в prose, и в request schema citeturn22view4turn3view2 | Подтверждено. **Уверенность: высокая** |
| `aspect_ratio` | есть и в prose, и в request schema; allowed: `16:9`, `9:16`, `4:3`, `3:4`, `1:1`, `21:9`; если не задан, адаптируется к input citeturn22view4turn3view2 | Подтверждено. **Уверенность: высокая** |
| `resolution` | есть и в prose, и в request schema; default `720p`; allowed: `480p`, `720p`, `1080p`, `4k` на WaveSpeed citeturn22view4turn3view2 | Подтверждено для WaveSpeed. **Уверенность: высокая** |
| `enable_web_search` | есть и в prose, и в request schema; default `false` citeturn22view4turn3view2 | Подтверждено. **Уверенность: высокая** |
| `generate_audio` | есть в request schema, но не в prose-таблице параметров; default `true` citeturn3view2turn4view5 | Подтверждено, несмотря на неполную prose-таблицу. **Уверенность: высокая** |
| `duration` | есть в prose-таблице и notes, но отсутствует в request schema excerpt citeturn22view4turn22view5turn3view2 | Вероятно поддерживается, но docs несогласованы. **Уверенность: средняя** |
| `reference_audios` | есть в prose-таблице и how-to-use, но отсутствует в request schema excerpt citeturn22view4turn22view5turn3view2 | Вероятно поддерживается, но docs несогласованы. **Уверенность: средняя** |

Отдельно важно отметить, что WaveSpeed выводит у этого endpoint варианты `1080p` и `4k`, а также тарифы для них. Но официальный arXiv/model card Seedance 2.0 называет native resolutions только `480p` и `720p`. Из этого следует аккуратный практический вывод: на WaveSpeed 1080p/4k надо трактовать как **provider-exposed output tiers**, а не как безусловно нативное разрешение самой базовой модели. **Уверенность: высокая в факте расхождения; средняя в интерпретации как provider-side tiering/upscaling.** citeturn22view4turn22view5turn12view3

### Цены, скорость и rate limits

Для `standard` Video Edit WaveSpeed публикует цены `$0.075/s` для `480p`, `$0.15/s` для `720p`, `$0.375/s` для `1080p` и `$0.75/s` для `4k`, считая биллинг по сумме input+output seconds. Для `fast` цены немного ниже: `$0.065/s`, `$0.13/s`, `$0.325/s`, `$0.65/s`. **Уверенность: высокая.** citeturn22view4turn22view5

На model card `fast` WaveSpeed прямо пишет median end-to-end generation time около **215 секунд**. Для `standard` на исследованной странице я не нашёл столь же чётко подтверждённого median-time на доступной API docs surface, поэтому корректно говорить только, что `fast` документирован как более быстрый и более дешёвый tier. **Уверенность: высокая для fast; низкая для точного median standard, поэтому я его не утверждаю.** citeturn38view0

По общим лимитам аккаунта WaveSpeed новые аккаунты находятся в Bronze tier с лимитом **2 predictions/min** и **2 concurrent tasks**; после top-up лимиты резко растут, вплоть до Ultra с **5000 predictions/min** и **10000 concurrency**. Поэтому при серийных A/B-тестах на Bronze вы упрётесь в лимиты почти мгновенно. **Уверенность: высокая.** citeturn28view0

### Что endpoint не подтверждает

Публичная страница именно этого endpoint не документирует `mask`, `seed`, `negative prompt`, `start frame`, `@Image1` и похожие функции: поиск по странице не находит их. Следовательно, до появления этих полей в live schema или официальном changelog их нельзя честно считать поддерживаемыми на `bytedance/seedance-2.0/video-edit` у WaveSpeed. **Уверенность: высокая.** citeturn37view0turn37view2turn37view3turn37view6

## Что известно и чего не известно о reference images

### Имеет ли значение порядок reference images

На этом конкретном endpoint WaveSpeed документирует `reference_images` как **неименованный массив URL**, но не даёт способа в prompt адресовать элементы массива по имени. То есть факт существования **порядка** как свойства JSON-массива очевиден, но факт **семантической адресации** этого порядка в prompt на WaveSpeed Video Edit не подтверждён. **Уверенность: высокая.** citeturn22view4turn3view2turn37view6

В более широкой экосистеме Seedance ситуация другая. WaveSpeed в своём обзорном блоге по Seedance 2.0 пишет про `@Image1`, `@Video1`, `@Audio1`, показывает паттерн `Replace the woman in @Video1 with @Image1`, а официальный BytePlus/ModelArk prompt guide выдаёт формулу вида `strictly edit <Video_X>, [Specific_Edits]`. У Renderful тот же класс задач описан через `[Video1]` и `[Image1]`. Это говорит о том, что **в других поверхностях Seedance-пайплайна адресация ассетов действительно существует**. Но это не делает её автоматически подтверждённой для WaveSpeed Video Edit API schema. **Уверенность: высокая.** citeturn30view2turn32search1turn16view0

Практический вывод: для WaveSpeed Video Edit надо исходить из conservative assumption — **порядок reference_images может влиять только неявно**, как priors/conditioning, но не как `Image 1`, `@Image1` или `[Image1]` в тексте. Поэтому safest approach — класть изображения по силе сигнала: сначала главное identity anchor, потом вторичный угол/полный рост, потом одежда, потом объект. Это уже не подтверждённый факт, а рабочая эвристика, согласующаяся с рекомендацией WaveSpeed «prioritize the assets that have the greatest impact» и с обсуждениями character sheets в сообществе. **Уверенность: средняя.** citeturn30view0turn19view0turn20view5

### Рекомендуемый порядок reference images

Ниже — **рекомендуемый**, а не официально задокументированный порядок для вашего use case:

1. **Identity anchor**: нейтральный, хорошо освещённый, максимально чистый фронтальный или 3/4-портрет вашей AI-модели, без экстремальной мимики. Это лучший якорь для лица и кожи. Основание: community tests стабильно указывают, что один и тот же high-quality frontal reference даёт меньше drift. **Уверенность: средняя.** citeturn19view0  
2. **Body / full-body anchor**: полный рост в той же одежде, которая вам нужна, на нейтральном фоне. Это помогает не только лицу, но и телесным пропорциям. **Уверенность: средняя.** citeturn20view5  
3. **Secondary angle**: боковой или 3/4-ракурс той же девушки в той же одежде. Это снижает переинтерпретацию профиля и поворотов головы. **Уверенность: средняя.** citeturn20view5  
4. **Clothing detail** при необходимости: отдельный чистый референс одежды, если одежда критична и отличается от body anchor. **Уверенность: средняя-низкая.** citeturn20view4  
5. **Object reference**: если меняете мотоцикл/шлем/авто, кладите его отдельно и позже, после identity refs, чтобы модель не спутала приоритеты персонажа и объекта. **Уверенность: средняя-низкая.** Основание: docs советуют приоритизировать сильнейшие ассеты, а community отмечает, что слабая структурированность refs ведёт к drift. citeturn30view0turn20view5

Если нужен только swap девушки, чаще всего достаточно **2–3 сильных identity refs**, а не 8–9 слабых. Это уже практический вывод: docs говорят «приоритизируйте самые важные файлы», а community посты про continuity подчёркивают ценность плотного, но структурированного character sheet вместо случайного набора картинок. **Уверенность: средняя.** citeturn30view0turn20view1turn19view0

## Рабочая стратегия prompt и inputs для точечной замены персонажа

### Как разделять identity, motion, environment и object в prompt

Поскольку у WaveSpeed Video Edit нет подтверждённой файловой адресации, делить источники надо не через `@Image1`, а через **словесные блоки ролей**. Практически лучший паттерн такой: сначала назвать **единственное изменение**, потом явно перечислить всё, что должно остаться из original video, затем — при необходимости — добавить object block, и в конце заблокировать unwanted rewrites. Это хорошо согласуется и с WaveSpeed pro tips «be specific about what should change and what should stay the same», и с BytePlus prompt guide `strictly edit <Video_X>, [Specific_Edits]`. **Уверенность: высокая.** citeturn22view4turn32search1turn33search2

Семантически разделение для вашего use case должно выглядеть так:

- **Identity block**: внешность и тело новой модели, при необходимости одежда.  
- **Preservation block**: original movements, pose, action timing, camera path, framing, environment, lighting, shadows, reflections, interaction physics, motion blur.  
- **Object block**: если меняется объект, то only replace [object] with the referenced [object], keep scale, position, contact points and motion consistent.  
- **Realism block**: keep live-action realism, photorealistic skin, natural motion blur, physically correct contact, no newly generated look.  

Это не официальный синтаксис, а рекомендуемая prompt-архитектура, выведенная из docs + практики. **Уверенность: средняя-высокая.** citeturn22view4turn30view2turn19view0turn20view5

### Как минимизировать изменение фона, камеры, движения и позы

Самый важный приём — не просить модель «создать новую сцену», а просить её **edit only the specified subject/object**. В формулировках надо писать не просто «replace the girl», а сразу добавлять: **keep the original body motion, pose timing, camera movement, framing, background, lighting, shadows, reflections, and all object interactions unchanged**. У WaveSpeed есть собственный пример такого типа: заменить чёрного жеребца на леопарда, сохранив все движения, scenery, lighting и composition полностью неизменными. **Уверенность: высокая.** citeturn38view1

В practical terms это означает: избегайте художественных слов, которые расширяют перерисовку всей сцены — `cinematic`, `dramatic`, `stylized`, `epic`, `beautiful`, `reimagine the scene`, если ваша цель — не генерация нового клипа, а локальный swap. Эти слова полезны, когда вы хотите стилизацию; они вредны, когда вы хотите незаметный replacement внутри live-action footage. Это уже практический вывод, но он напрямую вытекает из того, что docs по Video Edit двигают endpoint в сторону targeted edits, а не wholesale regeneration. **Уверенность: средняя.** citeturn37view1turn12view1

### Temporal consistency, руки, ноги и контакт с объектом

Официально Seedance 2.0 заявляет хорошие motion stability и action continuity, но сам ByteDance признаёт, что детализация, hyper-realism и некоторые эффекты редактирования всё ещё требуют доработки. В community-тестах главные способы уменьшать drift — использовать один и тот же сильный reference image, не менять словесное описание персонажа между ранами, собирать character/pose sheet с front/side/back и facial closeups, а также держать одинаковый outfit и нейтральный фон в самих референсах. **Уверенность: высокая для наличия проблем и общих мер; средняя для силы эффекта каждой меры.** citeturn12view1turn19view0turn20view5turn20view1

Для рук, ног, пальцев и контакта с мотоциклом критично, чтобы исходный клип уже был «читаемым»: силуэты не должны быть забиты motion blur, рука на руле/баке/шлеме должна быть видна, а объект не должен перекрываться на половину другими объектами. Это уже inference, но он согласуется с рекомендацией WaveSpeed заранее обрезать и чистить source clip, а community-практика показывает, что слабые ракурсы и недостающие углы в refs ведут к переинтерпретации. **Уверенность: средняя.** citeturn22view4turn20view5

Если контакт с объектом ключевой — например, ладони на руле, колени у бака, шлем в руке — промпт должен отдельно фиксировать **contact points**: *keep the hand placement on the handlebars identical*, *keep both feet placement and leg angles unchanged*, *retain the original contact pressure and interaction geometry*. Это уже не подтверждённый шаблон docs, а сильный practical trick. **Уверенность: средняя.** Основание: docs требуют specificity of change/stay, а ошибки контакта — типовая failure mode community workflows. citeturn22view4turn20view4

### Один edit или два последовательных edits

Если меняется только девушка — делайте один edit. Если меняется девушка **и** объект, особенно когда объект физически контактирует с телом и имеет сложную геометрию (мотоцикл, автомобиль, шлем в руке), у вас резко растёт число степеней свободы: модель должна одновременно удержать identity, одежду, body proportions, object geometry и contact mechanics. В таких случаях наиболее разумная production-гипотеза — чаще olacaq лучше **два прохода**: сначала character replacement, затем object replacement. **Уверенность: средняя.** citeturn37view1turn20view4turn20view5

Я бы делил decision rule так: если объект находится далеко от тела и не доминирует в кадре, можно пробовать one-pass. Если объект крупный, закрывает тело или является главным contact surface, закладывайте two-pass как base workflow и оставляйте one-pass только как A/B-вариант на экономию времени/кредитов. Это уже практический вывод, который нужно валидировать на ваших клипах. **Уверенность: средняя-низкая, требует A/B.** citeturn20view4turn20view5

### Аудио, вертикальное видео и preprocessing

На WaveSpeed поле `generate_audio` подтверждено в request schema, причём docs прямо говорят: если `generate_audio=true`, модель генерирует синхронизированный AI audio; если `false`, **сохраняется аудиодорожка исходного видео**. Для вашей задачи «сохранить исходное аудио» safest setting — `generate_audio: false`. **Уверенность: высокая.** citeturn3view0turn4view5

Для вертикального short-form ролика docs подтверждают `aspect_ratio: "9:16"`; если aspect ratio не задать, endpoint пытается адаптироваться к input. Поэтому для уже честного portrait source чаще всего логично либо оставить auto/adaptive, либо явно ставить `9:16`, если вы заранее привели исходник к истинному вертикальному формату. Если в исходнике уже baked-in black bars, safest preprocessing — убрать их до upload, потому что модель воспринимает входное видео как edit-base и с высокой вероятностью сохранит letterbox/pillarbox как часть изображения. Последняя часть — это inference, а не прямая строка docs. **Уверенность: высокая для 9:16; средняя для рекомендации убирать полосы заранее.** citeturn22view4turn3view2turn37view1

Из preprocessing у самого WaveSpeed прямо подтверждены две вещи: лучше заранее **trim**ить клип до релевантного окна и держать его в диапазоне **4–15 секунд**; слишком короткие клипы хуже тем, что будут искусственно паддиться последним кадром до 2 секунд. Практически я бы добавил ещё четыре шага как вероятно полезные: убрать hard cuts внутри куска, выбрать участок с читаемым лицом и руками, убрать чёрные полосы/caption overlays, и по возможности сохранить один стабильный shot без лишних монтажных переходов. Первые две рекомендации согласуются с docs; вторые две — рабочие гипотезы. **Уверенность: высокая для trim/length; средняя для остальных preprocessing-приёмов.** citeturn22view4

### Чем отличаются standard и fast именно для character replacement

На уровне WaveSpeed docs у `standard` и `fast` для Video Edit описан **один и тот же тип задачи**: edit an input video while preserving subject identity, composition and motion. На уровне price/perf `fast` дешевле и документированно быстрее; отдельных endpoint-параметров «character replacement quality mode» для fast vs standard docs не показывают. **Уверенность: высокая.** citeturn22view4turn22view5turn38view0

На практике это переводится так: `fast` — для поиска рабочей формулировки и правильного набора refs; `standard` — для финальных рендеров, когда промпт и input-пакет уже стабилизированы. Эту стратегию дополнительно поддерживает и fal-описание Seedance 2.0, где standard позиционируется как tier для final production renders, а fast — как variant for lower latency/cost. **Уверенность: средняя-высокая.** citeturn14view0turn38view0

## Рекомендуемые production-правила и готовые промпты

### Десять главных практических правил

1. **Используйте Video Edit, а не Image-to-Video или Reference-to-Video, когда motion/camera/environment уже есть в source clip.** Тогда исходное видео остаётся главным носителем движения и композиции. **Уверенность: высокая.** citeturn37view1turn12view1  
2. **Сначала фиксируйте, что меняется, потом — что обязано остаться неизменным.** Это прямо соответствует docs WaveSpeed и официальному prompt guide BytePlus. **Уверенность: высокая.** citeturn22view4turn32search1  
3. **Не полагайтесь на `@Image1`, `[Image1]` или `Image 1` в WaveSpeed Video Edit, пока этого не показывает live schema.** На других поверхностях Seedance такое есть, но на этом endpoint не подтверждено. **Уверенность: высокая.** citeturn30view2turn16view0turn37view6  
4. **Для identity лучше 2–3 сильных, структурированных refs, чем много слабых.** Один фронтальный portrait + один full-body + один secondary angle обычно сильнее случайного набора. **Уверенность: средняя.** citeturn19view0turn20view5  
5. **Держите wording identity-блока неизменным между ранами.** Community reports показывают, что prompt mirroring резко уменьшает drift. **Уверенность: средняя.** citeturn19view0  
6. **Для контактных сцен с мотоциклом/авто/шлемом чаще выгоднее two-pass workflow.** Это не док-факт, а production-эвристика. **Уверенность: средняя.** citeturn20view4turn20view5  
7. **Для сохранения исходного звука ставьте `generate_audio=false`.** Это прямо подтверждено в schema docs. **Уверенность: высокая.** citeturn3view0turn4view5  
8. **Не загружайте в модель клипы с baked-in black bars и бессмысленными переходами; сначала вырежьте чистый shot.** Обрезка до релевантного окна прямо рекомендуется docs. **Уверенность: высокая для trim, средняя для rest-cleaning.** citeturn22view4  
9. **Для A/B используйте fast, для финала — standard.** Иначе вы сожжёте кредиты до стабилизации prompt/input bundle. **Уверенность: средняя-высокая.** citeturn22view4turn22view5turn38view0turn14view0  
10. **Отключайте `enable_web_search` для character replacement.** Для вашей задачи это лишний источник вариативности, а docs и так ставят default `false`. **Уверенность: средняя.** citeturn22view4turn3view2

### Оптимальная модульная структура prompt

Ниже — **безопасная модульная схема для WaveSpeed Video Edit**, без неподтверждённых `@Image1` и без несуществующих negative prompts.

```text
[Edit target]
Replace only the woman in the original video with the woman from the reference images.

[Identity transfer]
Use the reference images only for her face, body proportions, skin tone, hair, and, if specified, her clothing.

[Optional object transfer]
Replace only the [object] with the referenced [object]. Keep its scale, position, orientation, and interaction with the subject consistent with the original video.

[Preserve from source video]
Keep the original body motion, pose, action timing, speed, camera movement, camera angle, framing, composition, background, location, lighting direction, shadows, reflections, motion blur, and all physical interactions unchanged.

[Temporal consistency]
Maintain consistent facial identity, body shape, clothing appearance, and object geometry across the entire clip.

[Contact fidelity]
Keep hand placement, finger contact, leg position, foot placement, and all contact points with the [object] identical to the source video.

[Realism lock]
Preserve the live-action look of the source footage. Do not make the result look newly generated or restaged.
```

Эта схема следует главному принципу docs: **точно назвать edit и точно назвать preservation scope**. **Уверенность: средняя-высокая.** citeturn22view4turn38view1turn32search1

### Короткий production prompt для замены только девушки

```text
Replace only the woman in the original video with the woman from the reference images. Use the reference images only for her face, body proportions, skin tone, hair, and clothing. Keep the original body motion, pose, action timing, speed, camera movement, framing, background, location, lighting, shadows, reflections, motion blur, and all physical interactions unchanged. Preserve the live-action realism of the source footage and maintain strong facial and body consistency across the entire clip.
```

Это максимально близко к documented behavior Video Edit: локальная замена при сохранении motion/composition. **Уверенность: средняя-высокая.** citeturn37view1turn38view1

### Prompt для замены девушки и мотоцикла

```text
Replace only the woman in the original video with the woman from the reference images, and replace only the motorcycle with the referenced motorcycle. Use the woman references only for her face, body proportions, skin tone, hair, and clothing. Use the motorcycle reference only for the motorcycle design, color, shape, and materials. Keep the original body motion, pose, timing, camera movement, framing, background, environment, lighting, shadows, reflections, motion blur, and all interactions unchanged. Keep the rider’s hand placement, finger contact, leg position, seat position, and all contact points with the motorcycle identical to the source video. Preserve live-action realism and maintain strong temporal consistency for both the woman and the motorcycle across the full clip.
```

Для сложного contact-heavy footage этот prompt всё равно стоит считать кандидатом на A/B против two-pass workflow. **Уверенность: средняя.** citeturn20view4turn20view5turn38view1

### Вариант с first-frame reference

Здесь нужна важная оговорка: **true first-frame / start-frame control не подтверждён для WaveSpeed `video-edit` endpoint**. Он подтверждён в других Seedance entry points и у других провайдеров, где есть `image_urls` или explicit first/last frame mode. Поэтому ниже — два варианта.

**Безопасный вариант именно для WaveSpeed Video Edit** — использовать первый референс как «first-frame-like identity anchor», но не утверждать никакой start-frame функции:

```text
Replace only the woman in the original video with the woman from the reference images. Treat the first reference image as the primary identity anchor for her face, skin tone, hair, and body proportions. Use the remaining reference images only to reinforce consistency of her full body and clothing. Keep the original motion, pose, camera movement, framing, environment, lighting, shadows, reflections, motion blur, and all interactions unchanged. Preserve the live-action realism of the source video.
```

**Если вы переходите на provider/endpoint с подтверждённым first-frame mode вне WaveSpeed Video Edit**, тогда first-frame logic уже можно строить через documented `image_urls`/first-frame mechanism; например, PoYo прямо пишет, что `image_urls` — это first/last frame refs и их не надо смешивать с `reference_image_urls`. **Уверенность: высокая в различии режимов; средняя в пользе first-reference-as-anchor на WaveSpeed Video Edit.** citeturn35view0turn35view1turn37view3

### Список вредных или бесполезных формулировок

Ниже — не «запрещённые» слова, а формулировки, которые в вашей задаче чаще вредят, чем помогают:

- `make it cinematic`, `make it more dramatic`, `reimagine the scene`, `restyle the whole video` — расширяют зону rewrite. **Уверенность: средняя.** citeturn37view1turn12view1  
- `improve the video quality`, `enhance details everywhere` — могут подтолкнуть перерисовку фона и лица. **Уверенность: средняя.** citeturn37view1  
- `beautiful`, `stunning`, `perfect`, `ultra detailed` без preservation-блока — слишком общие и не фиксируют локальность edit. **Уверенность: средняя.** citeturn22view4  
- `use @Image1`, `use Image 1`, `replace with [Image1]` на этом endpoint — синтаксис не подтверждён. **Уверенность: высокая.** citeturn16view0turn30view2turn37view6  
- Любые отсылки к `negative prompt`, `seed`, `mask`, `start frame` как к параметрам этого endpoint — не подтверждены публичными docs. **Уверенность: высокая.** citeturn37view0turn37view2turn37view3

## Таблица проблем, причин и исправлений

| Проблема | Вероятная причина | Исправление prompt | Исправление inputs |
|---|---|---|---|
| Лицо drift’ит по кадрам | Слабый identity anchor; слишком вариативные refs; меняется wording между ранами. Community прямо советует один и тот же сильный reference и word-for-word prompt mirroring. citeturn19view0 | Добавить: `Use the reference images only for her face, skin tone, hair, and body proportions. Maintain strong facial identity consistency across the entire clip.` | Использовать 1 frontal portrait + 1 full-body + 1 secondary angle; не менять outfit и фон в refs. citeturn20view5 |
| Меняется фон или освещение | Prompt слишком общий и не фиксирует preservation scope; docs рекомендуют явно назвать что stay unchanged. citeturn22view4turn38view1 | Добавить: `Keep the background, location, lighting direction, shadows, reflections, and composition unchanged.` | Выбрать source без титров, bars и монтажных переходов; обрезать чистый shot. citeturn22view4 |
| Ломаются руки/пальцы на мотоцикле | Слишком сложный one-pass edit; не прописаны contact points; source плохо читаем. citeturn20view4turn20view5 | Добавить: `Keep hand placement, finger contact, and all contact points with the motorcycle identical to the source video.` | Сделать two-pass A/B; выбрать клип, где руки и руль хорошо видны. |
| Одежда плывёт и меняется по клипу | Недостаточно жёсткие clothing refs; модель переинтерпретирует персонажа каждый новый clip/run. citeturn20view4turn19view0 | Добавить: `Use the reference images only for her exact clothing appearance and keep clothing consistent across the full clip.` | Отдельный clothing ref, тот же outfit на всех body refs. |
| Мотоцикл меняет масштаб/геометрию | Одновременно меняются персонаж и объект, нет явной фиксации scale/orientation. | Добавить: `Keep the motorcycle scale, orientation, position, and interaction geometry consistent with the source video.` | Отдельный clean object ref; при необходимости перейти на two-pass workflow. |
| Результат выглядит “заново сгенерированным” | Prompt содержит стилизующие слова или слишком много креативных указаний. | Добавить: `Preserve the live-action realism of the source footage. Do not make the result look newly generated or restaged.` | Убрать лишние style refs; оставить только identity/object refs. |
| Теряется temporal consistency объекта | Объект ref слишком слабый или зашумлённый; object introduced too late in conditioning. | Добавить: `Maintain consistent object geometry, materials, and color across the full clip.` | Чистый object ref на нейтральном фоне; размещать после identity refs, но до второстепенных. |
| Чёрные полосы остаются | Source уже содержит baked-in bars; aspect ratio не приведён заранее. | Указать `9:16` только если target действительно portrait. | Предварительно crop/scale source до истинного 9:16 без bars. Это inference, но практически очень вероятно полезно. citeturn22view4turn3view2 |
| Исчезает исходное аудио | `generate_audio=true` включает новую генерацию звука. Docs прямо пишут, что при `false` сохраняется input audio. citeturn3view0turn4view5 | В prompt ничего не просить про новый звук. | Ставить `generate_audio: false`. |
| Результат слишком дорогой и долгий для итераций | Сразу делается standard/high-res вместо fast. | Prompt не трогать. | Перенести итерации в fast 480p/720p, финал — в standard. citeturn22view4turn22view5turn38view0 |

## Минимальный A/B-план и пример JSON-запроса

### Минимальный A/B-план на 10 генераций

Этот план специально построен так, чтобы отделить **prompt effect** от **input effect** и дать вам production-ответ на два главных вопроса: one-pass vs two-pass и simple refs vs structured refs.

| Генерация | Tier | Что меняется | Цель |
|---|---|---|---|
| A1 | fast | Девушка only, 1 portrait ref | Базовая линия |
| A2 | fast | Девушка only, 2 refs: portrait + full body | Проверить прирост по телу/одежде |
| A3 | fast | Девушка only, 3 refs: portrait + full body + 3/4 | Проверить temporal consistency головы/поворотов |
| A4 | fast | Девушка only, тот же input bundle, но более жёсткий preservation block | Проверить влияние prompt specificity |
| B1 | fast | Девушка + мотоцикл one-pass, 3 girl refs + 1 object ref | Базовая one-pass линия |
| B2 | fast | Девушка + мотоцикл one-pass, тот же bundle + explicit contact-point language | Проверить геометрию контакта |
| C1 | fast | Pass 1: девушка only | Первый шаг two-pass |
| C2 | fast | Pass 2: на результате C1 заменить только мотоцикл | Финальный two-pass вариант |
| D1 | standard | Лучший winner из A-группы | Сравнить face/body fidelity fast vs standard |
| D2 | standard | Лучший winner из B/C-группы | Сравнить one-pass vs two-pass на финальном tier |

Если бюджет разрешает ещё 2 прогона, добавьте:

- **E1**: лучший prompt из A4, но с `9:16` явно заданным.  
- **E2**: лучший prompt из A4, но с auto/adaptive aspect ratio.  

Это быстро покажет, где у вас меньше артефактов по кадрированию на vertical shorts. Основание плана: docs сами разводят fast и standard по цене/скорости, а community указывает на важность structured refs и consistency of wording. **Уверенность: средняя-высокая.** citeturn22view4turn22view5turn38view0turn19view0turn20view5

### Пример JSON-запроса WaveSpeedAI без API-ключа

Ниже — **консервативный пример**, использующий поля, которые наиболее надёжно подтверждены на WaveSpeed surface. Я намеренно **не добавляю `duration` и `reference_audios`** в базовый пример, потому что они есть в prose docs, но отсутствуют в request schema excerpt. Если в live schema вашего аккаунта они видны, можете добавить их отдельно. **Уверенность: высокая в консервативности примера.** citeturn22view4turn3view2

```json
{
  "prompt": "Replace only the woman in the original video with the woman from the reference images. Use the reference images only for her face, body proportions, skin tone, hair, and clothing. Keep the original body motion, pose, action timing, speed, camera movement, framing, background, location, lighting, shadows, reflections, motion blur, and all physical interactions unchanged. Preserve the live-action realism of the source footage and maintain strong facial and body consistency across the entire clip.",
  "video": "https://your-source-video-url.mp4",
  "reference_images": [
    "https://your-reference-portrait.jpg",
    "https://your-reference-fullbody.jpg",
    "https://your-reference-angle.jpg"
  ],
  "aspect_ratio": "9:16",
  "resolution": "720p",
  "enable_web_search": false,
  "generate_audio": false
}
```

Если ваша live schema на WaveSpeed действительно показывает `duration`, тогда безопасный следующий вариант для vertical short-формата будет такой:

```json
{
  "prompt": "Replace only the woman in the original video with the woman from the reference images. Use the reference images only for her face, body proportions, skin tone, hair, and clothing. Keep the original body motion, pose, action timing, speed, camera movement, framing, background, location, lighting, shadows, reflections, motion blur, and all physical interactions unchanged. Preserve the live-action realism of the source footage and maintain strong facial and body consistency across the entire clip.",
  "video": "https://your-source-video-url.mp4",
  "reference_images": [
    "https://your-reference-portrait.jpg",
    "https://your-reference-fullbody.jpg",
    "https://your-reference-angle.jpg"
  ],
  "duration": 8,
  "aspect_ratio": "9:16",
  "resolution": "720p",
  "enable_web_search": false,
  "generate_audio": false
}
```

### Финальный практический вывод

Если свести всё исследование к одному production-решению, то для вашей задачи оптимальный путь сейчас такой: коротко и жёстко формулировать **only replace the woman**, строить `reference_images` как **identity-first bundle**, явно фиксировать **everything to preserve from the source video**, отключать `generate_audio`, начинать с **fast 720p**, а на сложных контактных сценах сразу сравнивать **one-pass vs two-pass**. Самое важное техническое ограничение на текущий момент — не полагаться на неподтверждённые `@Image1`, mask, seed и start-frame функции именно у WaveSpeed Video Edit, даже если они встречаются в других поверхностях Seedance. **Уверенность: высокая.** citeturn37view1turn22view4turn22view5turn30view2turn16view0turn37view0turn37view3turn37view6