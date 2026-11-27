import type { CodingDialog, CodingDialogAnswer, CodingItem, CodingSession, CodingThinking } from '@ghost/contract';
import type { CodingSessionModel } from '../host/client';

export const embeddedSessionPath = (id: string) => `/coding?session=${encodeURIComponent(id)}`;
export const codingError = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
export const codingBusy = (state: CodingSession['state']) => state === 'working' || state === 'waiting';

export function upsertCodingItem(items: readonly CodingItem[], item: CodingItem): readonly CodingItem[] {
  const at = items.findIndex(previous => previous.id === item.id);
  if (at === -1) return [...items, item];
  const next = items.slice();
  next[at] = item;
  return next;
}

/** The live subscription starts first; apply its updates after the paged history. */
export function mergeCodingItems(history: readonly CodingItem[], live: Iterable<CodingItem>): CodingItem[] {
  const byId = new Map(history.map(item => [item.id, item]));
  for (const item of live) byId.set(item.id, item);
  return [...byId.values()];
}

export type CodingToolItem = Extract<CodingItem, { kind: 'tool' }>;
type ThinkingItem = Extract<CodingItem, { kind: 'thinking' }>;
type TranscriptItem = Exclude<CodingItem, { kind: 'tool' | 'subagent' }>;
export type CodingActivity =
  | { kind: 'tools'; id: string; tools: CodingToolItem[] }
  | ThinkingItem
  | Extract<CodingItem, { kind: 'subagent' }>;
type TranscriptRow = TranscriptItem | { kind: 'activity'; id: string; entries: CodingActivity[] };

/** Read the reply before its trail, without mixing tool runs across replies or owner turns. */
export function groupCodingItems(items: readonly CodingItem[]) {
  const agents = new Set<string>();
  for (const item of items) if (item.kind === 'subagent') agents.add(item.id);
  const subagentTools = new Map<string, CodingToolItem[]>();
  const rows: TranscriptRow[] = [];
  let activity: CodingActivity[] = [];
  let tools: CodingToolItem[] = [];
  let thinking: ThinkingItem[] = [];

  function flushTools() {
    const first = tools[0];
    if (first) {
      activity.push({ kind: 'tools', id: first.id, tools });
      tools = [];
    }
  }

  function flushTurn() {
    flushTools();
    const first = activity[0];
    if (first) rows.push({ kind: 'activity', id: first.id, entries: activity });
    rows.push(...thinking);
    activity = [];
    thinking = [];
  }

  for (const item of items) {
    if (item.kind === 'tool' && item.subagent && agents.has(item.subagent)) {
      const branch = subagentTools.get(item.subagent);
      if (branch) branch.push(item);
      else subagentTools.set(item.subagent, [item]);
      continue;
    }
    switch (item.kind) {
      case 'thinking':
        flushTools();
        thinking.push(item);
        break;
      case 'assistant':
        flushTools();
        rows.push(item, ...thinking);
        thinking = [];
        break;
      case 'tool':
      case 'subagent':
        // A reasoning block followed only by a call has no reply to attach to.
        if (thinking.length) {
          activity.push(...thinking);
          thinking = [];
        }
        if (item.kind === 'tool') tools.push(item);
        else {
          flushTools();
          activity.push(item);
        }
        break;
      case 'notice':
      case 'user':
        flushTurn();
        rows.push(item);
        break;
    }
  }
  flushTurn();
  return { rows, subagentTools };
}

const toolNames: Partial<Record<string, string>> = {
  edit: '파일 수정', write: '파일 쓰기', read: '파일 읽기', bash: '명령 실행',
  grep: '내용 검색', find: '파일 찾기', ls: '목록 보기',
};

/** Counts calls, not distinct files: the Host sends a (possibly clipped) summary, not a file list. */
export function codingToolSummary(tools: readonly CodingToolItem[]): string {
  const counts = new Map<string, number>();
  for (const { tool } of tools) {
    const name = Object.hasOwn(toolNames, tool) ? toolNames[tool] ?? tool : tool;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => `${name} ${count}`).join(' · ');
}

/** Approval carries evidence but no call id. Mark a row only when that evidence matches one running call. */
export function codingApprovalToolId(items: readonly CodingItem[], tool: CodingDialog['tool']): string | undefined {
  if (!tool?.summary) return undefined;
  const summary = `${tool.name} ${tool.summary.replace(/\s+/g, ' ')}`.slice(0, 400);
  let match: string | undefined;
  for (const item of items) {
    if (item.kind !== 'tool' || item.status !== 'running' || item.tool !== tool.name || item.summary !== summary) continue;
    if (match !== undefined) return undefined;
    match = item.id;
  }
  return match;
}

type DialogIntent = { type: 'cancel' } | { type: 'confirm'; yes: boolean } | { type: 'option'; id: string } | { type: 'text'; value: string };

export function codingDialogAnswer(dialog: CodingDialog, intent: DialogIntent): CodingDialogAnswer | null {
  switch (intent.type) {
    case 'cancel': return { cancel: true };
    case 'confirm':
      return dialog.kind === 'confirm' || dialog.kind === 'approval' ? { value: intent.yes ? 'yes' : 'no' } : null;
    case 'option': {
      const option = dialog.options?.find(option => option.id === intent.id);
      if (!option) return null;
      if (dialog.kind === 'choices') return { optionId: option.id };
      if (dialog.kind === 'select') return { value: option.label };
      return null;
    }
    case 'text':
      if (dialog.kind === 'input') return { value: intent.value };
      if (dialog.kind === 'choices' && dialog.allowText && intent.value.trim()) return { text: intent.value.trim() };
      return null;
  }
}

export const codingThinkingLabels: Record<CodingThinking, string> = { off: '끔', low: '낮음', medium: '중간', high: '높음' };
export const modelKey = ({ provider, model }: CodingSession['model']) => JSON.stringify([provider, model]);

export function codingThinkingOptions(model: CodingSessionModel | undefined): CodingThinking[] {
  return model?.thinking.filter((level): level is CodingThinking => Object.hasOwn(codingThinkingLabels, level)) ?? [];
}
