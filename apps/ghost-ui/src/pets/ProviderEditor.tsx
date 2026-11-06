import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Checkbox, FormField, InlineError, Input, SelectField, Switch } from '@garden/ui';
import type { ModelProvider, ModelRole } from '../client/types';
import { Modal } from '../components/Modal';

const roles: ModelRole[] = ['llm', 'stt', 'tts'];
export function ProviderEditor({ initial, version, existing, busy, saveBlocked, onClose, onSave }: { initial: ModelProvider; version: number; existing: boolean; busy: boolean; saveBlocked?: string; onClose: () => void; onSave: (provider: ModelProvider, version: number) => Promise<void> }) {
  const [value, setValue] = useState(initial), [search, setSearch] = useState(''), [newModel, setNewModel] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const enabledId = useId();
  const locked = busy || saving;
  const patch = (p: Partial<ModelProvider>) => setValue(v => ({ ...v, ...p }));
  const toggleRole = (role: ModelRole, checked: boolean) => patch({ roles: checked ? [...value.roles, role] : value.roles.filter(r => r !== role), models: checked ? value.models : value.models.map(m => ({ ...m, roles: m.roles.filter(r => r !== role) })) });
  const matches = value.models.map((m, index) => ({ m, index })).filter(({ m }) => `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase()));
  const add = () => {
    const id = newModel.trim(); if (!id) return;
    if (value.models.some(m => m.id === id)) { setError('이미 등록된 모델 ID입니다.'); return; }
    patch({ models: [...value.models, { id, name: id, roles: [value.roles[0] ?? 'llm'] }] }); setNewModel(''); setSearch(id); setError('');
  };
  return <Modal title={existing ? `${initial.name} 편집` : '제공자 등록'} onClose={() => !locked && onClose()} className="w-[min(620px,calc(100vw-2rem))] sm:max-w-[620px]"><form className="flex flex-col gap-4" onSubmit={e => {
    e.preventDefault(); if (locked || saveBlocked) return;
    if (!value.roles.length || value.models.some(m => !m.roles.length)) { setError('제공자와 각 모델의 역할을 선택해 주세요.'); return; }
    if (value.models.length > 2000) { setError('모델은 최대 2,000개까지 등록할 수 있습니다.'); return; }
    setSaving(true); setError(''); void onSave(value, version).catch(e => setError(e instanceof Error ? e.message : '저장하지 못했습니다.')).finally(() => setSaving(false));
  }}>
    <div className="grid gap-4 max-[480px]:grid-cols-1 sm:grid-cols-2">
      <FormField label="이름">{control => <Input {...control} value={value.name} maxLength={80} required disabled={locked} onChange={e => patch({ name: e.target.value })}/>}</FormField>
      <FormField label="제공자 ID">{control => <Input {...control} value={value.id} maxLength={80} pattern="[A-Za-z0-9_-]+" required disabled={locked || existing || value.kind === 'builtin'} onChange={e => patch({ id: e.target.value })}/>}</FormField>
    </div>
    <FormField label="서버 주소">{control => <Input {...control} type="url" value={value.endpoint} placeholder="http://127.0.0.1:11434/v1" required disabled={locked || value.auth.type === 'sdk'} onChange={e => patch({ endpoint: e.target.value })}/>}</FormField>
    <FormField label="인증">{control => <SelectField {...control} label="인증" value={value.auth.type} disabled={locked} onValueChange={auth => patch({ auth: auth === 'env' ? { type: 'env', variable: '' } : { type: auth as 'none' | 'sdk' } })}
      options={[{ value: 'none', label: '없음' }, ...(value.kind === 'builtin' ? [{ value: 'sdk', label: '저장된 제공자 인증' }] : []), { value: 'env', label: '환경 변수' }]}/>}</FormField>
    {value.auth.type === 'env' && <FormField label="환경 변수 이름" description="호스트에 설정된 변수 이름만 입력합니다. 키 값은 저장하지 않습니다.">
      {control => <Input {...control} value={value.auth.variable ?? ''} placeholder="LOCAL_MODEL_API_KEY" pattern="[A-Z0-9_]+" maxLength={100} required disabled={locked} onChange={e => patch({ auth: { type: 'env', variable: e.target.value } })}/>}
    </FormField>}
    {value.auth.type === 'sdk' && <p className="m-0 text-caption text-ink-3">해당 제공자에 이미 저장된 인증을 사용합니다.</p>}
    <fieldset className="m-0 min-w-0"><legend className="mb-2.5 text-caption text-ink-2">서버에서 사용할 역할</legend>
      <div className="flex flex-wrap items-center gap-3.5">{roles.map(role => <label key={role} className="flex items-center gap-2 text-caption text-ink">
        <Checkbox aria-label={role.toUpperCase()} checked={value.roles.includes(role)} disabled={locked} onCheckedChange={checked => toggleRole(role, checked === true)}/>{role.toUpperCase()}</label>)}</div>
    </fieldset>
    <div className="flex items-center gap-2.5">
      <Switch id={enabledId} checked={value.enabled} disabled={locked} onCheckedChange={enabled => patch({ enabled })}/>
      <label htmlFor={enabledId} className="text-caption text-ink">제공자 사용</label>
    </div>
    <section className="flex min-w-0 flex-col gap-3.5 border-t border-line pt-4"><h3 className="m-0 text-caption font-semibold text-ink">등록할 모델 · {value.models.length}개</h3><div className="flex max-h-[40dvh] flex-col gap-3 overflow-auto p-1">
      {value.models.length > 10 && <Input aria-label="등록할 모델 검색" placeholder="모델 ID 검색" value={search} onChange={e => setSearch(e.target.value)}/>}
      {matches.slice(0, 30).map(({ m, index }) => <div className="flex min-w-0 items-center gap-2.5 border-b border-line pb-2.5" key={m.id}><strong title={m.id} className="min-w-0 flex-1 text-caption font-normal [overflow-wrap:anywhere]">{m.id}</strong><div className="flex flex-none flex-wrap items-center gap-2">{roles.filter(role => value.roles.includes(role)).map(role => <label key={role} className="flex items-center gap-1.5 text-caption text-ink"><Checkbox aria-label={`${m.id} ${role.toUpperCase()}`} checked={m.roles.includes(role)} disabled={locked} onCheckedChange={checked => patch({ models: value.models.map((item, i) => i === index ? { ...item, roles: checked ? [...item.roles, role] : item.roles.filter(r => r !== role) } : item) })}/>{role.toUpperCase()}</label>)}</div><Button type="button" variant="ghost" size="icon" aria-label={`${m.id} 목록에서 제외`} disabled={locked} onClick={() => patch({ models: value.models.filter((_, i) => i !== index) })}><X size={14}/></Button></div>)}
      {matches.length > 30 && <p className="m-0 text-caption text-ink-3">검색 결과 {matches.length}개 중 30개 표시</p>}
      <div className="flex items-center gap-2">
        <Input aria-label="추가할 모델 ID" placeholder="모델 ID" value={newModel} maxLength={300} disabled={locked} className="min-w-0 flex-1" onChange={e => setNewModel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/>
        <Button className="flex-none" variant="outline" type="button" disabled={locked || !newModel.trim() || !value.roles.length} onClick={add}><Plus size={14}/>추가</Button>
      </div>
      {!value.models.length && <p className="m-0 text-caption text-ink-3">서버를 등록한 다음 ‘목록 확인’으로 모델을 불러올 수도 있습니다.</p>}
    </div></section>
    {error && <InlineError>{error}</InlineError>}
    {saveBlocked && <p className="m-0 text-caption text-ink-3" role="status">{saveBlocked}</p>}
    <div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={locked} onClick={onClose}>취소</Button><Button type="submit" disabled={locked || Boolean(saveBlocked)}>{saving ? '저장 중…' : '설정 저장'}</Button></div>
  </form></Modal>;
}
