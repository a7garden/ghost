import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button, InlineError, Input, Switch, Textarea } from '@garden/ui';
import { DotAvatar, type PortraitAppearance } from '../components/DotAvatar';
import { useAvatarSource, useProfileAvatar } from '../pets/AvatarProvider';
import { GhostColorPicker } from '../pets/GhostColorPicker';
import { PetSprite } from '../pets/PetSprite';
import { toneFor, type Avatar, type Command, type Profile } from '../client/types';
import { portraitColors } from './PackageWorkspace';
import { uiTerms } from '../uiText';
import { ghostDisplayName } from './profileSummary';

const boldColors = [
  { name: '빨강', color: '#e92b37' }, { name: '주황', color: '#ff7a18' }, { name: '노랑', color: '#ffd600' },
  { name: '초록', color: '#008a45' }, { name: '파랑', color: '#0058ef' }, { name: '보라', color: '#7135db' },
];
const neutralColors = [{ name: '검정', color: '#191919' }, { name: '흰색', color: '#ffffff' }];
const bodyColors = [...neutralColors, ...boldColors];
const backgroundColors = [
  ...boldColors,
  { name: '하늘', color: portraitColors.sky }, { name: '민트', color: portraitColors.mint },
  { name: '라일락', color: portraitColors.lilac }, { name: '복숭아', color: portraitColors.peach },
  { name: '모래', color: portraitColors.sand }, { name: '슬레이트', color: portraitColors.slate },
  ...neutralColors,
];

export interface PortraitColorProps {
  appearance?: PortraitAppearance; choices: PortraitAppearance; defaults: Required<PortraitAppearance>;
  onSelect(part: keyof PortraitAppearance, color?: string): void;
}

/** Body colour (default Ghost only) and portrait background. */
export function PortraitColors({ profileId, appearance, choices, defaults, onSelect }: PortraitColorProps & { profileId: string }) {
  const { isDefault } = useProfileAvatar(profileId);
  return <>
    {isDefault && <GhostColorPicker label="본체 색" resetLabel="자동" presets={bodyColors} value={choices.body ?? 'auto'}
      fallback={appearance?.body ?? defaults.body} onChange={color => onSelect('body', color === 'auto' ? undefined : color)}/>}
    <GhostColorPicker label="배경색" resetLabel="기본" presets={backgroundColors} value={choices.background ?? 'auto'}
      fallback={appearance?.background ?? defaults.background} onChange={color => onSelect('background', color === 'auto' ? undefined : color)}/>
  </>;
}

function AvatarTile({ avatar, selected, disabled, onSelect }: { avatar: Avatar; selected: boolean; disabled: boolean; onSelect(): void }) {
  const { source, animate } = useAvatarSource(avatar.id);
  return <button type="button" aria-pressed={selected} disabled={disabled} onClick={onSelect} title={avatar.name}
    className="relative grid aspect-square cursor-pointer place-items-center rounded-control border border-line outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed aria-pressed:border-ink aria-pressed:bg-hover">
    {source ? <PetSprite source={source} version={avatar.sprite_version} size={44} animate={animate}/> : <span className="size-10 rounded-md bg-inset"/>}
    <span className="sr-only">{avatar.name}</span>
    {selected && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
  </button>;
}

/** The Ghost's name, look and role in one place. Each change saves directly. */
export function GhostDesignEditor({ profile, avatars, action, connected, colors, isMain }: {
  profile: Profile; avatars: Avatar[]; connected: boolean;
  action(command: Command): Promise<Record<string, any>>;
  colors: ReactNode;
  /** This Ghost is the owner's main Ghost. */
  isMain: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [persona, setPersona] = useState(profile.persona);
  const savedName = ghostDisplayName(profile);
  const [name, setName] = useState(savedName);
  const locked = busy || !connected;
  const run = async (command: Command, done: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(command); setNotice(done); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '저장하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  };
  const assign = (id: string | null) => void run({ type: 'workspace', action: { type: 'set_profile_avatar', profile_id: profile.id, avatar_id: id, version: profile.avatar_version ?? 0 } }, '아바타를 바꿨습니다.');

  return <div className="grid gap-4">
    <form className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      const next = name.trim();
      if (next && next !== savedName) void run({ type: 'workspace', action: { type: 'profile_display_name', profile_id: profile.id, display_name: next } }, '이름을 바꿨습니다.');
    }}>
      <label className="grid gap-2 text-caption text-ink-2">이름
        <div className="flex gap-2">
          <Input value={name} onChange={event => setName(event.target.value)} maxLength={40} required disabled={locked} className="min-w-0 flex-1"/>
          {name.trim() !== savedName && <Button type="submit" size="sm" disabled={locked || !name.trim()}>저장</Button>}
        </div>
      </label>
    </form>
    <label className="flex items-center justify-between gap-3 text-caption text-ink-2">메인 Ghost
      <Switch checked={isMain} disabled={locked || isMain} onCheckedChange={checked => {
        if (checked) void run({ type: 'workspace', action: { type: 'default_ghost', profile_id: profile.id } }, `${savedName}을(를) 메인 Ghost로 지정했습니다.`);
      }}/>
    </label>
    <fieldset className="m-0 grid gap-2"><legend className="mb-2 text-caption text-ink-2">아바타</legend>
      <div className="grid grid-cols-5 gap-1.5">
        <button type="button" aria-pressed={!profile.avatar_id} disabled={locked} onClick={() => profile.avatar_id && assign(null)} title="기본 Ghost"
          className="relative grid aspect-square cursor-pointer place-items-center rounded-control border border-line outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed aria-pressed:border-ink aria-pressed:bg-hover">
          <DotAvatar tone={toneFor(profile.id)} size={36}/><span className="sr-only">기본 Ghost</span>
          {!profile.avatar_id && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
        </button>
        {avatars.map(avatar => <AvatarTile key={avatar.id} avatar={avatar} selected={profile.avatar_id === avatar.id} disabled={locked}
          onSelect={() => profile.avatar_id !== avatar.id && assign(avatar.id)}/>)}
      </div>
    </fieldset>
    <div className="[&_fieldset]:mb-0 grid gap-4">{colors}</div>
    <form className="grid gap-2" onSubmit={event => {
      event.preventDefault();
      if (persona.trim() && persona !== profile.persona) void run({ type: 'workspace', action: { type: 'persona', profile_id: profile.id, persona } }, `${uiTerms.roleInstructions}를 저장했습니다.`);
    }}>
      <label className="grid gap-2 text-caption text-ink-2">{uiTerms.roleInstructions}
        <Textarea value={persona} onChange={event => setPersona(event.target.value)} rows={4} maxLength={4096} required disabled={locked}/>
      </label>
      {persona !== profile.persona && <Button type="submit" size="sm" className="justify-self-end" disabled={locked || !persona.trim()}>저장</Button>}
    </form>
    {notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    {error && <InlineError>{error}</InlineError>}
  </div>;
}
