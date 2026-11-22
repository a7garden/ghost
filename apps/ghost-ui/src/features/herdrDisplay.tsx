import type { KeyboardEvent } from 'react';
import { StateGlyph, type GlyphState } from '../components/agent/StateGlyph';
import type { HerdrPaneView } from '@ghost/contract';

const herdrLabel: Record<HerdrPaneView['status'], string> = { idle: '대기', working: '작업 중', blocked: '입력 필요', done: '완료', unknown: '알 수 없음' };
const glyphs: Record<HerdrPaneView['status'], GlyphState> = { idle: 'queued', working: 'running', blocked: 'attention', done: 'done', unknown: 'queued' };

export function HerdrState({ status, size = 14, label = true, unread = false }: {
  status: HerdrPaneView['status']; size?: number; label?: boolean; unread?: boolean;
}) {
  return <StateGlyph size={size} state={glyphs[status]} mark={unread ? 'dot' : 'ring'}
    label={label} accessibleLabel={unread ? '읽지 않은 완료' : herdrLabel[status]} className="coding-state"/>;
}

export const herdrPanePath = (pane: string, session?: string | null) =>
  `/coding?herdr=${encodeURIComponent(pane)}${session ? `&herdrSession=${encodeURIComponent(session)}` : ''}`;

/** URLSearchParams has already decoded the value; the id is local to the configured session. */
export function parseHerdrPane(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/.test(value) ? value : null;
}

/** A pane id is only unique inside its herdr session: a link that knows the session carries it, so it never silently points at another session's same-id pane. */
export function parseHerdrSession(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;
}

export function codeRunPane(result: string | null): string | null {
  if (!result) return null;
  try { return parseHerdrPane(JSON.parse(result)?.pane); }
  catch { return null; }
}

/** An asynchronous code_run effect ends with a receipt naming its run, not a pane; the run row carries the pane. */
export function codeRunReceiptRun(result: string | null): string | null {
  if (!result) return null;
  try {
    const runId = JSON.parse(result)?.runId;
    return typeof runId === 'string' && runId.length > 0 ? runId : null;
  } catch { return null; }
}

export function submitCodingOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
