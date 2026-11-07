import { useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { InlineError, Popover, PopoverContent, PopoverTrigger } from '../ui'
import type { Settings } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';

/** A model the UI offers: a provider id plus one of its model ids. */
export type ModelChoice = { provider: string; model: string };
// Radix Select는 빈 값을 항목으로 가질 수 없으므로 '기본 모델 따름' 선택값을 치환한다.
export const NO_MODEL = '__none__';

/** Providers the pickers can offer; a provider without models cannot run anything. */
export function usableProviders(settings: Settings | null | undefined): Settings['providers'] {
  return settings?.providers.filter(provider => provider.models.length > 0) ?? [];
}

export function modelDisplayName(settings: Settings | null | undefined, choice: ModelChoice | null | undefined): string {
  if (!choice) return '기본 모델';
  const provider = settings?.providers.find(item => item.id === choice.provider);
  const model = provider?.models.find(item => item.id === choice.model);
  const name = model && (model.name || model.id);
  return provider ? `${provider.name} / ${name ?? choice.model}` : choice.model;
}

/** `<providerId>/<modelId>` values for Select fields, labelled with the stored names. */
export function modelSelectOptions(settings: Settings | null | undefined): { value: string; label: string }[] {
  return usableProviders(settings).flatMap(provider => provider.models.map(model => ({
    value: `${provider.id}/${model.id}`,
    label: `${provider.name} / ${model.name || model.id}`,
  })));
}

/** Parses a select value back to a choice, rejecting keys the current settings no longer offer. */
export function modelFromKey(settings: Settings | null | undefined, key: string | null | undefined): ModelChoice | null | undefined {
  if (key === null) return null;
  if (!key || key === NO_MODEL) return undefined;
  const separator = key.indexOf('/');
  if (separator < 1) return undefined;
  const provider = key.slice(0, separator), model = key.slice(separator + 1);
  const valid = settings?.providers.some(item => item.id === provider && item.models.some(entry => entry.id === model));
  return valid ? { provider, model } : undefined;
}

const keyOf = (choice: ModelChoice) => `${choice.provider}/${choice.model}`;

/**
 * Model chip for a composer. With `conversationId` it reads that conversation's model and saves
 * the choice there; without one it is a controlled choice for a message that has no conversation yet.
 */
export function ModelPicker({ conversationId, value, onChange, disabled = false, className = '' }: {
  conversationId?: string;
  value?: ModelChoice | null;
  onChange?: (choice: ModelChoice) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const settings = state?.settings;
  const conversation = conversationId ? state?.conversations.find(item => item.id === conversationId) : undefined;
  const saved = conversation ? conversation.model : value ?? settings?.defaultModel ?? null;
  const locked = disabled || pending || Boolean(conversation?.busy);

  const choose = async (choice: ModelChoice) => {
    if (locked || !conversationId && (saved?.provider === choice.provider && saved?.model === choice.model)) { setOpen(false); return; }
    setPending(true); setError('');
    try {
      if (conversationId) await client.send({ type: 'conversation.update', conversationId, model: choice });
      onChange?.(choice);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '모델을 저장하지 못했습니다.');
    } finally { setPending(false); }
  };

  return <Popover open={open} onOpenChange={next => { if (!pending) { setOpen(next); if (!next) setError(''); } }}>
    <PopoverTrigger asChild>
      <button type="button" disabled={locked} title={locked && conversation?.busy ? '진행 중인 응답이 끝난 뒤 모델을 바꿀 수 있습니다.' : undefined}
        className={`composer-chip max-w-[220px] ${className}`} aria-label={`모델 ${modelDisplayName(settings, saved)} 선택`}>
        <span className="truncate">{modelDisplayName(settings, saved)}</span>
        <ChevronDown size={13} className="flex-none text-ink-3" aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" className="w-64 max-w-[calc(100vw-2rem)] p-1.5" aria-label="모델 선택">
      <div className="max-h-[60dvh] overflow-auto">
        {usableProviders(settings).map(provider => <section key={provider.id} className="py-1">
          <p className="m-0 px-2.5 py-1 text-caption font-medium text-ink-3">{provider.name}</p>
          {provider.models.map(model => {
            const selected = saved?.provider === provider.id && saved?.model === model.id;
            return <button key={model.id} type="button" onClick={() => void choose({ provider: provider.id, model: model.id })}
              aria-pressed={selected}
              className="flex min-h-9 w-full items-center gap-2 rounded-control px-2.5 text-left text-ui text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
              <span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>
              {selected && <Check size={14} className="flex-none text-ink-2" aria-hidden="true"/>}
            </button>;
          })}
        </section>)}
        {!usableProviders(settings).length && <p className="m-0 p-2.5 text-caption text-ink-3">사용할 수 있는 모델이 없습니다. 설정에서 제공자를 등록해 주세요.</p>}
      </div>
      {error && <div className="px-1 pt-1.5"><InlineError>{error}</InlineError></div>}
    </PopoverContent>
  </Popover>;
}
