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
