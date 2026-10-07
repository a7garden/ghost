import { useMemo, useState } from 'react';
import { Download, Upload, WandSparkles } from 'lucide-react';
import { Modal } from '../components/Modal';
import { PetSprite } from './PetSprite';
import { COLORS, DEFAULT_DESIGN, STATES, createSpriteSheet, importSprite, isDesign } from './sprites';
import type { PetDesign, PetState, SpriteVersion } from './sprites';
import { downloadPet } from './archive';
import type { Avatar } from '../client/types';
export interface AvatarInput { name: string; description: string; sprite_version: SpriteVersion; data_url: string; design: PetDesign | null; source_manifest?: Record<string, unknown> | null; }
export function PetEditor({ name: initialName, seed, animate, busy, onClose, onSave }: { name: string; seed?: Avatar; animate: boolean; busy: boolean; onClose: () => void; onSave: (input: AvatarInput) => Promise<void> }) {
  const [design, setDesign] = useState<PetDesign>(isDesign(seed?.design) ? seed.design : DEFAULT_DESIGN);
  const [name, setName] = useState(seed ? `${seed.name} 복사` : initialName), [description, setDescription] = useState(seed?.description ?? '');
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [imported, setImported] = useState<{ data_url: string; sprite_version: SpriteVersion }>();
  const [error, setError] = useState(''), [reading, setReading] = useState(false), [state, setState] = useState<PetState>('idle');
  const generated = useMemo(() => { try { return { source: createSpriteSheet(design), error: '' }; } catch { return { source: '', error: '이 브라우저에서 아바타를 그릴 수 없습니다.' }; } }, [design]);
  const source = mode === 'create' ? generated.source : imported?.data_url;
  const version = mode === 'create' ? 2 : imported?.sprite_version ?? 2;
  const patch = (value: Partial<PetDesign>) => setDesign(d => ({ ...d, ...value }));
  const locked = busy || reading;
  return <Modal title={seed ? '아바타를 복사해서 만들기' : '아바타 만들기'} onClose={() => !locked && onClose()} className="pet-editor-modal">
    <form onSubmit={e => { e.preventDefault(); if (!source || locked) return; setError(''); void onSave({ name: name.trim(), description: description.trim(), sprite_version: version, data_url: source, design: mode === 'create' ? design : null }).catch(e => setError(e.message)); }}>
      <div className="pet-editor-grid">
        <div className="pet-editor-preview"><div className="pet-preview-stage">{source ? <PetSprite source={source} version={version} size={192} state={state} animate={animate} follow/> : <Upload size={36}/>}</div><strong>{name || '새 Ghost'}</strong><span className="field-help">{version === 2 ? '커서를 움직이면 시선이 따라가요.' : 'Codex 펫 v1'}</span><label className="pet-motion-picker">동작 미리보기<select value={state} onChange={e => setState(e.target.value as PetState)}>{STATES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label></div>
        <div className="pet-editor-controls form-stack"><div className="pet-mode-tabs" aria-label="아바타 제작 방식"><button type="button" aria-pressed={mode === 'create'} onClick={() => { setMode('create'); setError(''); }} disabled={locked}><WandSparkles size={15}/>직접 만들기</button><button type="button" aria-pressed={mode === 'import'} onClick={() => { setMode('import'); setError(''); }} disabled={locked}><Upload size={15}/>가져오기</button></div>
          <label>아바타 이름<input value={name} onChange={e => setName(e.target.value)} required maxLength={80} disabled={locked}/></label>
          {mode === 'create' ? <>
            <fieldset className="pet-fieldset"><legend>색</legend><div className="pet-swatches">{COLORS.map(color => <button type="button" key={color.value} aria-label={color.name} aria-pressed={design.color === color.value} style={{ background: color.value }} onClick={() => patch({ color: color.value })} disabled={locked}/>)}</div></fieldset>
            <label>형태<select value={design.shape} onChange={e => patch({ shape: e.target.value as PetDesign['shape'] })} disabled={locked}><option value="ghost">고스트</option><option value="cloud">구름</option><option value="round">동그라미</option></select></label>
            <div className="form-pair"><label>표정<select value={design.eyes} onChange={e => patch({ eyes: e.target.value as PetDesign['eyes'] })} disabled={locked}><option value="classic">초롱초롱</option><option value="happy">웃는 눈</option><option value="sleepy">졸린 눈</option></select></label><label>장식<select value={design.accessory} onChange={e => patch({ accessory: e.target.value as PetDesign['accessory'] })} disabled={locked}><option value="none">없음</option><option value="sprout">새싹</option><option value="halo">헤일로</option><option value="glasses">안경</option></select></label></div>
          </> : <label className="pet-file-input">펫 스프라이트<input type="file" accept="image/png,image/webp" disabled={locked} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setReading(true); setError(''); setImported(undefined); void importSprite(file).then(setImported).catch(e => setError(e.message)).finally(() => setReading(false)); }}/><span className="field-help">투명 PNG·WebP, 최대 4 MiB.<br/>1536 × 1872(v1) 또는 1536 × 2288(v2). Codex 펫 폴더의 spritesheet 파일을 선택하세요.</span>{imported && <span className="pet-valid">v{imported.sprite_version} · 모든 동작과 투명 배경 확인됨</span>}</label>}
          <label>설명 <span className="muted">선택</span><input value={description} onChange={e => setDescription(e.target.value)} maxLength={500} disabled={locked}/></label>
        </div>
      </div>
      {(error || generated.error) && <p className="form-error pet-editor-error" role="alert">{error || generated.error}</p>}
      <footer className="pet-editor-footer"><button className="button secondary" type="button" disabled={!source || !name.trim() || locked} onClick={() => { if (source) { try { downloadPet(name.trim(), description, version, source); } catch (e) { setError(String(e)); } } }}><Download size={15}/>Codex용 내보내기</button><button className="button primary" disabled={!source || !name.trim() || locked}>{reading ? '파일 확인 중…' : busy ? '저장 중…' : '저장하고 적용'}</button></footer>
    </form>
  </Modal>;
}
