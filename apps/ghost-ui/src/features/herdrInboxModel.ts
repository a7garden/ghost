import type { HerdrChat, HerdrChatItem, HerdrChoiceTone, HerdrPaneView, HerdrWorkspaceView } from '@ghost/contract';

export type Activity = { status: HerdrPaneView['status']; changedAt: number; openedAt: number };
export type ActivityLog = Readonly<Record<string, Activity>>;
export type AgentGroup = 'blocked' | 'working' | 'done' | 'idle' | 'shell';
export const agentGroups: readonly AgentGroup[] = ['blocked', 'working', 'done', 'idle', 'shell'];
export const agentGroupName: Record<AgentGroup, string> = { blocked: '입력 필요', working: '작업 중', done: '완료 (읽지 않음)', idle: '대기', shell: '셸' };

export function readCodingValue(key: string): string | null {
  try { return localStorage.getItem(`ghost.coding.${key}`); }
  catch { return null; }
}
export function writeCodingValue(key: string, value: string) {
  try {
    const path = `ghost.coding.${key}`;
    if (value) localStorage.setItem(path, value);
    else localStorage.removeItem(path);
  } catch { /* optional device preference */ }
}

export function trackActivity(previous: ActivityLog, workspaces: readonly HerdrWorkspaceView[], open: string | null, now: number): ActivityLog {
  const next: Record<string, Activity> = {};
  let changed = false;
  for (const workspace of workspaces) for (const tab of workspace.tabs) for (const pane of tab.panes) {
    if (!pane.agent && !pane.cwd) continue;
    const old = previous[pane.id];
    const newStatus = old?.status !== pane.status;
    const changedAt = newStatus ? now : old.changedAt;
    const openedAt = open === pane.id && (!old?.openedAt || newStatus || old.openedAt < changedAt)
      ? now : old?.openedAt ?? -1;
    next[pane.id] = !newStatus && openedAt === old.openedAt ? old : { status: pane.status, changedAt, openedAt };
    changed ||= next[pane.id] !== old;
  }
  return changed || Object.keys(previous).length !== Object.keys(next).length ? next : previous;
}

export function isUnread(pane: HerdrPaneView, activity: Activity | undefined, open: string | null) {
  return pane.status === 'done' && pane.id !== open && (!activity || activity.status !== 'done' || activity.openedAt < activity.changedAt);
}

export function groupAgents(workspaces: readonly HerdrWorkspaceView[], log: ActivityLog, open: string | null) {
  const groups: Record<AgentGroup, { pane: HerdrPaneView; changedAt: number }[]> = { blocked: [], working: [], done: [], idle: [], shell: [] };
  for (const workspace of workspaces) for (const tab of workspace.tabs) for (const pane of tab.panes) {
    if (!pane.agent && !pane.cwd) continue;
    const activity = log[pane.id];
    const group = !pane.agent ? 'shell' : pane.status === 'working' || pane.status === 'blocked' ? pane.status : isUnread(pane, activity, open) ? 'done' : 'idle';
    groups[group].push({ pane, changedAt: activity?.changedAt ?? 0 });
  }
  for (const group of agentGroups) groups[group].sort((a, b) => b.changedAt - a.changedAt);
  return groups;
}

export const choiceVariant: Record<HerdrChoiceTone, 'default' | 'outline' | 'secondary'> = {
  approve: 'default', trust: 'secondary', deny: 'outline', neutral: 'outline',
};

export function elapsedLabel(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds / 60) % 60}분`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}분`;
  return `${seconds}초`;
}

export function mergeChat(current: readonly HerdrChatItem[], delta: HerdrChat): readonly HerdrChatItem[] {
  if (delta.reset) return delta.items;
  if (!delta.items.length) return current;
  const items = new Map(current.map(item => [item.id, item]));
  for (const item of delta.items) items.set(item.id, item);
  return [...items.values()];
}

type Step = Extract<HerdrChatItem, { kind: 'thinking' | 'tool' }>;
type Message = Exclude<HerdrChatItem, Step>;
export type ChatRow = Message | { id: string; kind: 'steps'; steps: Step[]; from: number | null; to: number | null };

/** Repeated observations can share a line, but not across tool, result or message boundaries. */
type StepLine = { step: Step; count: number };

export function stepLines(steps: readonly Step[]): StepLine[] {
  const lines: StepLine[] = [];
  for (const step of steps) {
    const last = lines.at(-1);
    const prev = last?.step;
    if (last && prev && (step.kind === 'thinking' ? prev.kind === 'thinking'
      : prev.kind === 'tool' && prev.name === step.name && prev.summary === step.summary && prev.ok === step.ok)) last.count++;
    else lines.push({ step, count: 1 });
  }
  return lines;
}

/** Fold only adjacent steps, leaving speech and dividers where they actually occurred. */
export function foldChat(items: readonly HerdrChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  let start: number | null = null;
  let fold: Extract<ChatRow, { kind: 'steps' }> | null = null;
  for (const item of items) {
    switch (item.kind) {
      case 'user':
      case 'note': fold = null; start = item.at; rows.push(item); break;
      case 'thinking':
      case 'tool':
        if (!fold) {
          fold = { id: `steps:${item.id}`, kind: 'steps', steps: [], from: start ?? item.at, to: item.at };
          rows.push(fold);
        }
        fold.steps.push(item);
        fold.to = item.at ?? fold.to;
        break;
      case 'agent':
        if (fold && item.at != null) fold.to = item.at;
        fold = null; start = item.at;
        rows.push(item);
        break;
    }
  }
  return rows;
}
