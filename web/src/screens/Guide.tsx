import ReferenceExamples from '../ReferenceExamples';
import { Button, Card, SectionTitle } from '../ui';

const steps = [
  ['1', 'Видео', 'Загрузи исходник с одним главным героем.'],
  ['2', 'Пресет', 'Выбери нужную внешность, одежду и объект.'],
  ['3', 'Результат', 'Проверь цену в долларах и запусти генерацию.'],
];

export default function Guide({
  onDone,
  onOpenModels,
  onOpenSwap,
}: {
  onDone?: () => void;
  onOpenModels?: () => void;
  onOpenSwap?: () => void;
}) {
  return (
    <div className="max-w-4xl mx-auto space-y-4 sf-in">
      <Card glow>
        <SectionTitle title="Как получить хороший ролик" hint="три простых шага" />
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

      <Card>
        <SectionTitle title="Как должны выглядеть референсы" hint="нажимай 1 → 2 → 3" />
        <div className="p-4 sm:p-5">
          <ReferenceExamples />
        </div>
      </Card>

      <Card>
        <SectionTitle title="Какое видео загружать" />
        <div className="p-4 sm:p-5 space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-ok/25 bg-ok/5 p-3">
              <div className="text-sm font-semibold text-ok">✓ Подходит</div>
              <p className="mt-1 text-xs text-mut">4–15 секунд, вертикально 9:16, один герой, хороший свет и плавное движение.</p>
            </div>
            <div className="rounded-xl border border-warn/25 bg-warn/5 p-3">
              <div className="text-sm font-semibold text-warn">× Лучше не брать</div>
              <p className="mt-1 text-xs text-mut">Темнота, частые склейки, закрытое лицо и несколько главных героев.</p>
            </div>
          </div>
          <p className="text-xs text-dim">Видео длиннее 15 секунд сервис сам разделит на части и бесшовно соберёт обратно.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {onDone ? (
              <Button kind="primary" className="w-full sm:w-auto" onClick={onDone}>
                Сделать первый ролик
              </Button>
            ) : (
              onOpenModels && (
                <Button kind="primary" className="w-full sm:w-auto" onClick={onOpenModels}>
                  Создать модель и пресет
                </Button>
              )
            )}
            {onOpenSwap && !onDone && (
              <Button className="w-full sm:w-auto" onClick={onOpenSwap}>
                Загрузить видео
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
