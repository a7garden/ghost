import type { CodingSession, WorkbenchState } from '@ghost/contract';
import { directoryName } from './CodingModel';

type SessionLinkAction = {
  path: string;
  fields: Record<string, unknown>;
  /** The step that leaves the session focused; a null result is already there. */
  opensAgent?: true;
};

/** Plan one existing API mutation against the latest state; a null result is already focused. */
export function resolveSessionLink(state: WorkbenchState, session: Pick<CodingSession, 'id' | 'repo' | 'cwd'>): SessionLinkAction | null {
  const focus = state.focus;
  if (focus?.sessionId === session.id) return null;

  const existing = state.agents.find(agent => agent.sessionId === session.id);
  if (existing) return { path: 'focus', fields: { spaceId: existing.spaceId, sessionId: session.id }, opensAgent: true };
  if (focus) return { path: `spaces/${encodeURIComponent(focus.spaceId)}/agents`, fields: { sessionId: session.id }, opensAgent: true };

  const title = directoryName(session.repo ?? session.cwd).trim().slice(0, 200) || '코딩';
  return { path: 'spaces', fields: { title, root: session.repo ?? session.cwd } };
}
