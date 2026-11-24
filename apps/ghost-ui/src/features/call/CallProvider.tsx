import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_VOICE, type Call, type CallEngine, type Ghost } from '@ghost/contract';
import { HostError } from '../../host/client';
import { useActiveCall, useCalls } from '../../host/calls';
import { useHost } from '../../host/context';
import { shell, shellCall } from '../../host/shell';
import type { Connection } from '../../host/store';
import { callPhase, callScreenState, isLiveCall, type AudioRoute, type CallLine, type CallPhase, type GhostWork } from './call-state';
import { connectLocal, prepareLocalAudio, type LocalAudio } from './local-engine';
import { LineBook } from './lines';
import { SILENT } from './levels';
import { errorMessage, openMicrophone, type CallMedia, type MediaOptions } from './media';
import { connectRealtime } from './realtime-engine';
import { CallCapsule, CallSurface } from './CallSurface';

type Target = Pick<Ghost, 'id' | 'name' | 'directConversationId'>;
type EndIntent = { error?: string; dismiss?: boolean };
type Attempt = {
  ghost: Target;
  engine: CallEngine;
  startedAt: number;
  controller: AbortController;
  id?: string;
  endRequestId?: string;
  end?: EndIntent;
  sendingEnd?: boolean;
  remote?: boolean;
  media?: CallMedia;
};
type View = {
  attempt: Attempt;
  lines: CallLine[];
  phase?: CallPhase;
  detail?: string;
  error?: string;
  ending?: boolean;
  ended?: boolean;
  resume?: boolean;
  ready?: boolean;
  micMuted?: boolean;
  speakerMuted?: boolean;
  audioBlocked?: boolean;
};

type CallActions = {
  start(ghost: Ghost, opener: HTMLElement): void;
  occupied: boolean;
  unavailable: Partial<Record<CallEngine, string>>;
};
const CallContext = createContext<CallActions | null>(null);
const OWN_CALL = 'ghost.call.media';
const ROUTE = 'ghost.call.route';

function rememberedCall(id?: string | null): string | null {
  try {
    if (id === null) sessionStorage.removeItem(OWN_CALL);
    else if (id !== undefined) sessionStorage.setItem(OWN_CALL, id);
    return sessionStorage.getItem(OWN_CALL);
  } catch {
    return null; // A shell that blocks storage cannot reclaim this tab's media after a reload.
  }
}

/** A phone is held to the ear first; the owner's last choice sticks. */
function rememberedRoute(route?: AudioRoute): AudioRoute {
  try {
    if (route) localStorage.setItem(ROUTE, route);
    return localStorage.getItem(ROUTE) === 'speaker' ? 'speaker' : 'receiver';
  } catch {
    return route ?? 'receiver';
  }
}

export function useCallActions() {
  return useContext(CallContext);
}

/** Kept above navigation so minimizing, opening a thread, or changing sections never drops media. */
export function CallProvider({ children, ghosts, engine, connection }: {
  children(callTray: ReactNode): ReactNode;
  ghosts: Ghost[];
  engine?: CallEngine;
  connection: Connection;
}) {
  const { client, store } = useHost();
  const calls = useCalls();
  const active = useActiveCall();
  const [view, setView] = useState<View | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [unavailable, setUnavailable] = useState<CallActions['unavailable']>({});
  // Undefined until the native shell accepts the route: a Mac or a browser has no earpiece to choose.
  const [route, setRoute] = useState<AudioRoute | undefined>();
  const current = useRef<Attempt | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const resumeButton = useRef<HTMLButtonElement | null>(null);
  const call = view?.attempt.id ? calls.find(item => item.id === view.attempt.id) : undefined;
  const meter = useCallback(() => current.current?.media?.levels() ?? SILENT, []);

  function patch(attempt: Attempt, next: Partial<View>) {
    setView(previous => previous?.attempt === attempt ? { ...previous, ...next } : previous);
  }

  function dismiss(attempt: Attempt) {
    if (current.current !== attempt) return;
    current.current = null;
    setView(null);
    setMinimized(false);
  }

  function sendEnd(attempt: Attempt) {
    const { id } = attempt;
    if (!id || attempt.sendingEnd) return;
    attempt.sendingEnd = true;
    patch(attempt, { ending: true });
    const requestId = attempt.endRequestId ??= crypto.randomUUID();
    void client.endCall(id, requestId, true).then(() => {
      if (rememberedCall() === id) rememberedCall(null);
      if (attempt.end?.dismiss) dismiss(attempt);
      else patch(attempt, { ending: false, ended: true });
    }, reason => {
      attempt.sendingEnd = false;
      const latest = store.get().state?.calls?.find(item => item.id === id);
      if (latest && !isLiveCall(latest)) return;
      patch(attempt, { ending: false, error: errorMessage(reason, '통화를 끝내지 못했습니다.') });
      setMinimized(false);
    });
  }

  function end(attempt: Attempt, intent: EndIntent = {}) {
    attempt.end ??= intent;
    attempt.controller.abort();
    if (intent.error) {
      patch(attempt, { error: intent.error, ready: false, resume: false });
      setMinimized(false);
    } else patch(attempt, { ready: false, resume: false });
    // If call.start is still in flight, its receipt will supply the id and run this same end once.
    sendEnd(attempt);
  }

  function attach(attempt: Attempt, id: string, stream: MediaStream, audio: AudioContext | undefined, existing: Call | undefined) {
    const { signal } = attempt.controller;
    signal.throwIfAborted();
    const options: MediaOptions = {
      call: existing ?? { id, conversationId: attempt.ghost.directConversationId, startedAt: attempt.startedAt, endedAt: null },
      client, store, signal,
      lines: new LineBook(lines => patch(attempt, { lines })),
      failed: error => { if (!signal.aborted) end(attempt, { error }); },
      // Give the sideband's final status and metering priority over a client hangup.
      ended: () => {
        patch(attempt, { ending: true, ready: false });
        const timeout = window.setTimeout(() => { if (!signal.aborted) end(attempt); }, 2_000);
        signal.addEventListener('abort', () => window.clearTimeout(timeout), { once: true });
      },
      audioBlocked: blocked => patch(attempt, { audioBlocked: blocked }),
    };
    const media = audio ? connectLocal(stream, audio, options) : connectRealtime(stream, options);
    attempt.media = media;
    // Collect no owner speech until setup and the Host's activation are confirmed.
    media.setMicMuted(true);
    void media.connected.then(async () => {
      if (signal.aborted) return;
      if (!existing || existing.status === 'connecting') await client.activateCall(id);
      if (signal.aborted) return;
      media.setMicMuted(false);
      patch(attempt, { ready: true });
    }).catch(reason => options.failed(errorMessage(reason, '음성 연결을 시작하지 못했습니다.')));
  }

  function prepare(attempt: Attempt, admission: Promise<{ callId: string }>, existing?: Call) {
    const { signal } = attempt.controller;
    // Both calls are initiated in the tap, before waiting for the network or a permission prompt.
    let local: LocalAudio | undefined;
    let microphone: Promise<MediaStream>;
    try {
      if (attempt.engine === 'local') local = prepareLocalAudio(signal);
      microphone = openMicrophone(signal);
    } catch (reason) { microphone = Promise.reject(reason); }
    const accepted = admission.then(({ callId }) => {
      attempt.id = callId;
      if (!existing) setUnavailable(previous => ({ ...previous, [attempt.engine]: undefined }));
      if (attempt.end) sendEnd(attempt);
      else {
        rememberedCall(callId);
        patch(attempt, {});
      }
      return callId;
    }, reason => {
      if (reason instanceof HostError && reason.code === 'unavailable') {
        setUnavailable(previous => ({ ...previous, [attempt.engine]: reason.message }));
      }
      throw reason;
    });
    const permission = Promise.all([microphone, local?.resumed]).catch(reason => {
      if (!signal.aborted) end(attempt, { error: errorMessage(reason, '음성 연결을 시작하지 못했습니다.') });
      throw reason;
    });
    void Promise.all([accepted, permission]).then(([id, [stream]]) => {
      if (!signal.aborted) attach(attempt, id, stream, local?.context, existing);
    }).catch(reason => {
      if (!signal.aborted) end(attempt, { error: errorMessage(reason, '전화를 걸지 못했습니다.') });
    });
    void accepted.catch(reason => {
      if (attempt.end?.dismiss) dismiss(attempt);
      else patch(attempt, { error: errorMessage(reason, '전화를 걸지 못했습니다.'), ending: false, ended: true });
    });
  }

  function start(ghost: Ghost, trigger: HTMLElement) {
    if (current.current || store.get().state?.calls?.some(isLiveCall)) return;
    const chosen = engine ?? DEFAULT_VOICE.engine;
    const attempt: Attempt = { ghost, engine: chosen, startedAt: Date.now(), controller: new AbortController() };
    current.current = attempt;
    opener.current = trigger;
    setView({ attempt, lines: [] });
    setMinimized(false);
    prepare(attempt, client.startCall(ghost.id, chosen));
  }

  function fromCall(live: Call): Attempt {
    const ghost = ghosts.find(item => item.id === live.ghostId) ?? {
      id: live.ghostId, name: 'Ghost', directConversationId: live.conversationId,
    };
    return { ghost, id: live.id, engine: live.engine, startedAt: live.startedAt, controller: new AbortController() };
  }

  // Only this tab's remembered call is ours to recover. A fresh tab must not close the owner's other device.
  useEffect(() => {
    if (connection !== 'live' || current.current) return;
    const owned = rememberedCall();
    if (!owned) return;
    const live = calls.find(item => item.id === owned);
    if (!live || !isLiveCall(live)) { rememberedCall(null); return; }
    const attempt = fromCall(live);
    current.current = attempt;
    setMinimized(false);
    if (live.engine === 'local') setView({ attempt, lines: [], resume: true });
    else {
      setView({ attempt, lines: [] });
      end(attempt, { error: '이전 음성 연결을 복원할 수 없습니다.' });
    }
    // A fresh Host connection, not the cached snapshot, can authorize recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, calls]);

  useEffect(() => {
    if (!view || !call || isLiveCall(call)) return;
    const { attempt } = view;
    attempt.controller.abort();
    if (rememberedCall() === call.id) rememberedCall(null);
    if (attempt.end?.dismiss && call.status !== 'failed') dismiss(attempt);
    else {
      patch(attempt, { ended: true, ending: false, resume: false, ready: false });
      if (call.status === 'failed') setMinimized(false);
    }
    // The ledger's terminal transition, not updates to the view, runs the cleanup once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call]);

  // The phase the screen shows: what the audio is doing, else what the Ghost's run is doing.
  const phaseAttempt = view?.ready ? view.attempt : undefined;
  useEffect(() => {
    const media = phaseAttempt?.media;
    if (!phaseAttempt || !media) return;
    let work: GhostWork = { running: false };
    const unwatch = store.watchConversation(phaseAttempt.ghost.directConversationId, event => {
      if (event.type !== 'live') return;
      const tool = event.live.running ? event.live.tools.at(-1)?.name : undefined;
      work = { running: event.live.running, ...(tool ? { tool } : {}) };
    });
    const tick = () => {
      const next = callPhase(media.activity(), work);
      setView(previous => previous?.attempt === phaseAttempt && (previous.phase !== next.phase || previous.detail !== next.detail)
        ? { ...previous, phase: next.phase, detail: next.detail } : previous);
    };
    tick();
    const timer = window.setInterval(tick, 120);
    return () => {
      window.clearInterval(timer);
      unwatch();
    };
  }, [phaseAttempt, store]);

  // While a call is up: the display stays awake, and on an iPhone the voice comes out of the earpiece or the speaker.
  const routed = view?.ready && !view.attempt.remote;
  useEffect(() => {
    if (!routed) return;
    let released = false;
    let lock: WakeLockSentinel | undefined;
    void navigator.wakeLock?.request('screen').then(sentinel => {
      if (released) void sentinel.release().catch(() => {}); else lock = sentinel;
    }, () => {});
    if (shell) {
      const wanted = rememberedRoute();
      shellCall({ type: 'audio.route', route: wanted }).then(() => { if (!released) setRoute(wanted); }, () => {});
    }
    return () => {
      released = true;
      void lock?.release().catch(() => {});
      if (shell) {
        setRoute(undefined);
        shellCall({ type: 'audio.route', route: 'off' }).catch(() => {});
      }
    };
  }, [routed]);

  useEffect(() => {
    const pagehide = () => {
      const attempt = current.current;
      if (attempt && !attempt.remote && !attempt.end && !attempt.controller.signal.aborted) {
        end(attempt, { error: '화면을 벗어나 통화가 종료되었습니다.' });
      }
    };
    const visibility = () => { if (document.visibilityState === 'hidden') pagehide(); };
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', pagehide);
      document.removeEventListener('visibilitychange', visibility);
    };
    // Media and the hangup identity live in the attempt ref, not in a render closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const displayGhost = view?.attempt.ghost ?? (active && (ghosts.find(item => item.id === active.ghostId) ?? { id: active.ghostId, name: 'Ghost' }));
  const displayedCall = view ? call : active;
  const compacted = !view || minimized;
  const showForeign = (button: HTMLButtonElement) => {
    if (!active || current.current) return;
    opener.current = button;
    const attempt = fromCall(active);
    current.current = attempt;
    attempt.remote = true;
    setView({ attempt, lines: [] });
    setMinimized(false);
  };
  const tryResume = () => {
    if (!view?.resume || !call || !isLiveCall(call)) return;
    patch(view.attempt, { resume: false });
    prepare(view.attempt, Promise.resolve({ callId: call.id }), call);
  };
  const muted = (part: 'micMuted' | 'speakerMuted') => {
    if (!view?.attempt.media) return;
    const value = !view[part];
    if (part === 'micMuted') view.attempt.media.setMicMuted(value);
    else view.attempt.media.setSpeakerMuted(value);
    patch(view.attempt, { [part]: value });
  };
  const switchRoute = () => {
    if (!route) return;
    const next: AudioRoute = route === 'speaker' ? 'receiver' : 'speaker';
    // The chosen route shows only once the phone has taken it.
    shellCall({ type: 'audio.route', route: next }).then(() => { rememberedRoute(next); setRoute(next); }, () => {});
  };

  const surfaceView = view && { ...view, route };
  const callTray = compacted && displayGhost ? <CallCapsule ghost={displayGhost} call={displayedCall} view={surfaceView}
    capsule={resumeButton} onOpen={button => view ? setMinimized(false) : showForeign(button)}/> : null;

  return <CallContext.Provider value={{ start, occupied: Boolean(active || view), unavailable }}>
    {children(callTray)}
    {view && <CallSurface
      ghost={view.attempt.ghost} call={call} lines={view.lines} view={surfaceView} minimized={minimized}
      remote={Boolean(view.attempt.remote)} opener={opener} capsule={resumeButton} meter={meter}
      onMinimize={() => setMinimized(true)}
      onResume={tryResume} onUnblockAudio={() => view?.attempt.media?.resumeAudio?.()}
      onMic={() => muted('micMuted')} onSpeaker={() => muted('speakerMuted')} onRoute={switchRoute}
      onEnd={() => {
        const attempt = current.current;
        if (!attempt) return;
        const kind = callScreenState({ ...view, call, now: Date.now() }).kind;
        if (view?.ended || (call && !isLiveCall(call)) || kind === 'failed') { dismiss(attempt); return; }
        if (attempt.end) { sendEnd(attempt); return; }
        end(attempt, { dismiss: true });
        patch(attempt, { ending: true });
      }}/>}
  </CallContext.Provider>;
}
