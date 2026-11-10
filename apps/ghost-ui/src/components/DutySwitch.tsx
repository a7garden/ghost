import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import type { State } from '@ghost/contract';
import { useHost } from '../host/context';
import { liveWorks } from '../features/ghostState';

const clock = (at: number) => new Date(at).toLocaleString('ko-KR', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 출근 · 퇴근 원버튼. 퇴근하면 모든 Ghost 가 스스로 새 일을 시작하지 않는다(자율 깨우기 · 예약 · 활동 규칙).
 * 진행 중인 일은 마저 끝낸다. 근무 시간표가 있으면 누른 상태는 다음 시간표 경계까지만 간다.
 */
export function DutySwitch({ state }: { state: State }) {
  const { client } = useHost();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const duty = state.duty;
  if (!duty) return null;
  const finishing = liveWorks(state).length + state.conversations.filter(conversation => conversation.busy).length;
  const next = duty.nextChangeAt === null ? '' : `${clock(duty.nextChangeAt)}에 ${duty.onDuty ? '퇴근' : '출근'}`;
  const detail = duty.onDuty
    ? ['근무 중 — Ghost들이 스스로 일합니다.', next, '누르면 퇴근합니다.']
    : ['퇴근 — Ghost들이 새 일을 스스로 시작하지 않습니다.', finishing ? `진행 중인 ${finishing}건은 마저 끝냅니다.` : '', next, '누르면 출근합니다.'];
  const toggle = async () => {
    setPending(true); setError('');
    try { await client.send({ type: 'duty.switch', onDuty: !duty.onDuty }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '바꾸지 못했습니다.'); }
    finally { setPending(false); }
  };
  const Icon = duty.onDuty ? Sun : Moon;
  return <button type="button" className="shell-search" aria-pressed={!duty.onDuty} disabled={pending}
    title={[...detail, error].filter(Boolean).join('\n')} onClick={() => void toggle()}
    data-duty={duty.onDuty ? 'on' : 'off'}>
    <Icon aria-hidden="true"/>
    <span className="shell-search__label">{duty.onDuty ? '근무 중' : '퇴근'}</span>
    <span className="sr-only" role="status" aria-live="polite">{duty.onDuty ? '근무 중' : `퇴근${finishing ? `, 진행 중인 ${finishing}건은 마저 끝냅니다` : ''}`}</span>
  </button>;
}
