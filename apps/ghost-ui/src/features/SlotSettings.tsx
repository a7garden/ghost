import { useState, type FormEvent } from 'react';
import type { ModelRef, Settings } from '@ghost/contract';
import { Badge, Button, InlineError, SelectField, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { NO_MODEL, modelDisplayName, modelFromKey, modelSelectOptions } from '../pets/ModelPicker';
import { Choice, EditorActions, errorText, TextField } from './InfrastructureFields';

type Slot = NonNullable<Settings['slots']>[string];
export function SlotSettings() {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const [editing, setEditing] = useState<string | null>(null), [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (!state) return null;
  const slots = state.settings.slots ?? {};
  const entries = Object.entries(slots);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await work(); setRemoving(null); } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <SettingsGroup title={uiTerms.modelCombos} actions={<Button onClick={() => { setCreating(true); setEditing(null); }}>조합 추가</Button>}
    description="모델 하나와 실패했을 때 이어받을 모델들을 묶어 이름을 붙입니다. 평가나 재시도처럼 일에 쓸 모델을 고를 때 이 이름으로 고릅니다.">
    {error && <InlineError>{error}</InlineError>}
    {entries.length > 0 && <SettingsRow label="기본 모델 조합" description="조합을 따로 고르지 않은 일이 쓰는 조합입니다.">
      <SelectField label="기본 모델 조합" className="w-[220px] max-w-full" value={state.settings.defaultSlot ?? NO_MODEL} disabled={busy}
        onValueChange={name => void act(() => client.send({ type: 'settings.update', defaultSlot: name === NO_MODEL ? null : name }))}
        options={[{ value: NO_MODEL, label: '지정 안 함' }, ...entries.map(([name]) => ({ value: name, label: name }))]} />
    </SettingsRow>}
    {(creating || editing !== null) && <div className="px-4 py-3"><SlotEditor key={creating ? 'new' : editing!} name={creating ? null : editing} slot={editing !== null ? slots[editing] : undefined} onClose={() => { setCreating(false); setEditing(null); }}/></div>}
    {!entries.length && !creating && <p className="m-0 p-4 text-caption text-ink-2">아직 만들어 둔 조합이 없습니다.</p>}
    {entries.map(([name, slot]) => <article className="min-w-0 border-b border-line last:border-b-0" key={name}>
      <SettingsRow label={<>{name}{state.settings.defaultSlot === name && <Badge className="ml-2">기본</Badge>}</>}
        description={[slot.model, ...slot.fallbacks].map(model => modelDisplayName(state.settings, model)).join(' → ')}>
        <span className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setEditing(name); setCreating(false); }}>편집</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(name)}>삭제</Button>
        </span>
      </SettingsRow>
      {removing === name && <div className="grid gap-3 px-4 pb-4">
        <p className="m-0">{name} 모델 조합을 삭제할까요?</p>
        <div className="infra-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>취소</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void act(() => client.send({ type: 'slot.delete', name }))}>조합 삭제</Button>
        </div>
      </div>}
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
      const resolve = (key: string) => {
        const stored = slot ? [slot.model, ...slot.fallbacks].find(item => `${item.provider}/${item.model}` === key) : undefined;
        return stored ?? modelFromKey(state?.settings, key);
      };
      const primary = resolve(model);
      const alternatives = fallbacks.map(resolve);
      if (!primary || alternatives.some(value => !value)) throw new Error('모델을 선택하세요.');
      if (new Set([model, ...fallbacks]).size !== fallbacks.length + 1) throw new Error('대체 모델은 서로 달라야 합니다.');
      if (original === null && state?.settings.slots?.[name]) throw new Error('이미 등록된 조합 이름입니다.');
      await client.send({ type: 'slot.set', name, model: primary, fallbacks: alternatives as ModelRef[] }); onClose();
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  };
  return <form className="infra-form" onSubmit={event => void save(event)} aria-label={original ? '모델 조합 편집' : '모델 조합 추가'}>
    <fieldset disabled={busy} className="infra-form border-0 p-0 m-0 min-w-0">
      {original ? <p className="m-0">{original}</p> : <div className="grid gap-1 min-w-0">
        <TextField label="조합 이름" required value={name} onChange={setName} pattern={'[a-z][a-z0-9\\-]{0,31}'} maxLength={32}/>
        <p className="m-0 text-caption text-ink-2">이름은 소문자·숫자·하이픈으로 만듭니다.</p>
      </div>}
      <Choice label="모델" required value={model} onChange={setModel} options={[{ value: '', label: '선택' }, ...options]}/>
      {fallbacks.map((value, index) => <div className="infra-form" key={index}>
        <Choice label={`대체 모델 ${index + 1}`} value={value} onChange={next => setFallbacks(items => items.map((item, at) => at === index ? next : item))} required options={[{ value: '', label: '선택' }, ...options]}/>
        <div className="infra-actions"><Button type="button" variant="ghost" disabled={index === 0} onClick={() => setFallbacks(items => { const next = [...items]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; })}>위로</Button><Button type="button" variant="ghost" onClick={() => setFallbacks(items => items.filter((_, at) => at !== index))}>삭제</Button></div>
      </div>)}
      <Button type="button" variant="add" size="sm" disabled={fallbacks.length >= 3} onClick={() => setFallbacks(items => [...items, ''])}>대체 모델 추가</Button>
    </fieldset>
    {error && <InlineError>{error}</InlineError>}<EditorActions busy={busy} onCancel={onClose}/>
  </form>;
}
