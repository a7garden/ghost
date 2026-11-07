import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { InlineError } from '../ui'
import type { Look } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { GhostCharacter } from '../pets/GhostCharacter';
import { defaultBodyColor } from '../pets/appearance';
import { useAvatarSource } from '../pets/AvatarProvider';
import { LookEditor } from '../pets/LookEditor';
import { PetSprite } from '../pets/PetSprite';
import { spriteVersionOf } from '../pets/sprites';

/**
 * 꾸미기: 한 Ghost의 모습만 고친다. 이름·메인·상태·모델·역할·도구·샌드박스는 Ghost 설정이 맡는다.
 * 고른 모습은 바로 보이고 뒤에서 ghost.update로 저장되며, 마지막 선택이 남는다.
 */
export function GhostDesignEditor({ ghostId }: { ghostId: string }) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghost = state?.ghosts.find(item => item.id === ghostId);
  const avatars = state?.avatars ?? [];
  const [error, setError] = useState('');
  const [lookDraft, setLookDraft] = useState<Look | null>(null);
  const lookRequest = useRef(0);
  if (!ghost) return <p className="m-0 text-caption text-ink-3">Ghost를 찾을 수 없습니다.</p>;
  const look = lookDraft ?? ghost.look;
  const saveLook = (patch: Partial<Look>) => {
    const next = { ...look, ...patch };
    const request = ++lookRequest.current;
    setLookDraft(next); setError('');
    client.send({ type: 'ghost.update', ghostId, look: next }).then(
      () => { if (request === lookRequest.current) setLookDraft(null); },
      reason => { if (request === lookRequest.current) { setLookDraft(null); setError(reason instanceof Error ? reason.message : '모습을 저장하지 못했습니다.'); } },
    );
  };
  return <div className="grid gap-5">
    {!look.avatarId && <LookEditor ghostId={ghost.id} look={look} disabled={!state} onChange={saveLook}/>}
    {/* Stored sprite avatars from earlier versions stay selectable; there is no way to add new ones. */}
    {avatars.length > 0 && <fieldset className="m-0 grid gap-2 border-0 p-0"><legend className="mb-2 text-caption text-ink-3">아바타</legend>
      <div className="grid grid-cols-5 gap-1.5">
        <button type="button" aria-pressed={!look.avatarId} disabled={!state} onClick={() => look.avatarId && saveLook({ avatarId: null })} title="기본 Ghost"
          className="avatar-choice avatar-choice--tile p-2 outline-none disabled:cursor-not-allowed">
          <GhostCharacter size={36} animate={false} color={look.body} fallback={defaultBodyColor(ghost.id)} shape={look.shape} face={look.face} mark={look.mark}/><span className="sr-only">기본 Ghost</span>
          {!look.avatarId && <Check size={12} className="absolute top-1 right-1" aria-hidden="true"/>}
        </button>
        {avatars.map(avatar => <AvatarTile key={avatar.id} avatar={avatar} selected={look.avatarId === avatar.id} disabled={!state}
          onSelect={() => look.avatarId !== avatar.id && saveLook({ avatarId: avatar.id })}/>)}
      </div>
    </fieldset>}
    {error && <InlineError>{error}</InlineError>}
  </div>;
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
