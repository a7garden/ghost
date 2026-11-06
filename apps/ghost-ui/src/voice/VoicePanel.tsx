import { useEffect, useRef, useState } from 'react';
import { Button, cn } from '@garden/ui';
import { Mic, MicOff, Phone, Square, X } from 'lucide-react';
import { VoiceController } from './controller';
import type { VoiceReply, VoiceState } from './controller';
import { BrowserVoiceCapture, BrowserVoiceOutput } from './media';
import { createLocalVoiceTransport } from './transport';
import { bindVoiceCallbacks } from './boundCallbacks';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';

export type VoiceCallProps = { profileId: string; conversationId: string; profileName: string; enabled: boolean; disabledReason?: string; runningTasks: number; latestReply?: VoiceReply; submitTranscript(text: string): Promise<void>; cancelWork(): Promise<void>; onSpeakingChange?(speaking: boolean): void };
const initial: VoiceState = { phase: 'idle', active: false, muted: false, speaking: false, capturing: false, pendingTurns: 0, runningTasks: 0, transcript: '', error: '' };
export const voicePhaseLabel = (state: VoiceState) => state.phase === 'working' && 'preparingSpeech' in state && state.preparingSpeech ? '음성을 준비하고 있어요' : ({ idle: '통화 준비', connecting: '연결 중…', listening: '듣고 있어요', transcribing: '말씀을 확인하고 있어요', working: '생각 중…', speaking: '말하는 중…', muted: '마이크 꺼짐', error: '연결 확인 필요' }[state.phase]);

// The conversation owns this hook once. Moving or collapsing its card never
// acquires another microphone or tears down an existing audio session.
export interface VoiceCall {
  state: VoiceState;
  attempted: boolean;
  start(): void;
  end(): void;
  mute(): void;
  cancelWork(): void;
}
export function useVoiceCall(props: VoiceCallProps): VoiceCall {
  const current = useRef(props); current.current = props;
  const controller = useRef<VoiceController | null>(null), seenReply = useRef(props.latestReply?.id);
  const [state, setState] = useState(initial), [attempted, setAttempted] = useState(false);
  useEffect(() => {
    setState(initial); setAttempted(false); seenReply.current = current.current.latestReply?.id;
    const instance = new VoiceController(createLocalVoiceTransport(props.profileId, props.conversationId), new BrowserVoiceCapture(), new BrowserVoiceOutput(), bindVoiceCallbacks({ profileId: props.profileId, conversationId: props.conversationId }, () => current.current, setState));
    controller.current = instance;
    const stop = () => instance.end(); window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); instance.end(); controller.current = null; };
  }, [props.profileId, props.conversationId]);
  useEffect(() => { controller.current?.setRunningTasks(props.runningTasks); }, [props.runningTasks, props.profileId, props.conversationId]);
  useEffect(() => { if (!props.enabled) controller.current?.end(); }, [props.enabled]);
  useEffect(() => {
    const reply = props.latestReply;
    if (!reply || seenReply.current === reply.id) return;
    seenReply.current = reply.id;
    if (state.active) void controller.current?.speak(reply);
  }, [props.latestReply?.id, state.active]);
  return {
    state, attempted,
    start: () => { if (!current.current.enabled || !current.current.conversationId) return; setAttempted(true); void controller.current?.start(); },
    end: () => controller.current?.end(),
    mute: () => controller.current?.mute(!controller.current.state.muted),
    cancelWork: () => void controller.current?.cancelWork(),
  };
}

export function VoicePanel({ call, profileId, profileName, enabled, disabledReason, runningTasks, onDismiss }: { call: VoiceCall; profileId?: string; profileName: string; enabled: boolean; disabledReason?: string; runningTasks: number; onDismiss(): void }) {
  const { state } = call;
  const connecting = state.phase === 'connecting', live = state.active || connecting;
  const ended = call.attempted && state.phase === 'idle';
  return <section className={cn('flex flex-col overflow-hidden rounded-card bg-surface text-ui shadow-card')} aria-label={`${profileName}와 음성 통화`}>
    <div className="flex min-h-[52px] items-center pr-2.5 pl-3"><div className="flex min-w-0 min-h-[52px] flex-1 items-center gap-2.5 py-3 text-left"><DotAvatar profileId={profileId ?? profileName} tone={toneFor(profileId ?? profileName)} size={32}/><span className="grid min-w-0 flex-1 gap-0.5 leading-tight"><strong className="whitespace-nowrap text-ui font-medium text-ink">{profileName}</strong><span className="min-w-0 truncate text-caption text-ink-2" role="status">{ended ? '통화 종료됨' : voicePhaseLabel(state)}</span></span></div>{!live && <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="음성 통화 카드 닫기" onClick={onDismiss}><X size={15}/></Button>}</div>

    <div className={cn('flex flex-wrap items-center gap-2 px-3 pb-3', live && 'grid grid-cols-2 flex-nowrap')}>{live ? <><Button type="button" variant="secondary" size="icon" aria-label={state.muted ? '마이크 켜기' : '마이크 끄기'} aria-pressed={state.muted} disabled={connecting} onClick={call.mute}>{state.muted ? <MicOff size={17}/> : <Mic size={17}/>}</Button><Button type="button" variant="destructive" className="min-w-0 flex-1" aria-label={connecting ? '연결 취소' : '통화 종료'} title={connecting ? '연결 취소' : '통화 종료'} onClick={call.end}><Phone size={17} className="rotate-[135deg]"/></Button></> : <Button type="button" variant="secondary" className="min-w-0 flex-1" disabled={!enabled} onClick={call.start}><Phone size={15}/>{state.error ? '다시 연결' : ended ? '다시 통화' : '통화 시작'}</Button>}</div>
    <div className={cn('grid gap-2.5 px-3 pb-3 empty:hidden')}>{state.transcript && <p className="m-0 line-clamp-3 text-ui leading-relaxed [overflow-wrap:anywhere]"><span className="block text-caption text-ink-2">내가 한 말</span>{state.transcript}</p>}{state.error && <p className="m-0 text-caption leading-relaxed text-red" role="alert">{state.error}</p>}{!live && !ended && <p className="m-0 text-caption leading-relaxed text-ink-2">{!enabled ? disabledReason ?? 'Ghost 설정에서 음성 사용을 허용해 주세요.' : '통화 시작을 누르면 로컬 음성 모델 연결 후 마이크를 엽니다.'}</p>}{state.active && runningTasks > 0 && <Button type="button" variant="ghost" size="sm" className="-ml-2 justify-self-start text-ink-2 hover:text-ink" onClick={call.cancelWork}><Square size={13}/>작업 취소</Button>}</div>
  </section>;
}
