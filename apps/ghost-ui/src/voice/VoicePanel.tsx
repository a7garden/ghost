import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, Square, X } from 'lucide-react';
import { VoiceController } from './controller';
import type { VoiceReply, VoiceState } from './controller';
import { BrowserVoiceCapture, BrowserVoiceOutput } from './media';
import { createLocalVoiceTransport } from './transport';
import { bindVoiceCallbacks } from './boundCallbacks';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor } from '../client/types';
import './voice.css';

export type VoiceCallProps = { profileId: string; conversationId: string; profileName: string; enabled: boolean; disabledReason?: string; runningTasks: number; latestReply?: VoiceReply; submitTranscript(text: string): Promise<void>; cancelWork(): Promise<void>; onSpeakingChange?(speaking: boolean): void };
const initial: VoiceState = { phase: 'idle', active: false, muted: false, speaking: false, capturing: false, pendingTurns: 0, runningTasks: 0, transcript: '', error: '' };
export const voicePhaseLabel = (state: VoiceState) => state.phase === 'working' && 'preparingSpeech' in state && state.preparingSpeech ? '음성을 준비하고 있어요' : ({ idle: '통화 준비', connecting: '연결 중…', listening: '듣고 있어요', transcribing: '말씀을 확인하고 있어요', working: '생각 중…', speaking: '말하는 중…', muted: '마이크 꺼짐', error: '연결 확인 필요' }[state.phase]);

// The conversation owns this hook once. Moving or collapsing its card never
// acquires another microphone or tears down an existing audio session.
export function useVoiceCall(props: VoiceCallProps) {
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
export type VoiceCall = ReturnType<typeof useVoiceCall>;

export function VoicePanel({ call, profileId, profileName, enabled, disabledReason, runningTasks, onDismiss }: { call: VoiceCall; profileId?: string; profileName: string; enabled: boolean; disabledReason?: string; runningTasks: number; onDismiss(): void }) {
  const { state } = call;
  const connecting = state.phase === 'connecting', live = state.active || connecting;
  const ended = call.attempted && state.phase === 'idle';
  return <section className={`context-card voice-panel ${live ? 'voice-active' : ''}`} aria-label={`${profileName}와 음성 통화`}>
    <div className="voice-card-header"><div className="voice-card-identity"><DotAvatar profileId={profileId ?? profileName} tone={toneFor(profileId ?? profileName)} size={32}/><span className="voice-identity"><strong>{profileName}</strong><span role="status">{ended ? '통화 종료됨' : voicePhaseLabel(state)}</span></span></div>{!live && <button type="button" className="icon-button small" aria-label="음성 통화 카드 닫기" onClick={onDismiss}><X size={15}/></button>}</div>

    <div className="voice-actions">{live ? <><button type="button" className="icon-button" aria-label={state.muted ? '마이크 켜기' : '마이크 끄기'} aria-pressed={state.muted} disabled={connecting} onClick={call.mute}>{state.muted ? <MicOff size={17}/> : <Mic size={17}/>}</button><button type="button" className="button secondary voice-end" aria-label={connecting ? '연결 취소' : '통화 종료'} title={connecting ? '연결 취소' : '통화 종료'} onClick={call.end}><Phone size={17} className="voice-hangup"/></button></> : <button type="button" className="button secondary" disabled={!enabled} onClick={call.start}><Phone size={15}/>{state.error ? '다시 연결' : ended ? '다시 통화' : '통화 시작'}</button>}</div>
    <div className="voice-card-body">{state.transcript && <p className="voice-transcript"><span>내가 한 말</span>{state.transcript}</p>}{state.error && <p className="voice-error" role="alert">{state.error}</p>}{!live && !ended && <p className="voice-help">{!enabled ? disabledReason ?? 'Ghost 설정에서 음성 사용을 허용해 주세요.' : '통화 시작을 누르면 로컬 음성 모델 연결 후 마이크를 엽니다.'}</p>}{state.active && runningTasks > 0 && <button type="button" className="context-card-action voice-cancel-work" onClick={call.cancelWork}><Square size={13}/>작업 취소</button>}</div>
  </section>;
}
