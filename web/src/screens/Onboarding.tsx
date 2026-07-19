import { Button, Card, Tag } from '../ui';

export type JourneyStep = 'balance' | 'guide' | 'video' | 'model' | 'result' | 'done';
export type JourneyTarget = 'billing' | 'guide' | 'swap' | 'models';

export interface JourneyStatus {
  hasBalance: boolean;
  balanceDeferred: boolean;
  guideSeen: boolean;
  hasProject: boolean;
  hasReadyModel: boolean;
  hasResult: boolean;
  current: JourneyStep;
}

const TITLES: Record<JourneyStep, string> = {
  balance: 'Пополнить баланс',
  guide: 'Понять, что загружать',
  video: 'Загрузить исходное видео',
  model: 'Подготовить модель и пресеты',
  result: 'Запустить первый ролик',
  done: 'Первый ролик готов',
};

const TARGETS: Record<Exclude<JourneyStep, 'done'>, JourneyTarget> = {
  balance: 'billing',
  guide: 'guide',
  video: 'swap',
  model: 'models',
  result: 'swap',
};

const STEPS = [
  { key: 'account', title: 'Регистрация' },
  { key: 'balance', title: 'Баланс' },
  { key: 'guide', title: 'Инструкция' },
  { key: 'video', title: 'Видео' },
  { key: 'model', title: 'Модель' },
  { key: 'result', title: 'Результат' },
] as const;

function isDone(key: (typeof STEPS)[number]['key'], status: JourneyStatus): boolean {
  if (key === 'account') return true;
  if (key === 'balance') return status.hasBalance || status.balanceDeferred;
  if (key === 'guide') return status.guideSeen;
  if (key === 'video') return status.hasProject;
  if (key === 'model') return status.hasReadyModel;
  return status.hasResult;
}

export function JourneyHome({
  status,
  onGo,
  onNewVideo,
  onBalanceLater,
  onSkip,
}: {
  status: JourneyStatus;
  onGo: (target: JourneyTarget) => void;
  onNewVideo: () => void;
  onBalanceLater: () => void;
  onSkip: () => void;
}) {
  const doneCount = STEPS.filter((step) => isDone(step.key, status)).length;
  const continueJourney = () => {
    if (status.current === 'done') return onGo('swap');
    if (status.current === 'video') return onNewVideo();
    onGo(TARGETS[status.current]);
  };

  return (
    <Card glow className="max-w-2xl mx-auto sf-in">
      <div className="p-5 sm:p-7 space-y-5">
        <div>
          <Tag tone="lime">первый запуск · {doneCount}/6</Tag>
          <h1 className="text-2xl font-extrabold mt-3">Сделаем первый ролик</h1>
          <p className="text-sm text-mut mt-1">Идём по одному шагу. Пройденное запоминается.</p>
        </div>

        <ol className="space-y-2">
          {STEPS.map((step, index) => {
            const done = isDone(step.key, status);
            const active = step.key === status.current;
            return (
              <li
                key={step.key}
                className={`rounded-xl border px-3 py-2.5 flex items-center gap-3 ${
                  active ? 'border-lime/50 bg-lime/5' : 'border-line bg-panel2'
                }`}
              >
                <span className={`w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-xs font-bold ${done ? 'bg-lime text-black' : 'border border-line2 text-mut'}`}>
                  {done ? '✓' : index + 1}
                </span>
                <span className={`text-sm flex-1 ${active ? 'font-semibold' : done ? 'text-mut' : ''}`}>{step.title}</span>
                {step.key === 'balance' && status.balanceDeferred && !status.hasBalance && <span className="text-[11px] text-dim">позже</span>}
              </li>
            );
          })}
        </ol>

        <div className="rounded-xl border border-line bg-panel2 p-4">
          <div className="text-xs text-lime mb-1">Следующий шаг</div>
          <div className="font-semibold">{TITLES[status.current]}</div>
          {status.current === 'balance' && <p className="text-xs text-mut mt-1">Минимум $5. Можно продолжить без оплаты и вернуться перед запуском.</p>}
          {status.current === 'guide' && <p className="text-xs text-mut mt-1">За минуту разберём видео, модель и дополнительные объекты.</p>}
          {status.current === 'video' && <p className="text-xs text-mut mt-1">Лучше один герой, хороший свет и минимум монтажных склеек.</p>}
          {status.current === 'model' && <p className="text-xs text-mut mt-1">Добавь лицо, полный рост и отдельные пресеты под образы или задачи.</p>}
          {status.current === 'result' && <p className="text-xs text-mut mt-1">Вернись к ролику, выбери модель и нажми кнопку запуска.</p>}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <Button kind="primary" className="w-full sm:w-auto" onClick={continueJourney}>
            {status.current === 'done' ? 'В кабинет' : 'Продолжить'}
          </Button>
          {status.current === 'balance' && (
            <Button kind="ghost" className="w-full sm:w-auto" onClick={onBalanceLater}>Сделаю позже</Button>
          )}
          {!status.hasResult && (
            <button type="button" onClick={onSkip} className="min-h-11 px-3 text-xs text-dim hover:text-ink sm:ml-auto">
              Пропустить обучение
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function JourneyBar({
  status,
  onOpenPlan,
  onContinue,
  showContinue = true,
}: {
  status: JourneyStatus;
  onOpenPlan: () => void;
  onContinue: () => void;
  showContinue?: boolean;
}) {
  const index = Math.max(2, STEPS.findIndex((step) => step.key === status.current) + 1);
  return (
    <div className="mb-4 rounded-xl border border-lime/35 bg-lime/5 px-3 py-2.5 flex items-center gap-3 sf-in">
      <span className="w-7 h-7 shrink-0 rounded-full bg-lime text-black flex items-center justify-center text-xs font-bold">{index}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-lime">Первый запуск</div>
        <div className="text-sm font-semibold truncate">{TITLES[status.current]}</div>
      </div>
      {showContinue && <Button kind="primary" className="!px-3 text-xs" onClick={onContinue}>Дальше</Button>}
      <button type="button" onClick={onOpenPlan} className="min-h-11 px-1 text-xs text-dim hover:text-ink">Шаги</button>
    </div>
  );
}
