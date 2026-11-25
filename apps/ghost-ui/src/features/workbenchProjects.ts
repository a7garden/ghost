import type { Agent, CodingSession, Scope, Work } from '@ghost/contract';

/** One row in a project's agent list: the owner's listed agent, or a session a Ghost started for a Work in that project. */
export type ProjectAgent = { sessionId: string; scopeId: string | null; ghostId: string | null; listed: boolean };

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The project a Ghost's session works for: its Work's project, else the project whose folder holds it. */
export function sessionProject(session: CodingSession, works: ReadonlyMap<string, Pick<Work, 'scopeId'>>, scopes: readonly Scope[]): string | null {
  const viaWork = session.workId ? works.get(session.workId)?.scopeId : undefined;
  if (viaWork && scopes.some(scope => scope.id === viaWork)) return viaWork;
  const path = session.repo ?? session.cwd;
  return scopes.find(scope => scope.paths.some(root => inside(path, root)))?.id ?? null;
}

/**
 * Every agent the workbench shows, in list order: listed agents first (their stored order), then Ghost sessions that are
 * not listed, newest first. An agent under a project that no longer exists moves to 프로젝트 없음.
 */
export function projectAgents(
  agents: readonly Agent[], sessions: ReadonlyMap<string, CodingSession>,
  works: ReadonlyMap<string, Pick<Work, 'scopeId'>>, scopes: readonly Scope[],
): ProjectAgent[] {
  const known = new Set(scopes.map(scope => scope.id));
  const listed = new Set(agents.map(agent => agent.sessionId));
  const rows: ProjectAgent[] = agents.map(agent => ({
    sessionId: agent.sessionId,
    scopeId: agent.scopeId && known.has(agent.scopeId) ? agent.scopeId : null,
    ghostId: sessions.get(agent.sessionId)?.ghostId ?? null,
    listed: true,
  }));
  const ghostSessions = [...sessions.values()].filter(session => session.ghostId && !listed.has(session.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const session of ghostSessions) rows.push({ sessionId: session.id, scopeId: sessionProject(session, works, scopes), ghostId: session.ghostId, listed: false });
  return rows;
}

/** The folders a new agent in this project may start in: the project's paths, else none (sandbox). */
export function projectFolders(scope: Scope | undefined): string[] {
  return scope ? [...scope.paths] : [];
}
