import type { Ghost, State } from '@ghost/contract';
import { ghostPresence } from '../features/ghostState';
import { GhostCharacter } from '../pets/GhostCharacter';
import { defaultBodyColor } from '../pets/appearance';
import type { CompanionPreferences } from './preferences';
import { companionActivity } from './WorkShelf';
import './companion.css';

export function companionGhost(state: State | null, ghostId: string): Ghost | undefined {
  const ghosts = state?.ghosts.filter(ghost => ghost.state !== 'retired') ?? [];
  return ghosts.find(ghost => ghost.id === ghostId) ?? ghosts.find(ghost => ghost.isDefault) ?? ghosts[0];
}

export function CompanionAvatar({ ghost, state, preferences, showSummary = true }: { ghost: Ghost; state: State; preferences: CompanionPreferences; showSummary?: boolean }) {
  const presence = ghostPresence(ghost, state);
  const size = { s: 84, m: 112, l: 140 }[preferences.size];
  const summary = showSummary && preferences.bubble ? companionActivity(ghost, state).summary : null;
  return <span className="companion-avatar" data-presence={presence.state} data-size={preferences.size}>
    {summary && <span className="companion-summary">{summary}</span>}
    <span className="companion-body">
      <GhostCharacter size={size} state={presence.state === 'working' ? 'running' : 'idle'} color={ghost.look.body} fallback={defaultBodyColor(ghost.id)} shape={ghost.look.shape} face={ghost.look.face} mark={ghost.look.mark}/>
      {presence.state === 'attention' && <span className="companion-attention" role="img" aria-label="확인 필요">!</span>}
    </span>
  </span>;
}
