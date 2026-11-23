import type { HerdrWorkspaceView, Scope } from '@ghost/contract';
import type { ActivityLog } from './herdrInboxModel';

/** Use the current browser address, not the last React render: hash changes can be coalesced. */
export function startsCodingEntry(from: string, to: string) {
  return to === '/coding' && from.split('?', 1)[0] !== '/coding';
}

function absolute(path: string | null | undefined) {
  return path?.startsWith('/') ? path.replace(/\/+$/, '') || '/' : null;
}

export function directoryName(path: string) { return path.slice(path.lastIndexOf('/') + 1) || '/'; }

export function recentCodingDirectories(workspaces: readonly HerdrWorkspaceView[], scopes: readonly Pick<Scope, 'paths' | 'updatedAt'>[], log: ActivityLog) {
  const projectPaths = [...scopes].sort((a, b) => b.updatedAt - a.updatedAt).flatMap(scope => scope.paths.flatMap(path => absolute(path) ?? []));
  const knownRoots = new Set(projectPaths);
  for (const workspace of workspaces) if (!workspace.worktree) {
    for (const tab of workspace.tabs) for (const pane of tab.panes) {
      const cwd = absolute(pane.cwd);
      if (cwd) knownRoots.add(cwd);
    }
  }
  const dirs = new Map<string, { recent: number; focused: boolean }>();
  const remember = (path: string, recent: number, focused: boolean) => {
    const prior = dirs.get(path);
    if (!prior || recent > prior.recent || (recent === prior.recent && focused)) dirs.set(path, { recent, focused });
  };
  for (const workspace of workspaces) {
    const checkout = absolute(workspace.worktree?.path);
    if (checkout) {
      // Herdr's default is ~/.herdr/worktrees/<repo>/<branch-slug>. Resolve only an unambiguous known source.
      const repo = /\/\.herdr\/worktrees\/([^/]+)\/[^/]+$/.exec(checkout)?.[1];
      const roots = repo ? [...knownRoots].filter(path => directoryName(path) === repo) : [];
      const path = roots.length === 1 ? roots[0]! : checkout;
      let recent = 0, focused = false;
      for (const tab of workspace.tabs) for (const pane of tab.panes) {
        recent = Math.max(recent, log[pane.id]?.changedAt ?? 0, log[pane.id]?.openedAt ?? 0);
        focused ||= pane.focused;
      }
      remember(path, recent, focused);
    } else for (const tab of workspace.tabs) for (const pane of tab.panes) {
      const cwd = absolute(pane.cwd);
      if (cwd) remember(cwd, Math.max(log[pane.id]?.changedAt ?? 0, log[pane.id]?.openedAt ?? 0), pane.focused);
    }
  }
  for (const path of projectPaths) remember(path, -1, false);
  return [...dirs].sort(([, a], [, b]) => b.recent - a.recent || Number(b.focused) - Number(a.focused)).slice(0, 8).map(([path]) => path);
}
