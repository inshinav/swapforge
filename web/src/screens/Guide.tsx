// «Как это работает» — отдельная страница-гайд по сервису. Доступна и БЕЗ входа
// (прямая ссылка #guide с экрана входа): человек знакомится с сервисом, ценами и
// правилами до регистрации. Внутри кабинета открывается из меню профиля.
import ReferenceExamples from '../ReferenceExamples';
import { Button, Card, SectionTitle } from '../ui';

const steps = [
  ['1', 'Видео', 'Загрузи исходник с одним главным героем.'],
  ['2', 'Пресет', 'Выбери нужную внешность, одежду и объект.'],
  ['3', 'Результат', 'Проверь цену в долларах и запусти генерацию.'],
];

const pipeline = [
  ['Проверка сцен', 'Разбираем ролик по кадрам и сверяем твои фото с каждой сценой. Если фото не хватает — скажем заранее, до списания за генерацию.'],
  ['Новый образ', 'Собираем первый кадр с твоей моделью: лицо, одежда и объекты из пресета встают в исходную сцену.'],
  ['Генерация', 'Нейросеть пересобирает всё видео: движение, свет и камера остаются из исходника, персонаж — твой. Обычно 2–10 минут.'],
  ['Reality Finish', 'По желанию — финальная обработка «под живую съёмку»: телефонный или камерный вид, зерно, естественный цвет. Бесплатно.'],
];

const faq: Array<[string, string]> = [
  [
    'Сколько это стоит и когда списываются деньги?',
    'Цена видна до запуска — она зависит от длительности ролика. На время работы сумма резервируется, а списывается по факту после готового результата. Если генерация не удалась — резерв возвращается (остаётся только стоимость уже выполненной проверки сцен).',
  ],
  [
    'Как пополнить баланс?',
    'На вкладке «Баланс»: криптой (USDT и другие) или картой / СБП в рублях по фиксированному курсу. Для оплаты картой нужен настоящий email — на него придёт чек.',
  ],
  [
    'Сколько ждать результат?',
    'Обычно 2–10 минут. Страницу можно закрывать — работа продолжится, готовый ролик появится в «Работах».',
  ],
  [
    'Какое видео подходит лучше всего?',
    'Вертикальное 9:16 до 60 секунд (лучше до 15), один главный герой, хороший свет, без частых склеек. Длинные ролики сервис сам делит на части и бесшовно склеивает.',
  ],
  [
    'Что если результат не понравился?',
    'Оцени ролик 👎 и отметь, что именно не так — сервис перегенерирует с точечными исправлениями (это обычный платный запуск). Кнопка «Проверить ещё раз» после сбоя — бесплатная.',
  ],
  [
    'Кто видит мои видео и фото?',
    'Только ты. Проекты, модели и результаты живут в твоём аккаунте; в общий доступ ничего не публикуется. Хранятся последние 20 работ.',
  ],
];

const toc = [
  ['what', 'Что это'],
  ['steps', 'Три шага'],
  ['pipeline', 'Как устроено'],
  ['refs', 'Референсы'],
  ['video', 'Какое видео'],
  ['pricing', 'Цены и оплата'],
  ['faq', 'Вопросы'],
];

export default function Guide({
  onDone,
  onOpenModels,
  onOpenSwap,
  onLoginCta,
}: {
  onDone?: () => void;
  onOpenModels?: () => void;
  onOpenSwap?: () => void;
  /** Анонимный просмотр до входа: вместо действий кабинета — призыв войти. */
  onLoginCta?: () => void;
}) {
  const anonymous = !!onLoginCta;
  return (
    <div className="max-w-4xl mx-auto space-y-4 sf-in">
      <Card glow>
        <div className="p-5 sm:p-6 space-y-3" id="what">
          <h1 className="text-2xl font-extrabold tracking-tight">
            Как работает Swap<span className="text-lime">Forge</span>
          </h1>
          <p className="text-sm text-mut max-w-2xl">
            Загружаешь чужой или свой ролик — получаешь тот же ролик, но с твоим персонажем:
            лицо, образ и даже мотоцикл или другой объект заменяются на твои по фото.
            Движение, сцена и камера остаются как в оригинале. Один клик, цена известна заранее.
          </p>
          {/* Кнопки, не <a href="#...">: хэш занят роутингом приложения (#guide/#swap) */}
          <nav aria-label="Разделы гайда" className="flex flex-wrap gap-1.5 pt-1">
            {toc.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => document.getElementById(`guide-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                className="min-h-9 rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-xs font-semibold text-mut hover:border-lime/50 hover:text-lime"
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </Card>

      <div id="guide-steps" className="scroll-mt-20">
        <Card>
          <SectionTitle title="Три простых шага" hint="весь путь до готового ролика" />
          <ol className="grid gap-2 p-4 sm:grid-cols-3 sm:p-5">
            {steps.map(([n, title, text]) => (
              <li key={n} className="rounded-xl border border-line bg-panel2 p-3 flex gap-3">
                <span className="w-7 h-7 shrink-0 rounded-full bg-lime text-black flex items-center justify-center text-sm font-bold">
                  {n}
                </span>
                <div>
                  <div className="font-semibold">{title}</div>
                  <p className="text-xs text-mut mt-1">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div id="guide-pipeline" className="scroll-mt-20">
        <Card>
          <SectionTitle title="Что происходит под капотом" hint="после нажатия одной кнопки" />
          <ol className="p-4 sm:p-5 space-y-2">
            {pipeline.map(([title, text], index) => (
              <li key={title} className="flex gap-3 rounded-xl border border-line bg-panel2 p-3">
                <span className="w-7 h-7 shrink-0 rounded-full border border-lime/40 text-lime flex items-center justify-center text-sm font-bold">
                  {index + 1}
                </span>
                <div>
                  <div className="font-semibold text-sm">{title}</div>
                  <p className="text-xs text-mut mt-1">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <div id="guide-refs" className="scroll-mt-20">
        <Card>
          <SectionTitle title="Как должны выглядеть референсы" hint="нажимай 1 → 2 → 3" />
          <div className="p-4 sm:p-5">
            <ReferenceExamples />
          </div>
        </Card>
      </div>

      <div id="guide-video" className="scroll-mt-20">
        <Card>
          <SectionTitle title="Какое видео загружать" />
          <div className="p-4 sm:p-5 space-y-4">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-ok/25 bg-ok/5 p-3">
                <div className="text-sm font-semibold text-ok">✓ Подходит</div>
                <p className="mt-1 text-xs text-mut">Максимум 60 секунд, рекомендуем до 15. Вертикально 9:16, один герой и хороший свет.</p>
              </div>
              <div className="rounded-xl border border-warn/25 bg-warn/5 p-3">
                <div className="text-sm font-semibold text-warn">× Лучше не брать</div>
                <p className="mt-1 text-xs text-mut">Темнота, частые склейки, закрытое лицо и несколько главных героев.</p>
              </div>
            </div>
            <p className="text-xs text-dim">Видео длиннее 15 секунд сервис сам разделит на части и бесшовно соберёт обратно.</p>
          </div>
        </Card>
      </div>

      <div id="guide-pricing" className="scroll-mt-20">
        <Card>
          <SectionTitle title="Цены и оплата" hint="никаких подписок — платишь за запуск" />
          <div className="p-4 sm:p-5 space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-line bg-panel2 p-3">
                <div className="text-sm font-semibold">Цена до запуска</div>
                <p className="text-xs text-mut mt-1">Смета в долларах видна заранее и зависит от длительности ролика. Запуска без твоего подтверждения не будет.</p>
              </div>
              <div className="rounded-xl border border-line bg-panel2 p-3">
                <div className="text-sm font-semibold">Резерв → факт</div>
                <p className="text-xs text-mut mt-1">На время генерации сумма резервируется, списывается по факту готового ролика. Сбой = возврат резерва.</p>
              </div>
              <div className="rounded-xl border border-line bg-panel2 p-3">
                <div className="text-sm font-semibold">Пополнение</div>
                <p className="text-xs text-mut mt-1">Криптой (USDT и др.) или картой / СБП в рублях по фиксированному курсу. От $5.</p>
              </div>
            </div>
            <p className="text-xs text-dim">
              Бесплатно: проверка совместимости фото со сценами до запуска, повторная проверка после сбоя,
              превью и обработка Reality Finish готового ролика.
            </p>
          </div>
        </Card>
      </div>

      <div id="guide-faq" className="scroll-mt-20">
        <Card>
          <SectionTitle title="Частые вопросы" />
          <div className="p-4 sm:p-5 space-y-2">
            {faq.map(([q, a]) => (
              <details key={q} open className="rounded-xl border border-line bg-panel2">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold">{q}</summary>
                <p className="border-t border-line px-4 py-3 text-xs text-mut leading-relaxed">{a}</p>
              </details>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <div className="p-4 sm:p-5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="text-sm font-semibold flex-1">Готов попробовать?</div>
          {anonymous ? (
            <Button kind="primary" className="w-full sm:w-auto" onClick={onLoginCta}>
              Войти через Telegram и начать
            </Button>
          ) : onDone ? (
            <Button kind="primary" className="w-full sm:w-auto" onClick={onDone}>
              Сделать первый ролик
            </Button>
          ) : (
            <>
              {onOpenModels && (
                <Button kind="primary" className="w-full sm:w-auto" onClick={onOpenModels}>
                  Создать модель и пресет
                </Button>
              )}
              {onOpenSwap && (
                <Button className="w-full sm:w-auto" onClick={onOpenSwap}>
                  Загрузить видео
                </Button>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
