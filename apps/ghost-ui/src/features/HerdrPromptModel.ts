import type { HerdrChatItem, HerdrDelivery, HerdrUpload } from '@ghost/contract';

export type HerdrReadyAttachment = { id: string; file: File; saved: HerdrUpload };
export type HerdrPromptDraft = { text: string; attachments: readonly HerdrReadyAttachment[] };
export type OptimisticPrompt = HerdrPromptDraft & {
  id: number;
  /** The last transcript row already seen, to keep older identical messages from swallowing this one. */
  after: string | undefined;
  delivery: HerdrDelivery | undefined;
  error?: string;
};

/** The Host encodes these paths for the target agent. Composer text never contains generated tokens. */
export function herdrPromptContent({ text, attachments }: HerdrPromptDraft) {
  return { text: text.trim(), ...(attachments.length > 0 && { attachments: attachments.map(item => item.saved.path) }) };
}

function matchesPrompt(prompt: OptimisticPrompt, item: Extract<HerdrChatItem, { kind: 'user' }>) {
  const text = item.text.trim();
  const truncated = text.endsWith('…') && prompt.text.startsWith(text.slice(0, -1));
  const matchesText = text === prompt.text || truncated || (prompt.attachments.length > 0 && text.startsWith(`${prompt.text}\n`));
  if (prompt.text && !matchesText) return false;
  if (!prompt.attachments.length) return !item.imageCount;
  if (truncated) return true;
  const lines = `\n${text}\n`;
  let nativeImages = 0;
  for (const attachment of prompt.attachments) {
    if (lines.includes(`\n@${attachment.saved.path}\n`)) continue;
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(attachment.saved.path)) return false;
    nativeImages++;
  }
  return nativeImages === (item.imageCount ?? 0);
}

/** Scan each new row once, allowing one recorded user message to confirm at most one submission. */
export function reconcileHerdrPrompts(pending: readonly OptimisticPrompt[], items: readonly HerdrChatItem[]): readonly OptimisticPrompt[] {
  const tail = items.at(-1)?.id;
  if (!tail || pending.every(prompt => prompt.after === tail)) return pending;
  const claimed = new Set<string>();
  return pending.flatMap(prompt => {
    if (prompt.after === tail) return [prompt];
    const anchor = prompt.after === undefined ? -1 : items.findIndex(item => item.id === prompt.after);
    // When the Host reset its bounded window, stable record offsets still distinguish older rows.
    const offset = anchor === -1 && prompt.after !== undefined ? Number(prompt.after.split(':', 1)[0]) : NaN;
    for (let index = anchor + 1; index < items.length; index++) {
      const item = items[index]!;
      if (item.kind !== 'user' || claimed.has(item.id) || Number(item.id.split(':', 1)[0]) <= offset) continue;
      if (matchesPrompt(prompt, item)) { claimed.add(item.id); return []; }
    }
    return [{ ...prompt, after: tail }];
  });
}
