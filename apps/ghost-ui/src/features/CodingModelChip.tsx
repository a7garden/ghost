import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CodingSession, CodingThinking } from '@ghost/contract';
import type { CodingSessionModel } from '../host/client';
import { InlineError, Popover, PopoverContent, PopoverTrigger, SegmentedControl } from '../ui';
import { useEmbeddedModels } from './CodingSessionLive';
import { codingThinkingLabels, codingThinkingOptions, modelKey } from './CodingSessionModel';

export type ModelChoice = { model: CodingSession['model'] | null; thinking: CodingThinking | null };

/**
 * The coding model and thinking level beside send. A new agent shows the model the owner used last (`model: null`
 * until they pick one); an existing session always names its own. `extra` adds per-session settings under the choice
 * (context usage, Pi settings) for an existing session.
 */
export function CodingModelChip({ value, onChange, disabled = false, extra }: {
  value: ModelChoice; onChange(next: ModelChoice): void; disabled?: boolean; extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { models, last, error, reload } = useEmbeddedModels(true);
  const model = value.model ?? (last && { provider: last.provider, model: last.model });
  const current = model ? models?.find(item => modelKey(item) === modelKey(model)) : undefined;
  const levels = codingThinkingOptions(current);
  const shown = value.model ? value.thinking : value.thinking ?? last?.thinking ?? null;
  const thinking = shown && levels.includes(shown) ? shown : null;
  const name = model ? current?.name ?? model.model : '모델 선택';
  const providers = groupByProvider(models ?? []);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="composer-chip coding-model-chip" disabled={disabled} aria-label={`모델 ${name}${thinking ? `, 생각 ${codingThinkingLabels[thinking]}` : ''}`}
        title={model ? `${name} · ${model.provider}` : '모델 선택'}>
        <span className="truncate">{name}</span>{thinking && <span className="coding-model-chip__level">{codingThinkingLabels[thinking]}</span>}
        <ChevronDown size={13} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="coding-model-menu" aria-label="모델 선택">
      <div className="coding-model-menu__list">
        {providers.map(([provider, items]) => <section key={provider} aria-label={provider}>
          <p>{provider}</p>
          {items.map(item => {
            const selected = current !== undefined && modelKey(item) === modelKey(current);
            return <button key={modelKey(item)} type="button" aria-pressed={selected} onClick={() => {
              const supported = codingThinkingOptions(item);
              onChange({ model: { provider: item.provider, model: item.model },
                thinking: thinking && supported.includes(thinking) ? thinking : supported.includes('medium') ? 'medium' : supported[0] ?? null });
            }}><span>{item.name}</span>{selected && <Check size={14} aria-hidden="true"/>}</button>;
          })}
        </section>)}
        {!models && !error && <p role="status">모델을 불러오는 중…</p>}
      </div>
      {levels.length > 0 && <div className="coding-model-menu__thinking">
        <span aria-hidden="true">생각</span>
        <SegmentedControl aria-label="생각 수준" value={thinking ?? ''} onValueChange={next => {
          const level = levels.find(candidate => candidate === next);
          if (level) onChange({ model: model ? { provider: model.provider, model: model.model } : null, thinking: level });
        }} options={levels.map(level => ({ value: level, label: codingThinkingLabels[level] }))}/>
      </div>}
      {error && <InlineError onRetry={reload} retryLabel="다시 불러오기">{error}</InlineError>}
      {extra}
    </PopoverContent>
  </Popover>;
}

function groupByProvider(models: readonly CodingSessionModel[]): [string, CodingSessionModel[]][] {
  const groups = new Map<string, CodingSessionModel[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups];
}
