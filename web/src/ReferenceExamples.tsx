import { useState } from 'react';
import modelBase from './assets/guide/model-base.webp';
import modelLook from './assets/guide/model-look.webp';
import motorcycle from './assets/guide/motorcycle.webp';
import { Tag } from './ui';

type ExampleId = 'base' | 'look' | 'object';

const examples: Array<{
  id: ExampleId;
  tab: string;
  step: string;
  title: string;
  role: string;
  image: string;
  width: number;
  height: number;
  alt: string;
  why: string;
  points: string[];
  saveAs: string;
  rule: string;
}> = [
  {
    id: 'base',
    tab: '1 · База',
    step: 'Сначала внешность',
    title: 'Базовая модель',
    role: 'Модель',
    image: modelBase,
    width: 1055,
    height: 1492,
    alt: 'Пример референс-листа модели: лицо, полный рост, профиль, вид сзади и ракурсы три четверти',
    why: 'Чтобы сервис запомнил лицо, волосы, фигуру и пропорции.',
    points: [
      'Крупное лицо — черты и цвет глаз',
      'Полный рост спереди — фигура и пропорции',
      'Профиль, ¾ и вид сзади — стабильность в движении',
    ],
    saveAs: 'Пресет «Повседневный»',
    rule: 'Один такой лист уже достаточен. Без листа загрузи 3–5 отдельных фото в одном образе.',
  },
  {
    id: 'look',
    tab: '2 · Образ',
    step: 'Потом отдельный лук',
    title: 'Красный мотолук',
    role: 'Модель',
    image: modelLook,
    width: 1200,
    height: 900,
    alt: 'Пример референс-листа модели в красном мотокостюме и шлеме со всех ракурсов',
    why: 'Чтобы одежда, защита и шлем не менялись между кадрами.',
    points: [
      'То же лицо и те же волосы',
      'Костюм полностью: спереди, сбоку и сзади',
      'Шлем крупно: открытый, закрытый и вид сзади',
    ],
    saveAs: 'Отдельный пресет «Красный мотолук»',
    rule: 'Другой лук — другой пресет. Не смешивай повседневную одежду и мотокостюм в одном пресете.',
  },
  {
    id: 'object',
    tab: '3 · Мотоцикл',
    step: 'Объект загружается отдельно',
    title: 'Красный мотоцикл',
    role: 'Транспорт',
    image: motorcycle,
    width: 1200,
    height: 900,
    alt: 'Пример референс-листа красного мотоцикла: вид сбоку, спереди, сзади, сверху и детали кокпита',
    why: 'Чтобы форма, цвет и важные детали мотоцикла оставались одинаковыми.',
    points: [
      'Полный вид сбоку — форма и пропорции',
      'Спереди, сзади и ¾ — устойчивый объём',
      'Кокпит и вид сверху — важные детали',
    ],
    saveAs: 'Тот же пресет «Красный мотолук» · роль «Транспорт»',
    rule: 'Если байк нужен только с этим образом — добавь его в тот же пресет. В «Общее» добавляй только объект для всех образов.',
  },
];

export default function ReferenceExamples({
  initial = 'base',
  compact = false,
}: {
  initial?: ExampleId;
  compact?: boolean;
}) {
  const [activeId, setActiveId] = useState<ExampleId>(initial);
  const active = examples.find((example) => example.id === activeId) ?? examples[0]!;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1.5" role="tablist" aria-label="Примеры референсов">
        {examples.map((example) => (
          <button
            key={example.id}
            type="button"
            role="tab"
            aria-selected={active.id === example.id}
            onClick={() => setActiveId(example.id)}
            className={`min-h-11 rounded-lg border px-2 py-2 text-xs font-semibold transition-colors ${
              active.id === example.id
                ? 'border-lime/60 bg-lime/10 text-ink'
                : 'border-line bg-panel2 text-mut hover:text-ink'
            }`}
          >
            {example.tab}
          </button>
        ))}
      </div>

      <article className={`grid gap-4 ${compact ? 'lg:grid-cols-[minmax(0,1.15fr)_minmax(240px,0.85fr)]' : 'md:grid-cols-[minmax(0,1.2fr)_minmax(250px,0.8fr)]'}`}>
        <figure className="min-w-0">
          <div className="relative overflow-hidden rounded-xl border border-line bg-black/20">
            <img
              src={active.image}
              alt={active.alt}
              width={active.width}
              height={active.height}
              loading="lazy"
              className={`block w-full object-contain ${compact ? 'max-h-[520px]' : 'max-h-[620px]'}`}
            />
            <div className="absolute left-2 top-2">
              <Tag tone="lime">роль: {active.role}</Tag>
            </div>
          </div>
          <figcaption className="mt-2 text-xs text-dim">Пример готового референс-листа: все нужные ракурсы собраны в одном файле.</figcaption>
        </figure>

        <div className="min-w-0 space-y-3">
          <div>
            <div className="text-xs font-semibold text-lime">{active.step}</div>
            <h3 className="mt-1 text-lg font-bold">{active.title}</h3>
            <p className="mt-1 text-sm text-mut">{active.why}</p>
          </div>

          <ol className="space-y-2">
            {active.points.map((point, index) => (
              <li key={point} className="flex gap-2 text-sm">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-lime/15 text-[11px] font-bold text-lime">
                  {index + 1}
                </span>
                <span>{point}</span>
              </li>
            ))}
          </ol>

          <div className="rounded-lg border border-line bg-panel2 px-3 py-2.5">
            <div className="text-[11px] text-dim">Куда положить</div>
            <div className="mt-0.5 text-sm font-semibold">{active.saveAs}</div>
          </div>
          <p className="text-xs text-mut">{active.rule}</p>
        </div>
      </article>

      <div className="rounded-xl border border-lime/25 bg-lime/5 p-3">
        <div className="text-xs font-semibold text-lime">Один пресет может содержать несколько фото</div>
        <p className="mt-1 text-xs text-mut">Каждая новая загрузка дополняет выбранный пресет — старые фотографии не заменяются.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <ExampleSlot n="1" title="Повседневный" sub="пресет №1 · фото модели" />
          <ExampleSlot n="2" title="Красный мотолук" sub="пресет №2 · фото модели" />
          <ExampleSlot n="+" title="Красный мотоцикл" sub="тот же пресет №2 · Транспорт" />
        </div>
      </div>
    </div>
  );
}

function ExampleSlot({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="flex min-w-0 gap-2 rounded-lg border border-line bg-panel px-2.5 py-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-lime text-[11px] font-bold text-black">{n}</span>
      <div className="min-w-0">
        <div className="text-xs font-semibold">{title}</div>
        <div className="mt-0.5 text-[10px] text-dim">{sub}</div>
      </div>
    </div>
  );
}
