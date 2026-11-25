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
 * The coding model and thinking level beside send. `null` keeps the coding default. `extra` adds per-session settings
 * under the choice (context usage, Pi settings) for an existing session.
 */
export function CodingModelChip({ value, onChange, disabled = false, allowDefault = true, extra }: {
  value: ModelChoice; onChange(next: ModelChoice): void; disabled?: boolean;
  /** A new agent may keep the coding default; a running session always names its model. */
  allowDefault?: boolean; extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { models, error, reload } = useEmbeddedModels(true);
  const current = value.model ? models?.find(model => modelKey(model) === modelKey(value.model!)) : undefined;
  const levels = codingThinkingOptions(current);
  const name = value.model ? current?.name ?? value.model.model : '기본 모델';
  const thinking = value.thinking && levels.includes(value.thinking) ? value.thinking : null;
  const providers = groupByProvider(models ?? []);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <button type="button" className="composer-chip coding-model-chip" disabled={disabled} aria-label={`모델 ${name}${thinking ? `, 생각 ${codingThinkingLabels[thinking]}` : ''}`}
        title={value.model ? `${name} · ${value.model.provider}` : '코딩 기본 모델'}>
        <span className="truncate">{name}</span>{thinking && <span className="coding-model-chip__level">{codingThinkingLabels[thinking]}</span>}
        <ChevronDown size={13} aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="coding-model-menu" aria-label="모델 선택">
      <div className="coding-model-menu__list">
        {allowDefault && <button type="button" aria-pressed={!value.model} onClick={() => { onChange({ model: null, thinking: null }); setOpen(false); }}>
          <span>기본 모델</span>{!value.model && <Check size={14} aria-hidden="true"/>}
        </button>}
        {providers.map(([provider, items]) => <section key={provider} aria-label={provider}>
          <p>{provider}</p>
          {items.map(model => {
            const selected = current !== undefined && modelKey(model) === modelKey(current);
            return <button key={modelKey(model)} type="button" aria-pressed={selected} onClick={() => {
              const supported = codingThinkingOptions(model);
              onChange({ model: { provider: model.provider, model: model.model }, thinking: value.thinking && supported.includes(value.thinking) ? value.thinking : allowDefault ? null : supported[0] ?? null });
            }}><span>{model.name}</span>{selected && <Check size={14} aria-hidden="true"/>}</button>;
          })}
        </section>)}
        {!models && !error && <p role="status">모델을 불러오는 중…</p>}
      </div>
      {levels.length > 0 && <div className="coding-model-menu__thinking">
        <span aria-hidden="true">생각</span>
        <SegmentedControl aria-label="생각 수준" value={thinking ?? ''} onValueChange={next => {
          const level = levels.find(candidate => candidate === next);
          if (level) onChange({ model: value.model, thinking: level });
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
