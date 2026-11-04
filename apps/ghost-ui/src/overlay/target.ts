/** Pure overlay target selection — no DOM, so the rules stay unit-testable. */
import type { Profile, Snapshot } from '../client/types';

export type Target = { profile_id?: string; conversation_id?: string };

/** The main Ghost is "primary"; an explicit target id wins, else the first profile. */
export function pickProfile(snapshot: Snapshot, wanted?: string): Profile | null {
  return (
    snapshot.profiles.find(p => p.id === wanted) ??
    snapshot.profiles.find(p => p.name === 'primary') ??
    snapshot.profiles.find(p => p.name === wanted) ??
    snapshot.profiles[0] ??
    null
  );
}

/** The stored conversation when it still exists, else the newest (UUIDv7 sorts by time). */
export function pickConversation(next: Profile, wanted?: string): string {
  if (wanted && next.conversations.some(c => c.id === wanted)) return wanted;
  return next.conversations.map(c => c.id).sort().at(-1) ?? '';
}

/** Routing turns: follow-up into a conversation that already has messages. */
export function routingKind(messageCount: number): 'follow_up' | 'prompt' {
  return messageCount ? 'follow_up' : 'prompt';
}

/** The legacy non-routing fallback mirrors the console: steer only what is running. */
export function legacySubmitKind(runningTasks: number): 'steer' | 'prompt' {
  return runningTasks ? 'steer' : 'prompt';
}
