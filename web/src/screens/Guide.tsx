import { Button, Card, SectionTitle, Tag } from '../ui';

const steps = [
  ['1', 'Видео', 'Загрузи исходник. Один главный герой, хороший свет и меньше склеек дают лучший результат.'],
  ['2', 'Модель', 'Выбери готовый пресет с нужной внешностью, одеждой и задачей.'],
  ['3', 'Результат', 'Проверь цену в долларах и запусти. Длинное видео сервис разделит и бесшовно соберёт сам.'],
];

const referenceTips = [
  {
    title: 'Лицо и фигура',
    good: '4–6 чётких фото: лицо, полный рост, ¾ и профиль. Один человек, ровный свет, одинаковая внешность.',
    bad: 'Без фильтров, очков, коллажей, толпы и закрытого лица.',
  },
  {
    title: 'Исходное видео',
    good: 'Лучше 4–15 секунд, вертикально 9:16, плавное движение и один непрерывный дубль.',
    bad: 'Избегай частых склеек, темноты, перекрытого лица и нескольких главных героев.',
  },
  {
    title: 'Предмет или техника',
    good: 'Добавь отдельные фото ¾, сбоку и важных деталей. Они применятся, если предмет есть в исходном видео.',
    bad: 'Не смешивай разные предметы и людей на одном референсе.',
  },
];

export default function Guide({ onDone }: { onDone?: () => void }) {
  return (
    <div className="max-w-2xl mx-auto space-y-4 sf-in">
      <Card glow>
        <SectionTitle title="Как получить хороший ролик" />
        <ol className="p-4 sm:p-6 space-y-3">
          {steps.map(([n, title, text]) => (
            <li key={n} className="rounded-xl border border-line bg-panel2 p-4 flex gap-3">
              <span className="w-7 h-7 shrink-0 rounded-full bg-lime text-black flex items-center justify-center text-sm font-bold">
                {n}
              </span>
              <div>
                <div className="font-semibold">{title}</div>
                <p className="text-sm text-mut mt-1">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <SectionTitle title="Какие референсы приложить" />
        <div className="p-4 sm:p-6 pt-2 sm:pt-2 space-y-4">
          {referenceTips.map((tip) => (
            <section key={tip.title} className="border-b border-line last:border-0 pb-4 last:pb-0">
              <h2 className="font-semibold">{tip.title}</h2>
              <p className="text-sm text-mut mt-1"><span className="text-ok">✓</span> {tip.good}</p>
              <p className="text-sm text-dim mt-1"><span className="text-warn">×</span> {tip.bad}</p>
            </section>
          ))}
        </div>
      </Card>

      <Card>
        <div className="p-4 sm:p-6 space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Пресеты модели</h2>
            <Tag tone="lime">один клик</Tag>
          </div>
          <p className="text-sm text-mut">
            Сохрани отдельный пресет под каждую задачу: «Реклама», «Обзор», «Lifestyle». В каждый добавь нужную одежду и ракурсы — потом достаточно выбрать пресет и видео.
          </p>
          {onDone && (
            <Button className="w-full sm:w-auto" onClick={onDone}>
              Понятно, продолжить
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}
