import { PetSprite } from '../pets/PetSprite';
import { useProfileAvatar } from '../pets/AvatarProvider';
import { GhostCharacter } from '../pets/GhostCharacter';
import type { Tone } from '../client/types';

export function DotAvatar({ tone = 'mint', size = 48, className = '', profileId }: { tone?: Tone; size?: number; className?: string; profileId?: string }) {
  const pet = useProfileAvatar(profileId, tone);
  return <span className={`dot-avatar pet-avatar ${className}`} style={{ width: size, height: size }} aria-hidden="true">
    {pet.source ? <PetSprite source={pet.source} version={pet.version} state={pet.state} size={size} animate={pet.animate}/> : pet.isDefault ? <GhostCharacter size={size} state={pet.isResponding ? 'running' : 'idle'} animate={pet.animate}/> : <span className="avatar-loading"/>}
  </span>;
}
export function GhostMark() { return <GhostCharacter size={26} animate={false}/>; }
