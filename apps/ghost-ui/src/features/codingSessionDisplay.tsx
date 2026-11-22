import { Check, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import type { CodingAgentId, CodingSessionView, HerdrPaneView } from '@ghost/contract';

export const codingAgentName: Record<CodingAgentId, string> = { omp: 'omp', claude: 'Claude Code', codex: 'Codex' };
export const firstTaskLine = (text: string) => text.trimStart().split(/\r?\n/, 1)[0] ?? '';
const stateLabel: Record<CodingSessionView['state'], string> = { running: '진행 중', done: '완료', failed: '실패', interrupted: '중단됨' };
const stateIcon = { running: LoaderCircle, done: Check, failed: CircleAlert, interrupted: Square };

export function SessionState({ state }: { state: CodingSessionView['state'] }) {
  const Icon = stateIcon[state];
  return <span className="coding-state" data-state={state}><Icon aria-hidden="true"/>{stateLabel[state]}</span>;
}

const herdrLabel: Record<HerdrPaneView['status'], string> = { idle: '대기', working: '작업 중', blocked: '입력 필요', done: '끝남', unknown: '알 수 없음' };
const herdrIcon = { idle: Check, working: LoaderCircle, blocked: CircleAlert, done: Check, unknown: Square };

export function HerdrState({ status }: { status: HerdrPaneView['status'] }) {
  const Icon = herdrIcon[status];
  return <span className="coding-state" data-herdr={status}><Icon aria-hidden="true"/>{herdrLabel[status]}</span>;
}

/** `herdr=<session>/<pane>` in the address names one herdr pane; pane ids hold a colon, session names never a slash. */
export const herdrPanePath = (pane: Pick<HerdrPaneView, 'session' | 'id'>) => `/coding?herdr=${encodeURIComponent(`${pane.session}/${pane.id}`)}`;
export function parseHerdrPane(value: string): { session: string; pane: string } | null {
  const at = value.indexOf('/');
  return at > 0 && at < value.length - 1 ? { session: value.slice(0, at), pane: value.slice(at + 1) } : null;
}
