import { useState } from 'react';
import { Check } from 'lucide-react';
import { Badge, Button, FormField, InlineError, Input, SegmentedControl, SelectField, Switch, Textarea } from '@garden/ui';
import type { Ghost, GhostState } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { toneFor } from './ghostState';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { useAvatarSource } from '../pets/AvatarProvider';
import { GhostColorPicker } from '../pets/GhostColorPicker';
import { PetSprite } from '../pets/PetSprite';
import { spriteVersionOf } from '../pets/sprites';
import { NO_MODEL, modelFromKey, modelSelectOptions } from '../pets/ModelPicker';

const boldColors = [
  { name: '빨강', color: '#e92b37' }, { name: '주황', color: '#ff7a18' }, { name: '노랑', color: '#ffd600' },
  { name: '초록', color: '#008a45' }, { name: '파랑', color: '#0058ef' }, { name: '보라', color: '#7135db' },
];
const neutralColors = [{ name: '검정', color: '#191919' }, { name: '흰색', color: '#ffffff' }];
const bodyColors = [...neutralColors, ...boldColors];
const backgroundColors = [
  ...boldColors,
  { name: '하늘', color: '#d7e9ff' }, { name: '민트', color: '#d5eee2' }, { name: '라일락', color: '#e8def9' },
  { name: '복숭아', color: '#fae0d5' }, { name: '모래', color: '#f1e5cb' }, { name: '슬레이트', color: '#e0e6eb' },
  ...neutralColors,
];
const stateChoices: { value: GhostState; label: string }[] = [{ value: 'active', label: '활성' }, { value: 'paused', label: '일시정지' }, { value: 'retired', label: '은퇴' }];
const sandboxLabel: Record<string, string> = { none: '샌드박스 없음', stopped: '정지됨', running: '실행 중', error: '오류' };

/**
 * 한 Ghost의 이름·역할 지시·모델·모습·상태를 한 데서 고치는 편집기.
 * 각 변경은 곧바로 ghost.update · ghost.set_default · sandbox.control로 저장된다.
 */
export function GhostDesignEditor({ ghostId }: { ghostId: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghost = state?.ghosts.find(item => item.id === ghostId);
  const avatars = state?.avatars ?? [];
  const sandbox = state?.sandboxes.find(item => item.ghostId === ghostId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [personaDraft, setPersonaDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const locked = busy || !state;
  if (!ghost) return <p className="m-0 text-caption text-ink-3">Ghost를 찾을 수 없습니다.</p>;
  const name = nameDraft ?? ghost.name;
  const persona = personaDraft ?? ghost.persona;
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };
  const patchLook = (look: Partial<Ghost['look']>) => client.send({ type: 'ghost.update', ghostId, look: { ...ghost.look, ...look } });
  const assign = (avatarId: string | null) => void run(() => patchLook({ avatarId }), '아바타를 바꿨습니다.');
  const bodyColor = ghost.look.body || 'auto';
  const backgroundColor = ghost.look.background || 'auto';
  return <div className="grid gap-4">
    <form className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      const next = name.trim();
      if (next && next !== ghost.name) void run(() => client.send({ type: 'ghost.update', ghostId, name: next }), '이름을 바꿨습니다.');
    }}>
      <label className="grid gap-2 text-caption text-ink-2">이름
        <div className="flex gap-2">
          <Input value={name} onChange={event => setNameDraft(event.target.value)} maxLength={128} required disabled={locked} className="min-w-0 flex-1"/>
          {name.trim() !== ghost.name && <Button type="submit" size="sm" disabled={locked || !name.trim()}>저장</Button>}
        </div>
      </label>
    </form>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="flex items-center justify-between gap-3 text-caption text-ink-2">메인 Ghost
        <Switch checked={ghost.isDefault} disabled={locked || ghost.isDefault} onCheckedChange={checked => {
          if (checked) void run(() => client.send({ type: 'ghost.set_default', ghostId }), `${ghost.name}을(를) 메인 Ghost로 지정했습니다.`);
        }}/>
      </label>
      <SegmentedControl aria-label="Ghost 상태" value={ghost.state} onValueChange={value => void run(() => client.send({ type: 'ghost.update', ghostId, state: value as GhostState }), '상태를 바꿨습니다.')}
        options={stateChoices.map(({ value, label }) => ({ value, label }))}/>
    </div>
    <FormField label="모델" description="기본 모델을 따르거나 이 Ghost만의 모델을 씁니다.">
      {control => <SelectField {...control} label="모델" value={ghost.model ? `${ghost.model.provider}/${ghost.model.model}` : NO_MODEL} disabled={locked}
        onValueChange={key => void run(() => client.send({ type: 'ghost.update', ghostId, model: modelFromKey(state?.settings, key) ?? null }), '모델을 저장했습니다.')}
        options={[{ value: NO_MODEL, label: '기본 모델 따름' }, ...modelSelectOptions(state?.settings)]}/>}
    </FormField>
    <fieldset className="m-0 grid gap-2"><legend className="mb-2 text-caption text-ink-2">아바타</legend>
      <div className="grid grid-cols-5 gap-1.5">
        <button type="button" aria-pressed={!ghost.look.avatarId} disabled={locked} onClick={() => ghost.look.avatarId && assign(null)} title="기본 Ghost"
          className="relative grid aspect-square cursor-pointer place-items-center rounded-control border border-line outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed aria-pressed:border-ink aria-pressed:bg-hover">
          <DotAvatar tone={toneFor(ghost.id)} size={36}/><span className="sr-only">기본 Ghost</span>
          {!ghost.look.avatarId && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
        </button>
        {avatars.map(avatar => <AvatarTile key={avatar.id} avatar={avatar} selected={ghost.look.avatarId === avatar.id} disabled={locked}
          onSelect={() => ghost.look.avatarId !== avatar.id && assign(avatar.id)}/>)}
      </div>
    </fieldset>
    {!ghost.look.avatarId && <GhostColorPicker label="본체 색" resetLabel="자동" presets={bodyColors} value={bodyColor}
      onChange={color => void run(() => patchLook({ body: color === 'auto' ? '' : color }), '본체 색을 저장했습니다.')}/>}
    <GhostColorPicker label="배경색" resetLabel="기본" presets={backgroundColors} value={backgroundColor}
      onChange={color => void run(() => patchLook({ background: color === 'auto' ? '' : color }), '배경색을 저장했습니다.')}/>
    <form className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      if (persona.trim() && persona !== ghost.persona) void run(() => client.send({ type: 'ghost.update', ghostId, persona }), `$역할 지시를 저장했습니다.`);
    }}>
      <label className="grid gap-2 text-caption text-ink-2">역할 지시
        <Textarea value={persona} onChange={event => setPersonaDraft(event.target.value)} rows={4} maxLength={8192} required disabled={locked}/>
      </label>
      {persona !== ghost.persona && <Button type="submit" size="sm" className="justify-self-end" disabled={locked || !persona.trim()}>저장</Button>}
    </form>
    {sandbox && <section className="grid gap-2 border-t border-line pt-3" aria-label="샌드박스">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-caption text-ink-2">샌드박스 <Badge variant="outline">{sandboxLabel[sandbox.state] ?? sandbox.state}</Badge></span>
        <span className="flex items-center gap-2">
          {sandbox.state === 'running' && <Button variant="ghost" size="sm" type="button" disabled={locked} onClick={() => void run(() => client.send({ type: 'sandbox.control', ghostId, action: 'stop' }), '샌드박스를 정지했습니다.')}>정지</Button>}
          {sandbox.state !== 'none' && <Button variant="ghost" size="sm" type="button" disabled={locked} onClick={() => setResetting(true)}>초기화</Button>}
        </span>
      </div>
      {sandbox.detail && <p className="m-0 text-caption text-ink-3 [overflow-wrap:anywhere]">{sandbox.detail}</p>}
    </section>}
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {error && <InlineError>{error}</InlineError>}
    {resetting && <Modal title="샌드박스 초기화" onClose={() => !busy && setResetting(false)}>
      <p className="m-0">{ghost.name}의 샌드박스 컴퓨터를 지우고 새로 만듭니다. 샌드박스 안의 파일은 남지 않습니다.</p>
      {error && <div className="mt-3"><InlineError>{error}</InlineError></div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={busy} onClick={() => setResetting(false)}>취소</Button>
        <Button variant="destructive" type="button" disabled={busy} onClick={() => void run(async () => { await client.send({ type: 'sandbox.control', ghostId, action: 'reset' }); setResetting(false); }, '샌드박스를 초기화했습니다.')}>초기화</Button>
      </div>
    </Modal>}
  </div>;
}

function AvatarTile({ avatar, selected, disabled, onSelect }: { avatar: GhostAndAvatar; selected: boolean; disabled: boolean; onSelect(): void }) {
  const { source, animate } = useAvatarSource(avatar.imageDigest);
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onSelect} title={avatar.name}
    className="relative grid aspect-square cursor-pointer place-items-center rounded-control border border-line outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed aria-pressed:border-ink aria-pressed:bg-hover">
    {source ? <PetSprite source={source} version={spriteVersionOf(avatar.design)} size={44} animate={animate}/> : <span className="size-10 rounded-md bg-inset"/>}
    <span className="sr-only">{avatar.name}</span>
    {selected && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
  </button>;
}
type GhostAndAvatar = { id: string; name: string; imageDigest: string; design: unknown };
