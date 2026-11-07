import { useMemo, useState } from 'react';
import { Download, Upload, WandSparkles } from 'lucide-react';
import { Button, FormField, InlineError, Input, SegmentedControl, SelectField } from '@garden/ui';
import { Modal } from '../components/Modal';
import { PetSprite } from './PetSprite';
import { COLORS, DEFAULT_DESIGN, STATES, codexDesign, createSpriteSheet, importSprite, isDesign, ownDesign } from './sprites';
import type { PetDesign, PetState, SpriteVersion } from './sprites';
import { downloadPet } from './archive';

/** What `avatar.create` stores: a PNG/WebP data URL plus the UI's sprite design. */
export interface AvatarInput {
  name: string;
  description: string;
  /** `data:image/png|webp;base64,…` */
  image: string;
  /** UI-owned sprite design; `null` for pets without one. */
  design: Record<string, unknown> | null;
}

export function PetEditor({ name: initialName, seed, animate, busy, onClose, onSave }: {
  name: string;
  /** An avatar to copy and change. */
  seed?: { name: string; description: string; imageDigest: string; design: unknown };
  animate: boolean; busy: boolean;
  onClose(): void;
  onSave(input: AvatarInput): Promise<void>;
}) {
  const [design, setDesign] = useState<PetDesign>(isDesign(seed?.design) ? seed.design : DEFAULT_DESIGN);
  const [name, setName] = useState(seed ? `${seed.name} 복사` : initialName), [description, setDescription] = useState(seed?.description ?? '');
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [imported, setImported] = useState<{ image: string; spriteVersion: SpriteVersion }>();
  const [error, setError] = useState(''), [reading, setReading] = useState(false), [state, setState] = useState<PetState>('idle');
  const generated = useMemo(() => { try { return { source: createSpriteSheet(design), error: '' }; } catch { return { source: '', error: '이 브라우저에서 아바타를 그릴 수 없습니다.' }; } }, [design]);
  const source = mode === 'create' ? generated.source : imported?.image;
  const version = mode === 'create' ? 2 : imported?.spriteVersion ?? 2;
  const patch = (value: Partial<PetDesign>) => setDesign(d => ({ ...d, ...value }));
  const locked = busy || reading;
  return <Modal title={seed ? '아바타를 복사해서 만들기' : '아바타 만들기'} onClose={() => !locked && onClose()} className="w-[min(760px,calc(100vw-2rem))] sm:max-w-[760px]">
    <form onSubmit={e => { e.preventDefault(); if (!source || locked) return; setError(''); void onSave({ name: name.trim(), description: description.trim(), image: source, design: mode === 'create' ? ownDesign(design) : codexDesign(imported!.spriteVersion) }).catch(e => setError(e.message)); }}>
      <div className="grid grid-cols-[minmax(0,.9fr)_minmax(0,1fr)] gap-7 max-[760px]:grid-cols-1 max-[760px]:gap-5">
        <div className="flex min-w-0 flex-col items-center justify-center gap-2 rounded-xl bg-inset px-3 py-4 max-[760px]:p-2 max-[760px]:[&_.pet-sprite]:scale-[.65]">
          <div className="flex min-h-[230px] items-center justify-center text-ink-3 max-[760px]:h-[130px] max-[760px]:min-h-[120px] max-[760px]:max-w-full">
            {source ? <PetSprite source={source} version={version} size={192} state={state} animate={animate} follow/> : <Upload size={36}/>}
          </div>
          <strong className="max-w-full text-body text-ink [overflow-wrap:anywhere]">{name || '새 Ghost'}</strong>
          <span className="text-caption text-ink-3">{version === 2 ? '커서를 움직이면 시선이 따라가요.' : 'Codex 펫 v1'}</span>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-caption text-ink-2 max-[760px]:mt-1">
            <span>동작 미리보기</span>
            <SelectField className="w-auto max-w-[160px]" label="동작 미리보기" value={state} disabled={locked} onValueChange={value => setState(value as PetState)}
              options={STATES.map(s => ({ value: s.key, label: s.label }))}/>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SegmentedControl aria-label="아바타 제작 방식" value={mode} onValueChange={value => { setMode(value as 'create' | 'import'); setError(''); }}
            options={[{ value: 'create', label: <span className="flex items-center gap-1.5"><WandSparkles size={15}/>직접 만들기</span>, disabled: locked },
              { value: 'import', label: <span className="flex items-center gap-1.5"><Upload size={15}/>가져오기</span>, disabled: locked }]}/>
          <FormField label="아바타 이름">{control => <Input {...control} value={name} onChange={e => setName(e.target.value)} required maxLength={128} disabled={locked}/>}</FormField>
          {mode === 'create' ? <>
            <fieldset className="m-0 min-w-0"><legend className="mb-2.5 text-caption text-ink-2">색</legend>
              <div className="flex flex-wrap gap-2.5">{COLORS.map(color => <button type="button" key={color.value} aria-label={color.name} aria-pressed={design.color === color.value}
                className="size-7 cursor-pointer rounded-full outline-2 outline-offset-[3px] outline-transparent aria-pressed:outline-ink disabled:pointer-events-none disabled:opacity-50"
                style={{ background: color.value }} onClick={() => patch({ color: color.value })} disabled={locked}/>)}</div></fieldset>
            <FormField label="형태">{control => <SelectField {...control} label="형태" value={design.shape} disabled={locked} onValueChange={value => patch({ shape: value as PetDesign['shape'] })}
              options={[{ value: 'ghost', label: '고스트' }, { value: 'cloud', label: '구름' }, { value: 'round', label: '동그라미' }]}/>}</FormField>
            <div className="grid gap-4 max-[480px]:grid-cols-1 sm:grid-cols-2">
              <FormField label="표정">{control => <SelectField {...control} label="표정" value={design.eyes} disabled={locked} onValueChange={value => patch({ eyes: value as PetDesign['eyes'] })}
                options={[{ value: 'classic', label: '초롱초롱' }, { value: 'happy', label: '웃는 눈' }, { value: 'sleepy', label: '졸린 눈' }]}/>}</FormField>
              <FormField label="장식">{control => <SelectField {...control} label="장식" value={design.accessory} disabled={locked} onValueChange={value => patch({ accessory: value as PetDesign['accessory'] })}
                options={[{ value: 'none', label: '없음' }, { value: 'sprout', label: '새싹' }, { value: 'halo', label: '헤일로' }, { value: 'glasses', label: '안경' }]}/>}</FormField>
            </div>
          </> : <>
            <FormField label="펫 스프라이트" description="투명 PNG·WebP, 최대 4 MiB. 1536 × 1872(v1) 또는 1536 × 2288(v2). Codex 펫 폴더의 spritesheet 파일을 선택하세요.">
              {control => <Input {...control} type="file" accept="image/png,image/webp" disabled={locked} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setReading(true); setError(''); setImported(undefined); void importSprite(file).then(setImported).catch(e => setError(e.message)).finally(() => setReading(false)); }}/>}
            </FormField>
            {imported && <span className="text-caption leading-relaxed text-success">v{imported.spriteVersion} · 모든 동작과 투명 배경 확인됨</span>}
          </>}
          <FormField label="설명 (선택)">{control => <Input {...control} value={description} onChange={e => setDescription(e.target.value)} maxLength={2048} disabled={locked}/>}</FormField>
        </div>
      </div>
      {(error || generated.error) && <InlineError className="mt-4">{error || generated.error}</InlineError>}
      <footer className="mt-6 flex flex-wrap justify-between gap-3 border-t border-line pt-4">
        <Button variant="outline" type="button" disabled={!source || !name.trim() || locked} onClick={() => { if (source) { try { downloadPet(name.trim(), description, version, source); } catch (e) { setError(String(e)); } } }}><Download size={15}/>Codex용 내보내기</Button>
        <Button type="submit" disabled={!source || !name.trim() || locked}>{reading ? '파일 확인 중…' : busy ? '저장 중…' : '저장'}</Button>
      </footer>
    </form>
  </Modal>;
}
