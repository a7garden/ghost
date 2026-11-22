import type { KeyboardEvent } from 'react';
import { Check, Circle, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import type { HerdrPaneView } from '@ghost/contract';

const herdrLabel: Record<HerdrPaneView['status'], string> = { idle: '대기', working: '작업 중', blocked: '입력 필요', done: '완료', unknown: '알 수 없음' };
const herdrIcon = { idle: Circle, working: LoaderCircle, blocked: CircleAlert, done: Check, unknown: Square };

export function HerdrState({ status }: { status: HerdrPaneView['status'] }) {
  const Icon = herdrIcon[status];
  return <span className="coding-state" data-herdr={status}><Icon aria-hidden="true"/>{herdrLabel[status]}</span>;
}

export const herdrPanePath = (pane: string) => `/coding?herdr=${encodeURIComponent(pane)}`;

/** URLSearchParams has already decoded the value; the id is local to the configured session. */
export function parseHerdrPane(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/.test(value) ? value : null;
}

export function codeRunPane(result: string | null): string | null {
  if (!result) return null;
  try { return parseHerdrPane(JSON.parse(result)?.pane); }
  catch { return null; }
}

export function submitCodingOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}
