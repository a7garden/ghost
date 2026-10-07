import { useRef, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { Modal } from '../components/Modal';
import { PetSprite } from './PetSprite';
import type { AvatarInput } from './PetEditor';
import { importCodexPet } from './codexImport';

export function CodexPetImport({ animate, busy, onClose, onSave }: { animate: boolean; busy: boolean; onClose: () => void; onSave: (input: AvatarInput) => Promise<void> }) {
  const picker = useRef<HTMLInputElement>(null);
  const [pet, setPet] = useState<AvatarInput>(), [error, setError] = useState(''), [reading, setReading] = useState(false), [saving, setSaving] = useState(false);
  const locked = busy || reading || saving;
  return <Modal title="Codex 펫 가져오기" onClose={() => !locked && onClose()} className="pet-import-modal">
    {pet ? <div className="imported-pet-preview"><PetSprite source={pet.data_url} version={pet.sprite_version} size={160} animate={animate} follow/><div><h3>{pet.name}</h3>{pet.description && <p>{pet.description}</p>}<span className="mode-badge">Codex 펫 v{pet.sprite_version}</span><p className="field-help">{String(pet.source_manifest?.spritesheetPath)}</p></div></div> : <button data-autofocus className="pet-import-target" onClick={() => picker.current?.click()} disabled={locked}><FolderOpen size={28}/><strong>{reading ? '펫 읽는 중…' : '펫 폴더 선택'}</strong><span>pet.json과 스프라이트 파일이 있는 폴더</span></button>}
    <p className="field-help">Codex 펫 폴더의 이름·설명·동작을 그대로 가져옵니다. PNG·WebP, 최대 4 MiB.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <input hidden type="file" multiple aria-label="Codex 펫 폴더" tabIndex={-1} ref={el => { picker.current = el; el?.setAttribute('webkitdirectory', ''); }} disabled={locked} onChange={e => {
      const files = Array.from(e.target.files ?? []); e.target.value = ''; if (!files.length) return;
      setReading(true); setPet(undefined); setError('');
      void importCodexPet(files).then(setPet).catch(e => setError(e instanceof Error ? e.message : '펫을 읽지 못했습니다.')).finally(() => setReading(false));
    }}/>
    <footer className="pet-editor-footer">{pet ? <button className="button secondary" disabled={locked} onClick={() => picker.current?.click()}><RefreshCw size={15}/>다른 폴더</button> : <span/>}<button className="button primary" disabled={!pet || locked} onClick={() => {
      if (!pet || locked) return; setSaving(true); setError('');
      void onSave(pet).catch(e => setError(e instanceof Error ? e.message : '저장하지 못했습니다.')).finally(() => setSaving(false));
    }}>{saving ? '저장 중…' : '가져와서 적용'}</button></footer>
  </Modal>;
}
