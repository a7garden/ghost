import { useState, type FormEvent } from 'react';
import type { ModelRef, Settings } from '@ghost/contract';
import { Button, InlineError, SettingsGroup } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { modelDisplayName, modelFromKey, modelSelectOptions } from '../pets/ModelPicker';
import { Choice, EditorActions, errorText, TextField } from './InfrastructureFields';

type Slot = Settings['slots'][string];
export function SlotSettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [editing, setEditing] = useState<string | null>(null), [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!state) return null;
  const slots = state.settings.slots;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); setRemoving(null); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <SettingsGroup title="모델 자리" actions={<Button onClick={() => { setCreating(true); setEditing(null); }}>자리 추가</Button>}>
    {error && <InlineError>{error}</InlineError>}
    <fieldset disabled={busy} className="border-0 p-0 m-0"><Choice label="기본 모델 자리" value={state.settings.defaultSlot ?? ''} onChange={name => void act(() => client.send({ type: 'settings.update', defaultSlot: name || null }))} options={[{ value: '', label: '지정 안 함' }, ...Object.keys(slots).map(name => ({ value: name, label: name }))]}/></fieldset>
    {(creating || editing !== null) && <SlotEditor key={creating ? 'new' : editing!} name={creating ? null : editing} slot={editing !== null ? slots[editing] : undefined} onClose={() => { setCreating(false); setEditing(null); }}/>}
    {!Object.keys(slots).length && !creating && <p className="infra-record__meta">등록된 모델 자리가 없습니다.</p>}
    {Object.entries(slots).map(([name, slot]) => <article className="infra-record" key={name}>
      <div className="infra-record__head"><h3>{name}{state.settings.defaultSlot === name ? ' · 기본' : ''}</h3><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => { setEditing(name); setCreating(false); }}>편집</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(name)}>삭제</Button></div></div>
      <p className="infra-record__meta">{[slot.model, ...slot.fallbacks].map(model => modelDisplayName(state.settings, model)).join(' → ')}</p>
      {removing === name && <div className="infra-delete"><p>{name} 모델 자리를 삭제할까요?</p><div className="infra-actions"><Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => void act(() => client.send({ type: 'slot.delete', name }))}>자리 삭제</Button></div></div>}
    </article>)}
  </SettingsGroup>;
}

function SlotEditor({ name: original, slot, onClose }: { name: string | null; slot?: Slot; onClose(): void }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [name, setName] = useState(original ?? '');
  const [model, setModel] = useState(slot?.model ? `${slot.model.provider}/${slot.model.model}` : '');
  const [fallbacks, setFallbacks] = useState<string[]>(slot?.fallbacks.map(item => `${item.provider}/${item.model}`) ?? []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const options = modelSelectOptions(state?.settings);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const primary = modelFromKey(state?.settings, model);
      const alternatives = fallbacks.map(value => modelFromKey(state?.settings, value));
      if (!primary || alternatives.some(value => !value)) throw new Error('모델을 선택하세요.');
      if (new Set([model, ...fallbacks]).size !== fallbacks.length + 1) throw new Error('대체 모델은 서로 달라야 합니다.');
      if (original === null && state?.settings.slots[name]) throw new Error('이미 등록된 자리 이름입니다.');
      await client.send({ type: 'slot.set', name, model: primary, fallbacks: alternatives as ModelRef[] }); onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="infra-form" onSubmit={event => void save(event)} aria-label={original ? '모델 자리 편집' : '모델 자리 추가'}>
    <fieldset disabled={busy} className="infra-form border-0 p-0 m-0">
      {original ? <p>{original}</p> : <TextField label="자리 이름" required value={name} onChange={setName} pattern="[a-z][a-z0-9-]{0,31}" maxLength={32}/>}
      <Choice label="모델" required value={model} onChange={setModel} options={[{ value: '', label: '선택' }, ...options]}/>
      {fallbacks.map((value, index) => <div className="infra-form" key={index}>
        <Choice label={`대체 모델 ${index + 1}`} value={value} onChange={next => setFallbacks(items => items.map((item, at) => at === index ? next : item))} required options={[{ value: '', label: '선택' }, ...options]}/>
        <div className="infra-actions"><Button type="button" variant="ghost" disabled={index === 0} onClick={() => setFallbacks(items => { const next = [...items]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}>위로</Button><Button type="button" variant="ghost" onClick={() => setFallbacks(items => items.filter((_, at) => at !== index))}>삭제</Button></div>
      </div>)}
      <Button type="button" variant="outline" disabled={fallbacks.length >= 3} onClick={() => setFallbacks(items => [...items, ''])}>대체 모델 추가</Button>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}<EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
