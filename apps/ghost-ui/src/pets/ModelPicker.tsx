import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button, Checkbox, InlineError, Popover, PopoverContent, PopoverTrigger, SelectField } from '@garden/ui';
import { effortLabel, inferenceRequest, type InferenceConfiguration } from './InferenceSettings';

type Pair = { ghost_id: string; conversation_id: string };
export type ModelSelection = { provider: string; model: string; effort: string };
/** A model chosen before the conversation exists; applied to the Ghost's conversation when the message lands. */
export type ModelChoice = { selection: ModelSelection; allowExternal: boolean };

const pairKey = (pair: Pair) => `${pair.ghost_id}/${pair.conversation_id}`;
export const turnLockedMessage = '진행 중인 응답이 끝난 뒤 모델을 바꿀 수 있습니다.';

/** Saves one conversation's model, re-reading the settings version first so a stale picker cannot overwrite a newer save. */
export async function applyConversationModel(pair: Pair, choice: ModelChoice, publicOnly = false): Promise<void> {
  const current = await inferenceRequest();
  const saved = current.settings.conversations[pairKey(pair)] ?? current.settings.default;
  if (saved.provider === choice.selection.provider && saved.model === choice.selection.model && saved.effort === choice.selection.effort) return;
  // Registry entries carry more fields; the settings API accepts exactly the two ids.
  try {
    await inferenceRequest({ version: current.settings.version, operation: 'select', ghost_id: pair.ghost_id, conversation_id: pair.conversation_id, selection: choice.selection,
      ...(!publicOnly ? { allow_external: choice.allowExternal } : {}) });
  } catch (reason) {
    // The Host refuses a switch while a turn is unresolved; say so in the owner's language.
    if (reason instanceof Error && /finish or reconcile the current turn/i.test(reason.message)) throw new Error(turnLockedMessage);
    throw reason;
  }
}

/**
 * Model chip for a composer. With `pair` it reads and saves that conversation's model;
 * without one it is a controlled choice for a message that has no conversation yet.
 */
export function ModelPicker({ pair, publicOnly = false, disabled = false, connected = true, turnActive = false, value, onChange }: {
  pair?: Pair; publicOnly?: boolean; disabled?: boolean; connected?: boolean;
  /** A reply is still unresolved; the Host keeps the model until it settles. */
  turnActive?: boolean;
  value?: ModelChoice; onChange?: (choice: ModelChoice | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<InferenceConfiguration>(), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ModelSelection>(), [allow, setAllow] = useState(false);
  const consentId = useId();
  const key = pair ? pairKey(pair) : '';

  useEffect(() => {
    if (!connected) return;
    let current = true;
    setError('');
    void inferenceRequest().then(next => { if (current) setData(next); })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : '모델 설정을 불러오지 못했습니다.'); });
    return () => { current = false; };
  }, [connected, key, open]);

  const saved = data && (pair ? data.settings.conversations[key] ?? data.settings.default : value?.selection ?? data.settings.default);
  useEffect(() => { if (open && saved) { setDraft(saved); setAllow(Boolean(value?.allowExternal && !pair)); } }, [open, saved?.provider, saved?.model, saved?.effort]);

  const provider = data?.providers.find(item => item.id === draft?.provider);
  const registered = provider?.auth !== 'api_key' || data?.settings.credentials[provider.id] === true;
  const granted = Boolean(pair && draft && data?.settings.external_grants[key]?.includes(draft.provider));
  const changed = Boolean(draft && saved && (draft.provider !== saved.provider || draft.model !== saved.model || draft.effort !== saved.effort));
  const needsGrant = Boolean(!publicOnly && changed && draft!.provider !== 'local' && !granted);
  const usable = Boolean(draft && !(publicOnly && draft.provider === 'local') && provider?.models.includes(draft.model) && provider.efforts.includes(draft.effort));
  const locked = disabled || !connected || saving || !data || turnActive;
  const label = saved ? `${saved.model} · ${effortLabel(saved.effort)}` : '모델';

  const apply = async () => {
    if (!draft || locked) return;
    const choice = { selection: draft, allowExternal: needsGrant ? allow : granted };
    if (!pair) { onChange?.(choice); setOpen(false); return; }
    setSaving(true); setError('');
    try {
      await applyConversationModel(pair, choice, publicOnly);
      setData(await inferenceRequest());
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '모델을 저장하지 못했습니다.');
    } finally { setSaving(false); }
  };

  return <Popover open={open} onOpenChange={next => !saving && setOpen(next)}>
    <PopoverTrigger asChild>
      <button type="button" disabled={disabled || !connected} aria-label={`모델: ${label}`}
        className="inline-flex h-7 min-w-0 max-w-56 cursor-pointer items-center gap-1 rounded-full px-2 text-caption text-ink-2 outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50">
        <span className="min-w-0 truncate">{label}</span><ChevronDown size={12} className="shrink-0" aria-hidden="true"/>
      </button>
    </PopoverTrigger>
    <PopoverContent side="top" align="start" aria-label="모델" className="grid w-72 max-w-[calc(100vw-1rem)] gap-3">
      {!data && !error && <p className="m-0 text-caption text-ink-2" role="status">모델 설정을 불러오는 중…</p>}
      {data && draft && <>
        <SelectField label="제공자" disabled={locked} value={draft.provider} onValueChange={id => {
          const next = data.providers.find(item => item.id === id);
          if (next?.default_model) { setDraft({ provider: next.id, model: next.default_model, effort: next.default_effort }); setAllow(false); }
        }} options={[
          ...(!provider ? [{ value: draft.provider, label: `${draft.provider} · 사용 불가` }] : []),
          ...data.providers.map(item => ({ value: item.id, label: item.name, disabled: !item.models.length || publicOnly && item.id === 'local' })),
        ]}/>
        <SelectField label="모델" disabled={locked || !provider?.models.length} value={draft.model} onValueChange={model => setDraft({ ...draft, model })} options={[
          ...(!provider?.models.includes(draft.model) ? [{ value: draft.model, label: `${draft.model} · 사용 불가` }] : []),
          ...(provider?.models.map(model => ({ value: model, label: model })) ?? []),
        ]}/>
        <SelectField label="추론 수준" disabled={locked || !provider?.efforts.length} value={draft.effort} onValueChange={effort => setDraft({ ...draft, effort })} options={[
          ...(!provider?.efforts.includes(draft.effort) ? [{ value: draft.effort, label: `${effortLabel(draft.effort)} · 사용 불가` }] : []),
          ...(provider?.efforts.map(effort => ({ value: effort, label: effortLabel(effort) })) ?? []),
        ]}/>
        {needsGrant && <div className="flex items-start gap-2 text-caption text-ink">
          <Checkbox id={consentId} checked={allow} disabled={locked} onCheckedChange={next => setAllow(next === true)}/>
          <label htmlFor={consentId} className="min-w-0 [overflow-wrap:anywhere]">이 대화의 기존 기록과 새 메시지를 {provider?.name ?? draft.provider}에 보내는 것을 허용합니다.</label>
        </div>}
        {!registered && <p className="m-0 text-caption text-ink-2">설정에서 {provider?.name ?? draft.provider} API 키를 먼저 등록하세요.</p>}
        <Button type="button" disabled={locked || !changed || !usable || !registered || needsGrant && !allow} onClick={() => void apply()}>
          {saving ? '저장 중…' : '적용'}
        </Button>
      </>}
      {turnActive && <p className="m-0 text-caption text-ink-2">{turnLockedMessage}</p>}
      {error && <InlineError>{error}</InlineError>}
    </PopoverContent>
  </Popover>;
}
