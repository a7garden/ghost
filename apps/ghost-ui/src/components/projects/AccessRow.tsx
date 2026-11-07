import { useRef } from 'react';
import type { SpaceGrant } from '@ghost/contract';
import { ACCESS_LEVELS, accessLabel, withAccess, type AccessLevel } from '../../features/spacePages';
import { toneFor } from '../../features/ghostState';
import { DotAvatar } from '../DotAvatar';

export interface AccessGhost { id: string; name: string }

/** One Ghost's tri-state toggle: 없음 → 읽기 → 제안 as a radiogroup with a sliding thumb. */
function AccessToggle({ ghost, level, disabled, onChange }: {
  ghost: AccessGhost;
  level: AccessLevel;
  disabled?: boolean;
  onChange(level: AccessLevel): void;
}) {
  const buttons = useRef(new Map<AccessLevel, HTMLButtonElement>());
  /** Guarded by aria-disabled, not the disabled attribute: disabling would drop focus mid-request. */
  const select = (next: AccessLevel) => { if (next !== level && !disabled) onChange(next); };
  /** Radiogroup arrows: move and select at once, with DOM focus following the pick. */
  const move = (offset: number) => {
    const at = ACCESS_LEVELS.indexOf(level);
    const next = ACCESS_LEVELS[(at + offset + ACCESS_LEVELS.length) % ACCESS_LEVELS.length]!;
    select(next);
    buttons.current.get(next)?.focus();
  };
  return <span className="access__modes" role="radiogroup" aria-label={`${ghost.name} 접근`} data-at={ACCESS_LEVELS.indexOf(level)}
    onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    }}>
    <span className="access__thumb" aria-hidden="true"/>
    {ACCESS_LEVELS.map(option => <button key={option} type="button" role="radio" aria-checked={option === level}
      tabIndex={option === level ? 0 : -1} aria-disabled={disabled || undefined} className="access__mode"
      onClick={() => select(option)}
      ref={el => { if (el) buttons.current.set(option, el); else buttons.current.delete(option); }}>
      {accessLabel[option]}
    </button>)}
  </span>;
}

/**
 * The project's Ghost access as a row of portraits, each carrying its tri-state
 * toggle. Granted Ghosts lead; the rest follow so granting is one click away.
 */
export function AccessRow({ ghosts, grants, disabled, onChange }: {
  ghosts: readonly AccessGhost[];
  grants: readonly SpaceGrant[];
  disabled?: boolean;
  onChange(grants: SpaceGrant[]): void;
}) {
  const roster = [
    ...grants.flatMap(grant => {
      const ghost = ghosts.find(item => item.id === grant.ghostId);
      return ghost ? [ghost] : [];
    }),
    ...ghosts.filter(ghost => !grants.some(grant => grant.ghostId === ghost.id)),
  ];
  return <div className="access">
    {roster.map(ghost => {
      const level = grants.find(grant => grant.ghostId === ghost.id)?.mode ?? 'none';
      return <div className="access__ghost" data-level={level} key={ghost.id}>
        <span className="access__id">
          <span className="access__portrait"><DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={38}/></span>
          <span className="access__name">{ghost.name}</span>
        </span>
        <AccessToggle ghost={ghost} level={level} disabled={disabled} onChange={next => onChange(withAccess([...grants], ghost.id, next))}/>
      </div>;
    })}
  </div>;
}
