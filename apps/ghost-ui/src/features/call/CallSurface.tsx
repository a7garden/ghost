import { useLayoutEffect, useRef, type RefObject } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Ear, Mic, MicOff, Minimize2, PhoneOff, Speaker, Volume2, VolumeX } from 'lucide-react';
import type { Call, Ghost } from '@ghost/contract';
import { PresenceAvatar } from '../../components/agent';
import { Button } from '../../ui';
import { useNow } from '../time';
import { callScreenState, type AudioRoute, type CallLevels, type CallLine, type CallPhase } from './call-state';
import { TurnSignal } from './surface-signal';
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
  phase?: CallPhase;
  detail?: string;
  route?: AudioRoute;
};

const phaseLabel: Record<CallPhase, string> = {
  listening: '말씀을 기다리는 중',
  hearing: '듣는 중',
  transcribing: '받아쓰는 중',
  thinking: '생각 중',
  working: '작업 중',
  speaking: '말하는 중',
};

function useCallStatus(view: SurfaceState | null, call?: Call) {
  const now = useNow(1_000);
  const ended = view?.ended || call?.status === 'ended';
  const state = callScreenState({ ...view, call, now, ending: !ended && view?.ending });
  const terminal = state.kind === 'ended' || state.kind === 'failed';
  const phase = view?.ready && !terminal && !view.ending && !view.resume ? view.phase : undefined;
  const unblock = !terminal && view?.audioBlocked && !view.speakerMuted;
  return { state, terminal, phase, unblock };
}

export function CallCapsule({ ghost, call, view, capsule, onOpen }: {
  ghost: Pick<Ghost, 'id' | 'name'>;
  call?: Call;
  view: SurfaceState | null;
  capsule: RefObject<HTMLButtonElement | null>;
  onOpen(button: HTMLButtonElement): void;
}) {
  const { state, phase, unblock } = useCallStatus(view, call);
  const timed = state.kind === 'timer';
  const label = unblock && timed ? '음성 재생 대기' : phase ? phaseLabel[phase] : timed ? null : state.text;
  return <div className="voice-call-capsule">
    <button type="button" ref={capsule} onClick={event => onOpen(event.currentTarget)} title="통화 열기">
      <span className="sr-only">통화 열기: </span>
      <PresenceAvatar ghostId={ghost.id} state="idle" size={26}/>
      <span className="voice-call-capsule__identity">
        <span className="voice-call-capsule__name">{ghost.name}</span>
        {label && <span className="voice-call-capsule__state" data-kind={state.kind} data-phase={unblock ? undefined : phase}
          data-attention={unblock || (state.kind === 'working' && view?.resume) || undefined}>{label}</span>}
      </span>
      {timed && <span className="voice-call-clock">{state.text}</span>}
      <ArrowUpRight size={16} aria-hidden="true"/>
    </button>
  </div>;
}

function CallTranscript({ lines, ghostName }: { lines: CallLine[]; ghostName: string }) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [lines]);

  return <div className="voice-call-screen__transcript" ref={scroll} role="region" aria-label="통화 자막" tabIndex={0}
    onScroll={({ currentTarget: node }) => { following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24; }}>
    {lines.length > 0 && <ol className="voice-call-transcript" role="list">
      {lines.map(line => <li key={line.id} className="voice-call-line" data-speaker={line.speaker} data-live={line.live || undefined}>
        <span className="sr-only">{line.speaker === 'owner' ? '나: ' : `${ghostName}: `}</span>
        <p>{line.text}</p>
      </li>)}
    </ol>}
  </div>;
}

export function CallSurface({ ghost, call, lines, view, minimized, remote, opener, capsule, meter, onMinimize, onResume, onUnblockAudio, onMic, onSpeaker, onRoute, onEnd }: {
  ghost: Pick<Ghost, 'id' | 'name'>;
  call?: Call;
  lines: CallLine[];
  view: SurfaceState | null;
  minimized: boolean;
  remote: boolean;
  opener: RefObject<HTMLElement | null>;
  capsule: RefObject<HTMLButtonElement | null>;
  meter: () => CallLevels;
  onMinimize(): void;
  onResume(): void;
  onUnblockAudio(): void;
  onMic(): void;
  onSpeaker(): void;
  onRoute(): void;
  onEnd(): void;
}) {
  const { state, terminal, phase: localPhase, unblock } = useCallStatus(view, call);
  const phase = remote ? undefined : localPhase;
  const heading = useRef<HTMLHeadingElement>(null);
  const localControls = !terminal && view?.ready;
  const resume = !terminal && view?.resume;
  const showRemote = remote && !terminal;
  const timed = state.kind === 'timer';
  const heroText = showRemote && timed ? '다른 화면에서 통화 중'
    : unblock && timed ? '음성 재생 대기'
    : phase ? phaseLabel[phase]
    : timed ? null
    : state.text;
  const signal = resume ? 'awaiting-input'
    : unblock ? 'awaiting-output'
    : phase ?? (state.kind === 'working' && !view?.ending ? 'connecting' : 'quiet');

  return <Dialog.Root open={!minimized}>
    <Dialog.Portal>
      <Dialog.Overlay className="voice-call-scrim"/>
      <Dialog.Content className="voice-call-screen" aria-modal="true" aria-describedby={undefined}
        onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          window.requestAnimationFrame(() => {
            const trigger = capsule.current?.isConnected ? capsule.current : opener.current;
            (trigger?.isConnected ? trigger : document.getElementById('main-content'))?.focus();
          });
        }}
        onPointerDownOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { event.preventDefault(); if (terminal) onEnd(); else onMinimize(); }}>
        <header className="voice-call-screen__header">
          <PresenceAvatar ghostId={ghost.id} state="idle" size={34}/>
          <Dialog.Title className="voice-call-screen__name" tabIndex={-1} ref={heading}>{ghost.name}</Dialog.Title>
          {timed && heroText && <span className="voice-call-clock" role="timer" aria-label="통화 시간">{state.text}</span>}
          {phase && !timed && <span className="voice-call-screen__header-state" role="status">{state.text}</span>}
          {!terminal && <Button type="button" variant="ghost" size="icon" aria-label="통화 최소화" title="통화 최소화" onClick={onMinimize}>
            <Minimize2 className="size-[18px]" aria-hidden="true"/>
          </Button>}
        </header>
        <div className="voice-call-screen__stage" data-empty={lines.length === 0 || undefined}>
          <div className="voice-call-turn" data-turn={signal}>
            <TurnSignal mode={signal} meter={meter}/>
            {state.kind === 'failed'
              ? <p className="voice-call-turn__error" role="alert">{state.text}</p>
              : heroText
                ? <div className="voice-call-turn__status" role="status" aria-atomic="true">
                  <span className="voice-call-turn__label" key={heroText}>{heroText}</span>
                  {phase === 'working' && !unblock && view?.detail && <code className="voice-call-turn__detail">{view.detail}</code>}
                  {showRemote && !timed && <p className="voice-call-turn__note">다른 화면에서 통화 중</p>}
                </div>
                : <span className="voice-call-clock" role="timer" aria-label="통화 시간">{state.text}</span>}
          </div>
          <CallTranscript lines={lines} ghostName={ghost.name}/>
        </div>
        <div className="voice-call-screen__actions" role="group" aria-label="통화 도구">
          {(localControls || resume || unblock) && <div className="voice-call-screen__tools">
            {localControls && <div className="voice-call-screen__devices">
              <Button type="button" variant="ghost" size="icon" aria-label="마이크 끄기" title={view.micMuted ? '마이크 켜기' : '마이크 끄기'} aria-pressed={Boolean(view.micMuted)} onClick={onMic}>
                {view.micMuted ? <MicOff className="size-5" aria-hidden="true"/> : <Mic className="size-5" aria-hidden="true"/>}
              </Button>
              <Button type="button" variant="ghost" size="icon" aria-label="스피커 끄기" title={view.speakerMuted ? '스피커 켜기' : '스피커 끄기'} aria-pressed={Boolean(view.speakerMuted)} onClick={onSpeaker}>
                {view.speakerMuted ? <VolumeX className="size-5" aria-hidden="true"/> : <Volume2 className="size-5" aria-hidden="true"/>}
              </Button>
              {view.route !== undefined && <Button type="button" variant="ghost" size="icon" aria-label="스피커폰" aria-pressed={view.route === 'speaker'}
                title={view.route === 'speaker' ? '수화기로 전환' : '스피커폰으로 전환'} onClick={onRoute}>
                {view.route === 'speaker' ? <Speaker className="size-5" aria-hidden="true"/> : <Ear className="size-5" aria-hidden="true"/>}
              </Button>}
            </div>}
            {(resume || unblock) && <div className="voice-call-screen__recovery">
              {resume && <Button type="button" variant="outline" onClick={onResume}>마이크 연결</Button>}
              {unblock && <Button type="button" variant="outline" onClick={onUnblockAudio}>음성 재생</Button>}
            </div>}
          </div>}
          <Button className={terminal ? 'voice-call-screen__end' : 'voice-call-screen__end bg-danger text-raised hover:bg-danger/88'} type="button"
            variant={terminal ? 'default' : 'destructive'} size="lg" disabled={!terminal && view?.ending}
            aria-label={terminal ? '통화 화면 닫기' : undefined} onClick={onEnd}>
            {!terminal && <PhoneOff className="size-[18px]" aria-hidden="true"/>}
            {terminal ? '닫기' : '통화 끊기'}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
