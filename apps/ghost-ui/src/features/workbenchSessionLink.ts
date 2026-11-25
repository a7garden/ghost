import type { CodingSession, WorkbenchState } from '@ghost/contract';

type SessionLinkAction = { path: string; fields: Record<string, unknown> };

/**
 * The one workbench mutation that puts a linked session on screen, or null when it is already focused. A listed agent
 * is focused in its project; a Ghost's session is focused where its Work belongs without being listed; any other
 * session is listed under the project that holds its folder (`scopeId`, null for 프로젝트 없음).
 */
export function resolveSessionLink(state: WorkbenchState, session: Pick<CodingSession, 'id' | 'ghostId'>, scopeId: string | null): SessionLinkAction | null {
  if (state.focus?.sessionId === session.id) return null;
  const existing = state.agents.find(agent => agent.sessionId === session.id);
  if (existing) return { path: 'focus', fields: { scopeId: existing.scopeId, sessionId: session.id } };
  if (session.ghostId) return { path: 'focus', fields: { scopeId, sessionId: session.id } };
  return { path: 'agents', fields: { sessionId: session.id, scopeId } };
}
