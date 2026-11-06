import { useEffect, useRef, useState } from 'react';
import { FormField, SelectField } from '@garden/ui';
import type { Command, Conversation, Snapshot } from '../client/types';
import { conversationModelChoices, conversationModelCommand, modelSelectionLabel, selectedConversationModel } from './modelSelection';

type Props = { snapshot: Snapshot; profileId: string; conversation?: Conversation; busy: boolean; connected: boolean; mode: string; action(command: Command): Promise<Record<string, any>>; onCreated(id: string): void; onSaving(saving: boolean): void; navigate(route: string): void; running: boolean };
export function ConversationModelPicker(props: Props) {
  const key = `${props.snapshot.workspace_id}:${props.profileId}:${props.conversation?.id ?? 'new'}`;
  const choices = conversationModelChoices(props.snapshot.model_settings), saved = selectedConversationModel(props.snapshot, props.conversation);
  const [request, setRequest] = useState<{ key: string; value: string; id: number } | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const latest = useRef(request); latest.current = request;
  const sequence = useRef(0), activeKey = useRef(key); activeKey.current = key;
  const pending = request?.key === key ? request : null;
  const value = pending?.value ?? saved;
  useEffect(() => { props.onSaving(Boolean(pending) || saving); }, [Boolean(pending), saving, props.onSaving]);
  useEffect(() => { setError(''); }, [key]);
  useEffect(() => {
    if (!pending || props.busy || saving || !props.connected || props.mode !== 'live') return;
    const captured = pending, identity = key, bound = props;
    setSaving(true); setError('');
    void (async () => {
      try {
        let cid = bound.conversation?.id;
        if (!cid) {
          const result = await bound.action({ type: 'create_conversation', profile_id: bound.profileId, model: captured.value, tools: true });
          cid = result.conversation_id;
          if (activeKey.current === identity && cid) {
            const next = latest.current && latest.current.id !== captured.id ? { ...latest.current, key: `${bound.snapshot.workspace_id}:${bound.profileId}:${cid}` } : null;
            latest.current = next; setRequest(next); bound.onCreated(cid);
          }
        } else await bound.action(conversationModelCommand(bound.profileId, cid, captured.value));
        if (latest.current?.id === captured.id) setRequest(null);
        // A later choice remains queued and is saved as soon as this request
        // completes. No older response can overwrite that last user intent.
      } catch (e) {
        if (activeKey.current === identity && latest.current?.id === captured.id) {
          setRequest(null); setError(e instanceof Error ? e.message : '모델 선택을 저장하지 못했습니다. 다시 선택해 주세요.');
        }
      } finally { setSaving(false); }
    })();
  }, [pending, props.busy, props.connected, props.mode, saving, key]);
  const missing = value !== 'mock' && !choices.some(choice => choice.value === value);
  const unavailable = props.conversation?.model_available === false && !pending;
  const supported = props.mode === 'live' && Boolean(props.snapshot.model_settings);
  const options = [
    ...(missing ? [{ value, label: `${modelSelectionLabel(value, choices)} · 사용할 수 없음`, disabled: true }] : []),
    ...choices.map(choice => ({ value: choice.value, label: `${choice.label} · ${choice.provider}${choice.status ? ` · ${choice.status}` : ''}`, disabled: !choice.enabled })),
    { value: 'mock', label: '오프라인 테스트 모델' },
  ];
  return <div className="grid min-w-0 max-w-full gap-1">
    <FormField label="이 대화의 모델" description="선택한 모델은 이 대화의 다음 응답부터 적용됩니다." className="max-w-[330px]">
      {control => <SelectField {...control} label="이 대화의 모델" value={value} options={options} disabled={!supported || !props.connected} className="w-full bg-transparent shadow-none hover:bg-hover" onValueChange={next => { setError(''); setRequest({ key, value: next, id: ++sequence.current }); }}/>}
    </FormField>
    <div className="max-w-[350px] text-caption leading-relaxed text-ink-2 [overflow-wrap:anywhere] empty:hidden" aria-live="polite">{pending || saving ? '모델 선택 저장 중…' : props.conversation?.model_pending && props.running ? `현재: ${modelSelectionLabel(props.conversation.model, choices)} · 다음: ${modelSelectionLabel(value, choices)}` : null}</div>
    {(unavailable || missing || !supported || error) && <div className="flex flex-wrap gap-x-2 gap-y-1 text-caption leading-relaxed [overflow-wrap:anywhere]">{error && <span className="text-red" role="alert">{error}</span>}{unavailable && <span className="text-ink-2">{props.conversation?.model_error || '선택한 모델을 사용할 수 없습니다. 다른 모델을 선택해 주세요.'}</span>}<button type="button" className="text-ink-2 underline underline-offset-2 hover:text-ink" onClick={() => props.navigate('/settings?tab=models')}>모델 관리</button></div>}
  </div>;
}
