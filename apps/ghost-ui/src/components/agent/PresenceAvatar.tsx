import { DotAvatar } from '../DotAvatar';
import { stateLabel, toneFor, type DotState } from '../../features/ghostState';

/**
 * A Ghost's portrait inside its state ring: a travelling arc while it works,
 * a steady amber ring with a notch when it needs the owner, nothing when idle.
 */
export function PresenceAvatar({ ghostId, state, size = 32, className = '' }: { ghostId: string; state: DotState; size?: number; className?: string }) {
  return <span className={`presence ${className}`} data-presence={state} style={{ width: size, height: size }}>
    <DotAvatar profileId={ghostId} tone={toneFor(ghostId)} size={size}/>
    {state !== 'idle' && <span className="presence__ring" aria-hidden="true"/>}
    {state === 'attention' && <span className="presence__notch" aria-hidden="true"/>}
    {state !== 'idle' && <span className="sr-only">{stateLabel[state]}</span>}
  </span>;
}
