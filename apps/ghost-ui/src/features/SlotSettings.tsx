import { useState, type FormEvent } from 'react';
import { Layers } from 'lucide-react';
import type { ModelRef, Settings } from '@ghost/contract';
import { Button, InlineError, SelectField, SettingsGroup, SettingsRow } from '../ui';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { uiTerms } from '../uiText';
import { NO_MODEL, modelDisplayName, modelFromKey, modelSelectOptions } from '../pets/ModelPicker';
import { Choice, EditorActions, errorText, TextField } from './InfrastructureFields';
import './SettingsPages.css';

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
  return <SettingsGroup title={<span className="sr-only">{uiTerms.modelCombos}</span>} className="settings-ledger__group"
    actions={<Button variant="add" aria-expanded={creating} onClick={() => { setCreating(!creating); setEditing(null); setRemoving(null); }}>조합 추가</Button>}>
    {error && removing === null && <InlineError>{error}</InlineError>}
    {entries.length > 0 && <SettingsRow label="기본 모델 조합">
      <SelectField label="기본 모델 조합" className="settings-ledger__select" value={state.settings.defaultSlot ?? NO_MODEL} disabled={busy}
        onValueChange={name => void act(() => client.send({ type: 'settings.update', defaultSlot: name === NO_MODEL ? null : name }))}
        options={[{ value: NO_MODEL, label: '지정 안 함' }, ...entries.map(([name]) => ({ value: name, label: name }))]} />
    </SettingsRow>}
    {creating && <div className="settings-ledger__branch"><SlotEditor name={null} onClose={() => setCreating(false)}/></div>}
    {!entries.length && !creating && <p className="settings-ledger__note">저장된 조합이 없습니다.</p>}
    {entries.map(([name, slot]) => {
      const selected = editing === name;
      const deleting = removing === name;
      return <article className="settings-ledger__record" key={name}>
        <div className="settings-ledger__record-head" data-selected={selected || deleting || undefined}>
          <Layers size={16} className="text-ink-3" aria-hidden="true"/>
          <div className="settings-ledger__record-copy">
            <span className="settings-ledger__label">{name}</span>
            <p className="settings-ledger__meta">{[slot.model, ...slot.fallbacks].map(model => modelDisplayName(state.settings, model)).join(' → ')}</p>
          </div>
          <span className="settings-ledger__actions">
            <Button variant="ghost" size="sm" aria-expanded={selected} onClick={() => { setEditing(selected ? null : name); setCreating(false); setRemoving(null); }}>편집</Button>
            <Button variant="ghost" size="sm" aria-expanded={deleting} disabled={busy} onClick={() => { setRemoving(deleting ? null : name); setEditing(null); setCreating(false); setError(''); }}>삭제</Button>
          </span>
        </div>
        {selected && <div className="settings-ledger__branch"><SlotEditor name={name} slot={slot} onClose={() => setEditing(null)}/></div>}
        {deleting && <div className="settings-ledger__branch">
          <p className="m-0">{name} 모델 조합을 삭제할까요?</p>
          {error && <InlineError>{error}</InlineError>}
          <div className="settings-ledger__actions">
            <Button variant="ghost" disabled={busy} onClick={() => { setRemoving(null); setError(''); }}>취소</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void act(() => client.send({ type: 'slot.delete', name }))}>조합 삭제</Button>
          </div>
        </div>}
      </article>;
    })}
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
      {!original && <div className="grid gap-1 min-w-0">
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
