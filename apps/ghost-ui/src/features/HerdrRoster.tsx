import { useState } from 'react';
import { Columns2, GitBranch, MoreHorizontal, Pencil, Plus, Rows2, SquareTerminal, X } from 'lucide-react';
import type { HerdrPaneView, HerdrTabView, HerdrTarget, HerdrWorkspaceView } from '@ghost/contract';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { HerdrState, herdrPanePath } from './herdrDisplay';

export type HerdrNode = { id: string; label: string; target: HerdrTarget };
export type RosterAction =
  | { kind: 'tab'; node: HerdrNode }
  | { kind: 'split'; node: HerdrNode; pane: string; direction: 'right' | 'down' }
  | { kind: 'agent'; node: HerdrNode }
  | { kind: 'rename'; node: HerdrNode }
  | { kind: 'close'; node: HerdrNode };

export function findHerdrPane(workspaces: readonly HerdrWorkspaceView[], pane: string | null): HerdrPaneView | undefined {
  if (!pane) return;
  for (const workspace of workspaces) for (const tab of workspace.tabs) {
    const match = tab.panes.find(item => item.id === pane);
    if (match) return match;
  }
}

export function herdrNodeActions(node: HerdrNode, { splitPane, shell = false }: { splitPane?: string; shell?: boolean } = {}): RosterAction[] {
  const actions: RosterAction[] = [];
  if (node.target === 'workspace') actions.push({ kind: 'tab', node });
  if (node.target === 'tab' && splitPane) actions.push(
    { kind: 'split', node, pane: splitPane, direction: 'right' }, { kind: 'split', node, pane: splitPane, direction: 'down' },
  );
  if (node.target === 'pane' && shell) actions.push({ kind: 'agent', node });
  if (node.target !== 'pane') actions.push({ kind: 'rename', node });
  actions.push({ kind: 'close', node });
  return actions;
}

const actions = {
  tab: { label: '새 탭', Icon: Plus },
  right: { label: '오른쪽으로 분할', Icon: Columns2 },
  down: { label: '아래로 분할', Icon: Rows2 },
  agent: { label: '에이전트 시작', Icon: SquareTerminal },
  rename: { label: '이름 바꾸기', Icon: Pencil },
  close: { label: '닫기', Icon: X },
};

function NodeActions({ node, items, onAction }: { node: HerdrNode; items: RosterAction[]; onAction(action: RosterAction): void }) {
  const [open, setOpen] = useState(false);
  const label = `${node.label} 작업`;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" className="herdr-node-more" aria-label={label}><MoreHorizontal aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent className="herdr-node-menu" aria-label={label} align="end" sideOffset={4}>
      {items.map(action => {
        const key = action.kind === 'split' ? action.direction : action.kind;
        const { label, Icon } = actions[key];
        return <Button key={key} type="button" variant="ghost" className="herdr-node-action" data-danger={key === 'close' || undefined}
          onClick={() => { setOpen(false); onAction(action); }}><Icon aria-hidden="true"/>{label}</Button>;
      })}
    </PopoverContent>
  </Popover>;
}

function TabRows({ tab, selected, onAction }: { tab: HerdrTabView; selected: string | null; onAction(action: RosterAction): void }) {
  const node: HerdrNode = { id: tab.id, label: tab.label, target: 'tab' };
  const splitPane = tab.panes.find(pane => pane.id === selected) ?? tab.panes.find(pane => pane.focused) ?? tab.panes[0];
  return <section className="herdr-roster-tab" aria-label={`탭 · ${tab.label}`}>
    <div className="herdr-node-head">
      <h3>{tab.label}</h3>
      <HerdrState status={tab.status}/>
      <NodeActions node={node} items={herdrNodeActions(node, { splitPane: splitPane?.id })} onAction={onAction}/>
    </div>
    <ul>{tab.panes.map(pane => {
      const paneNode: HerdrNode = { id: pane.id, label: pane.title, target: 'pane' };
      return <li key={pane.id} className="herdr-pane-row" data-selected={pane.id === selected || undefined}>
        <a href={`#${herdrPanePath(pane.id)}`} aria-current={selected === pane.id ? 'page' : undefined}>
          <strong className="coding-row-title">{pane.title}</strong>
          {pane.agent && <HerdrState status={pane.status}/>}
          {pane.agent ? <span className="coding-row-meta">{pane.agent}</span>
            : <code className="coding-row-meta" title={pane.cwd ?? undefined}>{pane.cwd || '셸'}</code>}
        </a>
        <NodeActions node={paneNode} items={herdrNodeActions(paneNode, { shell: pane.agent === null })} onAction={onAction}/>
      </li>;
    })}</ul>
  </section>;
}

export function HerdrRoster({ workspaces, selected, onAction }: { workspaces: readonly HerdrWorkspaceView[]; selected: string | null; onAction(action: RosterAction): void }) {
  return workspaces.map(workspace => {
    const node: HerdrNode = { id: workspace.id, label: workspace.label, target: 'workspace' };
    return <section key={workspace.id} className="coding-roster-group" aria-label={`스페이스 · ${workspace.label}`}>
      <div className="herdr-node-head">
        <h2>{workspace.label}</h2>
        <HerdrState status={workspace.status}/>
        <NodeActions node={node} items={herdrNodeActions(node)} onAction={onAction}/>
        {workspace.worktree && <span className="herdr-worktree" title={workspace.worktree.path}><GitBranch aria-hidden="true"/>
          <code>{workspace.worktree.branch || workspace.worktree.path}</code>
        </span>}
      </div>
      {workspace.tabs.map(tab => <TabRows key={tab.id} tab={tab} selected={selected} onAction={onAction}/>)}
    </section>;
  });
}
