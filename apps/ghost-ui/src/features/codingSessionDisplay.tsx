import { Check, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import type { CodingAgentId, CodingSessionView } from '@ghost/contract';

export const codingAgentName: Record<CodingAgentId, string> = { omp: 'omp', claude: 'Claude Code', codex: 'Codex' };
export const firstTaskLine = (text: string) => text.trimStart().split(/\r?\n/, 1)[0] ?? '';
const stateLabel: Record<CodingSessionView['state'], string> = { running: '진행 중', done: '완료', failed: '실패', interrupted: '중단됨' };
const stateIcon = { running: LoaderCircle, done: Check, failed: CircleAlert, interrupted: Square };

export function SessionState({ state }: { state: CodingSessionView['state'] }) {
  const Icon = stateIcon[state];
  return <span className="coding-state" data-state={state}><Icon aria-hidden="true"/>{stateLabel[state]}</span>;
}
