import type { Ghost, State } from '@ghost/contract';
import { ghostPresence } from '../features/ghostState';
import { GhostCharacter } from '../pets/GhostCharacter';
import { defaultBodyColor } from '../pets/appearance';
import type { CompanionPreferences } from './preferences';
import './companion.css';

export function companionGhost(state: State | null, ghostId: string): Ghost | undefined {
  const ghosts = state?.ghosts.filter(ghost => ghost.state !== 'retired') ?? [];
  return ghosts.find(ghost => ghost.id === ghostId) ?? ghosts.find(ghost => ghost.isDefault) ?? ghosts[0];
}

export function CompanionAvatar({ ghost, state, preferences }: { ghost: Ghost; state: State; preferences: CompanionPreferences }) {
  const presence = ghostPresence(ghost, state);
  const size = { s: 84, m: 112, l: 140 }[preferences.size];
  return <span className="companion-avatar" data-presence={presence.state} data-size={preferences.size}>
    {preferences.bubble && presence.line && <span className="companion-bubble" title={presence.line}>{presence.line}</span>}
    <span className="companion-body">
      <GhostCharacter size={size} state={presence.state === 'working' ? 'running' : 'idle'} color={ghost.look.body} fallback={defaultBodyColor(ghost.id)} shape={ghost.look.shape} face={ghost.look.face} mark={ghost.look.mark}/>
      {presence.state === 'attention' && <span className="companion-attention" role="img" aria-label="확인 필요">!</span>}
    </span>
  </span>;
}
