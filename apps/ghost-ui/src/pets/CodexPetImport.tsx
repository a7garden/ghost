import { useRef, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { Badge, Button, InlineError } from '../ui'
import { Modal } from '../components/Modal';
import { PetSprite } from './PetSprite';
import { spriteVersionOf } from './sprites';
import type { AvatarInput } from './PetEditor';
import { importCodexPet } from './codexImport';

export function CodexPetImport({ animate, busy, onClose, onSave }: { animate: boolean; busy: boolean; onClose: () => void; onSave: (input: AvatarInput) => Promise<void> }) {
  const picker = useRef<HTMLInputElement>(null);
  const [pet, setPet] = useState<AvatarInput>(), [error, setError] = useState(''), [reading, setReading] = useState(false), [saving, setSaving] = useState(false);
  const locked = busy || reading || saving;
  return <Modal title="Codex 펫 가져오기" onClose={() => !locked && onClose()} className="w-[min(600px,calc(100vw-2rem))] sm:max-w-[600px]">
    {pet ? <div className="grid grid-cols-[170px_minmax(0,1fr)] items-center gap-6 py-5 max-[480px]:grid-cols-1 max-[480px]:justify-items-center max-[480px]:gap-2.5">
        <PetSprite source={pet.image} version={spriteVersionOf(pet.design)} size={160} animate={animate} follow/>
        <div className="min-w-0 max-[480px]:w-full">
          <h3 className="m-0 mb-2.5 text-body font-semibold text-ink">{pet.name}</h3>
          {pet.description && <p className="m-0 mb-3 text-ui leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{pet.description}</p>}
          <Badge variant="outline">Codex 펫 v{spriteVersionOf(pet.design)}</Badge>
        </div>
      </div> : <button type="button" onClick={() => picker.current?.click()} disabled={locked}
        className="mb-4 flex min-h-[210px] w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong bg-inset p-6 text-ink outline-none hover:bg-hover focus-visible:ring-[2px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50">
        <FolderOpen size={28}/><strong className="text-body font-semibold">{reading ? '펫 읽는 중…' : '펫 폴더 선택'}</strong>
        <span className="text-caption whitespace-normal text-ink-3">pet.json과 스프라이트 파일이 있는 폴더</span>
      </button>}
    <p className="m-0 text-caption text-ink-3">Codex 펫 폴더의 이름·설명·동작을 그대로 가져옵니다. PNG·WebP, 최대 4 MiB.</p>
    {error && <InlineError className="mt-3">{error}</InlineError>}
    <input hidden type="file" multiple aria-label="Codex 펫 폴더" tabIndex={-1} ref={el => { picker.current = el; el?.setAttribute('webkitdirectory', ''); }} disabled={locked} onChange={e => {
      const files = Array.from(e.target.files ?? []); e.target.value = ''; if (!files.length) return;
      setReading(true); setPet(undefined); setError('');
      void importCodexPet(files).then(setPet).catch(e => setError(e instanceof Error ? e.message : '펫을 읽지 못했습니다.')).finally(() => setReading(false));
    }}/>
    <footer className="mt-6 flex flex-wrap justify-between gap-3 border-t border-line pt-4">
      {pet ? <Button variant="outline" type="button" disabled={locked} onClick={() => picker.current?.click()}><RefreshCw size={15}/>다른 폴더</Button> : <span/>}
      <Button type="button" disabled={!pet || locked} onClick={() => {
        if (!pet || locked) return; setSaving(true); setError('');
        void onSave(pet).catch(e => setError(e instanceof Error ? e.message : '저장하지 못했습니다.')).finally(() => setSaving(false));
      }}>{saving ? '저장 중…' : '보관함에 가져오기'}</Button>
    </footer>
  </Modal>;
}
