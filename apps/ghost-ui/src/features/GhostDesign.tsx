import { useState } from 'react';
import { Check } from 'lucide-react';
import { Badge, Button, InlineError, Input, SegmentedControl, SelectField, SettingsGroup, SettingsRow, Switch } from '../ui'
import type { Ghost, GhostState } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { GhostCharacter } from '../pets/GhostCharacter';
import { defaultBodyColor } from '../pets/appearance';
import { Modal } from '../components/Modal';
import { useAvatarSource } from '../pets/AvatarProvider';
import { GhostColorPicker } from '../pets/GhostColorPicker';
import { LookEditor } from '../pets/LookEditor';
import { PetSprite } from '../pets/PetSprite';
import { spriteVersionOf } from '../pets/sprites';
import { NO_MODEL, modelFromKey, modelSelectOptions } from '../pets/ModelPicker';

const backgroundColors = [
  { name: '하늘', color: '#dbeaff' }, { name: '민트', color: '#d7f0e4' }, { name: '라일락', color: '#e9e1fa' },
  { name: '복숭아', color: '#fbe3d6' }, { name: '모래', color: '#f3e8cf' }, { name: '안개', color: '#eef0f3' },
  { name: '먹', color: '#202125' }, { name: '흰색', color: '#ffffff' },
];
const stateChoices: { value: GhostState; label: string }[] = [{ value: 'active', label: '활성' }, { value: 'paused', label: '일시정지' }, { value: 'retired', label: '은퇴' }];

/**
 * 한 Ghost의 이름·모델·모습·상태·샌드박스를 고치는 꾸미기 편집기.
 * 역할 지시·도구 권한은 GhostAgentSettingsEditor가 맡는다.
 * 각 변경은 곧바로 ghost.update · ghost.set_default · sandbox.control로 저장된다.
 */
export function GhostDesignEditor({ ghostId }: { ghostId: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghost = state?.ghosts.find(item => item.id === ghostId);
  const avatars = state?.avatars ?? [];
  const sandbox = state?.sandboxes.find(item => item.ghostId === ghostId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const locked = busy || !state;
  if (!ghost) return <p className="m-0 text-caption text-ink-3">Ghost를 찾을 수 없습니다.</p>;
  const name = nameDraft ?? ghost.name;
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };
  const patchLook = (look: Partial<Ghost['look']>) => client.send({ type: 'ghost.update', ghostId, look: { ...ghost.look, ...look } });
  const assign = (avatarId: string | null) => void run(() => patchLook({ avatarId }), '아바타를 바꿨습니다.');
  const backgroundColor = ghost.look.background || 'auto';
  const saveLook = (patch: Partial<Ghost['look']>) => void run(() => patchLook(patch), '모습을 저장했습니다.');
  return <div className="grid gap-4">
    <SettingsGroup title={<span className="sr-only">기본 정보</span>}>
      <form onSubmit={event => {
        event.preventDefault();
        const next = name.trim();
        if (next && next !== ghost.name) void run(() => client.send({ type: 'ghost.update', ghostId, name: next }), '이름을 바꿨습니다.');
      }} className="ghost-settings-row">
        <div className="ghost-settings-row__copy">
          <label className="ghost-settings-row__label" htmlFor="ghost-design-name">이름</label>
        </div>
        <div className="ghost-settings-row__control">
          <div className="flex w-full min-w-0 gap-2">
            <Input id="ghost-design-name" value={name} onChange={event => setNameDraft(event.target.value)} maxLength={128} required disabled={locked} className="min-w-0 flex-1"/>
            {name.trim() !== ghost.name && <Button type="submit" size="sm" disabled={locked || !name.trim()}>저장</Button>}
          </div>
        </div>
      </form>
      <SettingsRow label="메인 Ghost">
        <Switch checked={ghost.isDefault} disabled={locked || ghost.isDefault} onCheckedChange={checked => {
          if (checked) void run(() => client.send({ type: 'ghost.set_default', ghostId }), `${ghost.name}을(를) 메인 Ghost로 지정했습니다.`);
        }}/>
      </SettingsRow>
      <SettingsRow label="상태">
        <SegmentedControl aria-label="Ghost 상태" value={ghost.state} onValueChange={value => void run(() => client.send({ type: 'ghost.update', ghostId, state: value as GhostState }), '상태를 바꿨습니다.')}
          options={stateChoices.map(({ value, label }) => ({ value, label }))}/>
      </SettingsRow>
      <SettingsRow label="모델">
        <SelectField label="모델" className="w-full max-w-[260px]" value={ghost.model ? `${ghost.model.provider}/${ghost.model.model}` : NO_MODEL} disabled={locked}
          onValueChange={key => void run(() => client.send({ type: 'ghost.update', ghostId, model: modelFromKey(state?.settings, key) ?? null }), '모델을 저장했습니다.')}
          options={[{ value: NO_MODEL, label: '기본 모델 따름' }, ...modelSelectOptions(state?.settings)]}/>
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="모습">
      <div className="grid gap-5 p-4">
        {!ghost.look.avatarId && <LookEditor ghostId={ghost.id} look={ghost.look} disabled={locked} onChange={saveLook}/>}
        {avatars.length > 0 && <fieldset className="m-0 grid gap-2 border-0 p-0"><legend className="mb-2 text-caption text-ink-3">아바타</legend>
          <div className="grid grid-cols-5 gap-1.5">
            <button type="button" aria-pressed={!ghost.look.avatarId} disabled={locked} onClick={() => ghost.look.avatarId && assign(null)} title="기본 Ghost"
              className="avatar-choice avatar-choice--tile p-2 outline-none disabled:cursor-not-allowed">
              <GhostCharacter size={36} animate={false} color={ghost.look.body} fallback={defaultBodyColor(ghost.id)} face={ghost.look.face} mark={ghost.look.mark}/><span className="sr-only">기본 Ghost</span>
              {!ghost.look.avatarId && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
            </button>
            {avatars.map(avatar => <AvatarTile key={avatar.id} avatar={avatar} selected={ghost.look.avatarId === avatar.id} disabled={locked}
              onSelect={() => ghost.look.avatarId !== avatar.id && assign(avatar.id)}/>)}
          </div>
        </fieldset>}
        {ghost.look.avatarId && <GhostColorPicker label="배경색" resetLabel="기본" presets={backgroundColors} value={backgroundColor}
          onChange={color => saveLook({ background: color === 'auto' ? '' : color })}/>}
      </div>
    </SettingsGroup>
    {sandbox && <SettingsGroup title="샌드박스">
      <SettingsRow label={<span className="flex items-center gap-2">샌드박스 <SandboxBadge state={sandbox.state}/></span>} description={sandbox.detail}>
        <span className="flex items-center gap-1">
          {sandbox.state === 'running' && <Button variant="ghost" size="sm" type="button" disabled={locked} onClick={() => void run(() => client.send({ type: 'sandbox.control', ghostId, action: 'stop' }), '샌드박스를 정지했습니다.')}>정지</Button>}
          {sandbox.state !== 'none' && <Button variant="ghost" size="sm" type="button" disabled={locked} onClick={() => setResetting(true)}>초기화</Button>}
        </span>
      </SettingsRow>
    </SettingsGroup>}
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

const sandboxBadge: Record<string, { label: string; variant: 'default' | 'outline' | 'danger' }> = {
  none: { label: '샌드박스 없음', variant: 'outline' },
  stopped: { label: '정지됨', variant: 'outline' },
  running: { label: '실행 중', variant: 'default' },
  error: { label: '오류', variant: 'danger' },
};

function SandboxBadge({ state }: { state: string }) {
  const badge = sandboxBadge[state] ?? { label: state, variant: 'outline' as const };
  return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

function AvatarTile({ avatar, selected, disabled, onSelect }: { avatar: GhostAndAvatar; selected: boolean; disabled: boolean; onSelect(): void }) {
  const { source, animate } = useAvatarSource(avatar.imageDigest);
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onSelect} title={avatar.name}
    className="avatar-choice avatar-choice--tile p-2 outline-none disabled:cursor-not-allowed">
    {source ? <PetSprite source={source} version={spriteVersionOf(avatar.design)} size={44} animate={animate}/> : <span className="size-10 rounded-md bg-inset"/>}
    <span className="sr-only">{avatar.name}</span>
    {selected && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
  </button>;
}
type GhostAndAvatar = { id: string; name: string; imageDigest: string; design: unknown };
