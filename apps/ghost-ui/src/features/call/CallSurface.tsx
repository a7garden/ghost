import { useEffect, useRef, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Mic, MicOff, Minimize2, Phone, PhoneOff, Volume2, VolumeX, X } from 'lucide-react';
import type { Call, Ghost } from '@ghost/contract';
import { PresenceAvatar } from '../../components/agent';
import { Button } from '../../ui';
import { useNow } from '../time';
import { callScreenState, isLiveCall } from './call-state';
import type { Captions } from './media';
import './call.css';

type SurfaceState = {
  error?: string;
  ending?: boolean;
  ended?: boolean;
  resume?: boolean;
  ready?: boolean;
  micMuted?: boolean;
  speakerMuted?: boolean;
  audioBlocked?: boolean;
};

export function CallCapsule({ ghost, call, view, capsule, onOpen }: {
  ghost: Pick<Ghost, 'id' | 'name'>;
  call?: Call;
  view: SurfaceState | null;
  capsule: RefObject<HTMLButtonElement | null>;
  onOpen(button: HTMLButtonElement): void;
}) {
  const now = useNow(1_000);
  const state = callScreenState({ ...view, call, now });
  return <div className="voice-call-capsule">
    <button type="button" ref={capsule} onClick={event => onOpen(event.currentTarget)} aria-label={`${ghost.name} 통화 열기`} title="통화 열기">
      <PresenceAvatar ghostId={ghost.id} state="idle" size={24}/>
      <span className="voice-call-capsule__name">{ghost.name}</span>
      <span className="voice-call-capsule__state" data-kind={state.kind}>{state.text}</span>
      <Phone size={15} aria-hidden="true"/>
    </button>
  </div>;
}

export function CallSurface({ ghost, call, captions, view, minimized, remote, opener, capsule, onMinimize, onResume, onUnblockAudio, onMic, onSpeaker, onEnd }: {
  ghost: Pick<Ghost, 'id' | 'name'>;
  call?: Call;
  captions: Captions;
  view: SurfaceState | null;
  minimized: boolean;
  remote: boolean;
  opener: RefObject<HTMLElement | null>;
  capsule: RefObject<HTMLButtonElement | null>;
  onMinimize(): void;
  onResume(): void;
  onUnblockAudio(): void;
  onMic(): void;
  onSpeaker(): void;
  onEnd(): void;
}) {
  const now = useNow(1_000);
  const state = callScreenState({ ...view, call, now });
  const terminal = view?.ended || Boolean(call && !isLiveCall(call));
  const heading = useRef<HTMLHeadingElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [captions, minimized]);

  return <Dialog.Root open={!minimized}>
      <Dialog.Portal>
        <Dialog.Overlay className="voice-call-scrim"/>
        <Dialog.Content className="voice-call-screen" aria-modal="true" aria-describedby={undefined}
          onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            window.requestAnimationFrame(() => {
              const trigger = capsule.current ?? opener.current;
              (trigger?.isConnected ? trigger : document.getElementById('main-content'))?.focus();
            });
          }}
          onPointerDownOutside={event => event.preventDefault()}
          onEscapeKeyDown={event => { event.preventDefault(); if (terminal) onEnd(); else onMinimize(); }}>
          <header className="voice-call-screen__header">
            {!terminal && <Button className="voice-call-screen__minimize" type="button" variant="ghost" size="icon" aria-label="통화 최소화" title="통화 최소화" onClick={onMinimize}><Minimize2 aria-hidden="true"/></Button>}
            <PresenceAvatar ghostId={ghost.id} state="idle" size={80}/>
            <Dialog.Title className="voice-call-screen__name" tabIndex={-1} ref={heading}>{ghost.name}</Dialog.Title>
            <p key={state.kind} className="voice-call-screen__state" data-kind={state.kind} role={state.kind === 'failed' ? 'alert' : state.kind === 'timer' ? 'timer' : 'status'}>{state.text}</p>
            {remote && !terminal && <p role="status" className="voice-call-screen__remote">다른 화면에서 통화 중</p>}
          </header>
          <div className="voice-call-screen__captions" ref={transcript} aria-label="통화 자막" tabIndex={captions.owner || captions.ghost ? 0 : undefined}>
            {captions.owner && <div className="voice-call-caption" data-speaker="owner"><span>나</span><p>{captions.owner}</p></div>}
            {captions.ghost && <div className="voice-call-caption" data-speaker="ghost"><span>{ghost.name}</span><p>{captions.ghost}</p></div>}
          </div>
          <div className="voice-call-screen__actions" role="group" aria-label="통화 도구">
            {view?.resume && <Button type="button" variant="outline" onClick={onResume}>마이크 연결</Button>}
            {view?.audioBlocked && !terminal && !view.speakerMuted && <Button type="button" variant="outline" onClick={onUnblockAudio}>음성 재생</Button>}
            {view?.ready && !terminal && <>
              <Button type="button" variant="ghost" size="icon" aria-label="마이크 끄기" title={view.micMuted ? '마이크 켜기' : '마이크 끄기'} aria-pressed={Boolean(view.micMuted)} onClick={onMic}>
                {view.micMuted ? <MicOff aria-hidden="true"/> : <Mic aria-hidden="true"/>}
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label="스피커 끄기" title={view.speakerMuted ? '스피커 켜기' : '스피커 끄기'} aria-pressed={Boolean(view.speakerMuted)} onClick={onSpeaker}>
                {view.speakerMuted ? <VolumeX aria-hidden="true"/> : <Volume2 aria-hidden="true"/>}
              </Button>
            </>}
            <Button className="voice-call-screen__end" type="button" variant={terminal ? 'ghost' : 'outline'} size="icon"
              disabled={!terminal && view?.ending} aria-label={terminal ? '통화 화면 닫기' : '통화 끊기'} title={terminal ? '닫기' : '통화 끊기'} onClick={onEnd}>
              {terminal ? <X aria-hidden="true"/> : <PhoneOff aria-hidden="true"/>}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
  </Dialog.Root>;
}
