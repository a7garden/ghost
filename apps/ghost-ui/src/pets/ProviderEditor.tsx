import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { ModelProvider, ModelRole } from '../client/types';
import { Modal } from '../components/Modal';

const roles: ModelRole[] = ['llm', 'stt', 'tts'];
export function ProviderEditor({ initial, version, existing, busy, onClose, onSave }: { initial: ModelProvider; version: number; existing: boolean; busy: boolean; onClose: () => void; onSave: (provider: ModelProvider, version: number) => Promise<void> }) {
  const [value, setValue] = useState(initial), [search, setSearch] = useState(''), [newModel, setNewModel] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const patch = (p: Partial<ModelProvider>) => setValue(v => ({ ...v, ...p }));
  const toggleRole = (role: ModelRole, checked: boolean) => patch({ roles: checked ? [...value.roles, role] : value.roles.filter(r => r !== role), models: checked ? value.models : value.models.map(m => ({ ...m, roles: m.roles.filter(r => r !== role) })) });
  const matches = value.models.map((m, index) => ({ m, index })).filter(({ m }) => `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase()));
  const add = () => {
    const id = newModel.trim(); if (!id) return;
    if (value.models.some(m => m.id === id)) { setError('이미 등록된 모델 ID입니다.'); return; }
    patch({ models: [...value.models, { id, name: id, roles: [value.roles[0] ?? 'llm'] }] }); setNewModel(''); setSearch(id); setError('');
  };
  return <Modal title={existing ? `${initial.name} 편집` : '제공자 등록'} onClose={() => !locked && onClose()} className="provider-editor-modal"><form className="form-stack" onSubmit={e => {
    e.preventDefault(); if (locked) return;
    if (!value.roles.length || value.models.some(m => !m.roles.length)) { setError('제공자와 각 모델의 역할을 선택해 주세요.'); return; }
    if (value.models.length > 2000) { setError('모델은 최대 2,000개까지 등록할 수 있습니다.'); return; }
    setSaving(true); setError(''); void onSave(value, version).catch(e => setError(e instanceof Error ? e.message : '저장하지 못했습니다.')).finally(() => setSaving(false));
  }}>
    <div className="form-pair"><label>이름<input value={value.name} maxLength={80} required disabled={locked} onChange={e => patch({ name: e.target.value })}/></label><label>제공자 ID<input value={value.id} maxLength={80} pattern="[A-Za-z0-9_-]+" required disabled={locked || existing || value.kind === 'builtin'} onChange={e => patch({ id: e.target.value })}/></label></div>
    <label>서버 주소<input type="url" value={value.endpoint} placeholder="http://127.0.0.1:11434/v1" required disabled={locked || value.auth.type === 'sdk'} onChange={e => patch({ endpoint: e.target.value })}/></label>
    <label>인증<select value={value.auth.type} disabled={locked} onChange={e => patch({ auth: e.target.value === 'env' ? { type: 'env', variable: '' } : { type: e.target.value as 'none' | 'sdk' } })}><option value="none">없음</option>{value.kind === 'builtin' && <option value="sdk">저장된 제공자 인증</option>}<option value="env">환경 변수</option></select></label>
    {value.auth.type === 'env' && <label>환경 변수 이름<input value={value.auth.variable ?? ''} placeholder="LOCAL_MODEL_API_KEY" pattern="[A-Z0-9_]+" maxLength={100} required disabled={locked} onChange={e => patch({ auth: { type: 'env', variable: e.target.value } })}/><span className="field-help">호스트에 설정된 변수 이름만 입력합니다. 키 값은 저장하지 않습니다.</span></label>}
    {value.auth.type === 'sdk' && <p className="field-help">해당 제공자에 이미 저장된 인증을 사용합니다.</p>}
    <fieldset className="pet-fieldset"><legend>서버에서 사용할 역할</legend><div className="model-role-checks">{roles.map(role => <label key={role}><input type="checkbox" checked={value.roles.includes(role)} disabled={locked} onChange={e => toggleRole(role, e.target.checked)}/>{role.toUpperCase()}</label>)}</div></fieldset>
    <label className="provider-enabled"><input type="checkbox" checked={value.enabled} disabled={locked} onChange={e => patch({ enabled: e.target.checked })}/>제공자 사용</label>
    <details className="provider-model-editor" open={value.models.length < 10}><summary>등록할 모델 · {value.models.length}개</summary><div className="form-stack">
      {value.models.length > 10 && <input aria-label="등록할 모델 검색" placeholder="모델 ID 검색" value={search} onChange={e => setSearch(e.target.value)}/>}
      {matches.slice(0, 30).map(({ m, index }) => <div className="provider-model-row" key={m.id}><strong title={m.id}>{m.id}</strong><div className="model-role-checks">{roles.filter(role => value.roles.includes(role)).map(role => <label key={role}><input type="checkbox" aria-label={`${m.id} ${role.toUpperCase()}`} checked={m.roles.includes(role)} disabled={locked} onChange={e => patch({ models: value.models.map((item, i) => i === index ? { ...item, roles: e.target.checked ? [...item.roles, role] : item.roles.filter(r => r !== role) } : item) })}/>{role.toUpperCase()}</label>)}</div><button type="button" className="icon-button" aria-label={`${m.id} 목록에서 제외`} disabled={locked} onClick={() => patch({ models: value.models.filter((_, i) => i !== index) })}><X size={14}/></button></div>)}
      {matches.length > 30 && <p className="field-help">검색 결과 {matches.length}개 중 30개 표시</p>}
      <div className="provider-model-add"><input aria-label="추가할 모델 ID" placeholder="모델 ID" value={newModel} maxLength={300} disabled={locked} onChange={e => setNewModel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/><button className="button secondary" type="button" disabled={locked || !newModel.trim() || !value.roles.length} onClick={add}><Plus size={14}/>추가</button></div>
      {!value.models.length && <p className="field-help">서버를 등록한 다음 ‘목록 확인’으로 모델을 불러올 수도 있습니다.</p>}
    </div></details>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="button secondary" disabled={locked} onClick={onClose}>취소</button><button className="button primary" disabled={locked}>{saving ? '저장 중…' : '설정 저장'}</button></div>
  </form></Modal>;
}
