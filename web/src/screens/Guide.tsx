import { Card, SectionTitle } from '../ui';

const steps = [
  {
    n: '1',
    title: 'Создай модель',
    text: 'Добавь чёткое лицо и фигуру в полный рост. Лучше — один реф-лист со всех ракурсов.',
  },
  {
    n: '2',
    title: 'Загрузи видео',
    text: 'Лучше один герой, хороший свет и непрерывный дубль. Длинные ролики сервис разделит и соберёт сам.',
  },
  {
    n: '3',
    title: 'Проверь цену и запусти',
    text: 'Цена видна в долларах заранее. Можно запускать несколько роликов одновременно.',
  },
];

export default function Guide() {
  return (
    <Card glow className="max-w-2xl mx-auto sf-in">
      <SectionTitle title="Как это работает" />
      <ol className="p-4 sm:p-6 space-y-3">
        {steps.map((step) => (
          <li key={step.n} className="rounded-xl border border-line bg-panel2 p-4 flex gap-3">
            <span className="w-7 h-7 shrink-0 rounded-full bg-lime text-black flex items-center justify-center text-sm font-bold">
              {step.n}
            </span>
            <div>
              <div className="font-semibold">{step.title}</div>
              <p className="text-sm text-mut mt-1">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
