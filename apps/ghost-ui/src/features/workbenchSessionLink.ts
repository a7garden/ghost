import type { CodingSession, WorkbenchPaneCreate, WorkbenchState } from '@ghost/contract';
import { directoryName } from './CodingModel';

type SessionLinkAction = {
  path: string;
  fields: Record<string, unknown>;
  opensPane?: true;
};

/** Plan one existing API mutation against the latest layout; a null result is already focused. */
export function resolveSessionLink(state: WorkbenchState, session: Pick<CodingSession, 'id' | 'repo' | 'cwd'>): SessionLinkAction | null {
  const focus = state.focus;
  const focused = state.panes.find(pane => pane.id === focus?.paneId);
  if (focused?.kind === 'session' && focused.sessionId === session.id) return null;

  const existing = state.panes.find(pane => pane.kind === 'session' && pane.sessionId === session.id && pane.tabId === focus?.tabId)
    ?? state.panes.find(pane => pane.kind === 'session' && pane.sessionId === session.id);
  const existingTab = existing && state.tabs.find(tab => tab.id === existing.tabId);
  if (existing && existingTab) {
    return { path: 'focus', fields: { spaceId: existingTab.spaceId, tabId: existingTab.id, paneId: existing.id }, opensPane: true };
  }

  const tab = state.tabs.find(tab => tab.id === focus?.tabId);
  if (tab) {
    let leaf = tab.layout;
    while (leaf?.type === 'split') leaf = leaf.first;
    const target = tab.focusedPaneId ?? leaf?.paneId;
    const pane: WorkbenchPaneCreate['pane'] = { kind: 'session', sessionId: session.id };
    return { path: `tabs/${encodeURIComponent(tab.id)}/panes`, fields: { pane, ...(target ? { targetPaneId: target, direction: 'right' } : {}) }, opensPane: true };
  }
  const root = session.repo ?? session.cwd;
  const title = directoryName(root).trim().slice(0, 200) || '코딩';
  if (focus) return { path: `spaces/${encodeURIComponent(focus.spaceId)}/tabs`, fields: { title } };
  return { path: 'spaces', fields: { title, root } };
}
