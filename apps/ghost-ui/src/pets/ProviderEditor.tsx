import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input, SelectField } from '@garden/ui';
import type { ModelInfo, ProviderKind } from '@ghost/contract';
import { Modal } from '../components/Modal';

const KINDS: { value: ProviderKind; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'zai', label: 'Z.AI' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'google', label: 'Google' },
  { value: 'openai_compatible', label: 'OpenAI 호환 서버' },
];

/** The fields `provider.upsert` takes; the UI keeps them as one draft. */
export interface ProviderDraft { id: string; kind: ProviderKind; name: string; baseUrl: string | null; models: ModelInfo[] }
/** `apiKey` tri-state: undefined keeps the stored credential, null removes it, a value replaces it. */
export interface ProviderSave { draft: ProviderDraft; apiKey?: string | null }

export const providerKindLabel = (kind: ProviderKind) => KINDS.find(item => item.value === kind)?.label ?? kind;

export function emptyDraft(): ProviderDraft {
  return { id: '', kind: 'openai_compatible', name: '', baseUrl: null, models: [] };
}

export function ProviderEditor({ initial, existing, hasCredential, busy, onClose, onSave }: {
  initial: ProviderDraft; existing: boolean; hasCredential: boolean; busy: boolean;
  onClose(): void;
  onSave(save: ProviderSave): Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [newModel, setNewModel] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const patch = (p: Partial<ProviderDraft>) => setValue(v => ({ ...v, ...p }));
  const addModel = () => {
    const id = newModel.trim();
    if (!id) return;
    if (value.models.some(model => model.id === id)) { setError('이미 등록된 모델 ID입니다.'); return; }
    if (id.length > 256) { setError('모델 ID는 256자 이하여야 합니다.'); return; }
    patch({ models: [...value.models, { id, name: id }] });
    setNewModel(''); setError('');
  };
  const save = () => {
    if (locked) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id)) { setError('제공자 ID는 소문자·숫자·하이픈·밑줄로 시작하거나 이어야 합니다.'); return; }
    if (!value.name.trim()) { setError('제공자 이름을 입력해 주세요.'); return; }
    if (!value.models.length) { setError('모델을 한 개 이상 등록해 주세요.'); return; }
    setSaving(true); setError('');
    const key = removeKey ? null : apiKey.trim() || undefined;
    void onSave({ draft: value, apiKey: key }).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.')).finally(() => setSaving(false));
  };
  return <Modal title={existing ? `${initial.name} 편집` : '제공자 등록'} onClose={() => !locked && onClose()} className="w-[min(620px,calc(100vw-2rem))] sm:max-w-[620px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); save(); }}>
      <div className="grid gap-4 max-[480px]:grid-cols-1 sm:grid-cols-2">
        <FormField label="이름">{control => <Input {...control} value={value.name} maxLength={128} required disabled={locked} onChange={event => patch({ name: event.target.value })}/>}</FormField>
        <FormField label="제공자 ID" description={existing ? '등록된 ID는 바꿀 수 없습니다.' : '소문자·숫자·하이픈·밑줄'}>
          {control => <Input {...control} value={value.id} maxLength={64} pattern="[a-z0-9][a-z0-9_-]{0,63}" required disabled={locked || existing} onChange={event => patch({ id: event.target.value.toLowerCase() })}/>}
        </FormField>
      </div>
      <FormField label="종류">{control => <SelectField {...control} label="종류" value={value.kind} disabled={locked} onValueChange={kind => patch({ kind: kind as ProviderKind })} options={KINDS}/>}</FormField>
      <FormField label="서버 주소" description="비워 두면 종류의 기본 주소를 사용합니다. OpenAI 호환 서버에는 주소가 필요합니다.">
        {control => <Input {...control} type="url" value={value.baseUrl ?? ''} placeholder="http://127.0.0.1:11434/v1" disabled={locked} onChange={event => patch({ baseUrl: event.target.value.trim() || null })}/>}
      </FormField>
      <section className="flex min-w-0 flex-col gap-3.5 border-t border-line pt-4">
        <h3 className="m-0 text-caption font-semibold text-ink">모델 · {value.models.length}개</h3>
        <div className="flex max-h-[32dvh] min-h-16 flex-col gap-3 overflow-auto p-1">
          {value.models.map(model => <div className="flex min-w-0 items-center gap-2.5 border-b border-line pb-2.5" key={model.id}>
            <strong title={model.id} className="min-w-0 flex-1 truncate text-caption font-normal">{model.name || model.id}</strong>
            <Button variant="ghost" size="icon" type="button" aria-label={`${model.name || model.id} 모델 삭제`} disabled={locked} onClick={() => patch({ models: value.models.filter(entry => entry.id !== model.id) })}><X size={14}/></Button>
          </div>)}
          {!value.models.length && <p className="m-0 text-caption text-ink-3">모델 ID를 입력해 등록해 주세요.</p>}
        </div>
        <div className="flex items-center gap-2">
          <Input aria-label="추가할 모델 ID" placeholder="모델 ID" value={newModel} maxLength={256} disabled={locked} className="min-w-0 flex-1"
            onChange={event => setNewModel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addModel(); } }}/>
          <Button className="flex-none" variant="outline" type="button" disabled={locked || !newModel.trim()} onClick={addModel}><Plus size={14}/>추가</Button>
        </div>
      </section>
      <section className="flex min-w-0 flex-col gap-2.5 border-t border-line pt-4">
        <h3 className="m-0 text-caption font-semibold text-ink">인증</h3>
        {existing && hasCredential && <>
          <div className="flex items-center gap-2.5">
            <Checkbox id="provider-remove-key" checked={removeKey} disabled={locked} onCheckedChange={checked => setRemoveKey(checked === true)}/>
            <label htmlFor="provider-remove-key" className="text-caption text-ink">저장된 인증 키 삭제</label>
          </div>
          {!removeKey && <FormField label="새 인증 키" description="비워 두면 저장된 키를 그대로 사용합니다. 키는 호스트에만 저장되며 다시 표시되지 않습니다.">
            {control => <Input {...control} type="password" value={apiKey} placeholder="저장된 키 사용" maxLength={4096} disabled={locked} autoComplete="off" onChange={event => setApiKey(event.target.value)}/>}
          </FormField>}
        </>}
        {!(existing && hasCredential) && <FormField label="인증 키" description="호스트에만 저장되며 다시 표시되지 않습니다.">
          {control => <Input {...control} type="password" value={apiKey} maxLength={4096} disabled={locked} autoComplete="off" onChange={event => setApiKey(event.target.value)}/>}
        </FormField>}
      </section>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={locked} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={locked}>{saving ? '저장 중…' : '저장'}</Button>
      </div>
    </form>
  </Modal>;
}
