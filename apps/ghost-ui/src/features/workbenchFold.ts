import type { Agent, CodingSession } from '@ghost/contract';
import type { Attention } from './WorkbenchAttention';

export const STALE_MS = 3 * 24 * 60 * 60 * 1000;

/** Agents the list folds away: idle for days and not asking for the owner. The agent on screen is never folded. */
export function foldedAgents(
  agents: readonly Agent[], sessions: ReadonlyMap<string, CodingSession>, attention: ReadonlyMap<string, Attention>,
  focusedId: string | null, now: number,
): Set<string> {
  const folded = new Set<string>();
  for (const { sessionId } of agents) {
    const session = sessions.get(sessionId);
    if (!session || sessionId === focusedId || attention.has(sessionId)) continue;
    if (session.state === 'working' || session.state === 'waiting') continue;
    if (session.state === 'closed' || now - session.updatedAt > STALE_MS) folded.add(sessionId);
  }
  return folded;
}
