import { useEffect, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import type { State, WorkDetail } from '@ghost/contract';
import { LifecycleTrack, StateGlyph, glyphLabel, workGlyph } from '../components/agent';
import { DotAvatar } from '../components/DotAvatar';
import { LiveReply, Transcript } from '../components/TranscriptMessage';
import { useHost } from '../host/context';
import { HostError } from '../host/client';
import { InlineError } from '../ui';
import { DecisionCard } from './Decision';
import { useConversationFeed } from './conversationFeed';
import { liveWork, toneFor } from './ghostState';
import { relativeTime, useNow } from './time';

const EXIT_FALLBACK_MS = 700;

/**
 * A thread opened beside the conversation it branched from: where it stands, what it asks of
 * the owner (resolved in place), its delegated threads, and the carrier's own work conversation,
 * live. The owner steers it through decisions; editing and cancelling stay on the full page.
 */
export function ThreadPanel({ workId, state, closing = false, onClosed, onClose, onOpenThread, onOpenPage }: {
  workId: string;
  state: State;
  /** The thread was closed: the panel plays its exit, then calls `onClosed` to unmount. */
  closing?: boolean;
  onClosed?(): void;
  onClose(): void;
  onOpenThread(id: string): void;
  onOpenPage(id: string): void;
}) {
  const { client, store } = useHost();
  const now = useNow();
  const [detail, setDetail] = useState<WorkDetail | null>(null);
  const [missing, setMissing] = useState(false);
  /** The last read failed for another reason than not-found: the previous detail stays on screen. */
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // The ledger row in the snapshot is current; the detail bundle adds children, decisions and effects.
  const work = state.works.find(item => item.id === workId) ?? detail?.work ?? null;
  useEffect(() => {
    let alive = true;
    // Reloads can overlap; only the newest response may replace the detail.
    let latest = 0;
    const load = () => {
      const ticket = ++latest;
      return client.work(workId).then(next => { if (alive && ticket === latest) { setDetail(next); setMissing(false); setLoadError(''); } })
        .catch((e: unknown) => {
          if (!alive || ticket !== latest) return;
          // Only the host saying the Work is gone means gone; a dropped connection is not.
          if (e instanceof HostError && e.code === 'not_found') { setMissing(true); setLoadError(''); }
          else setLoadError(e instanceof Error ? e.message : '스레드를 읽지 못했습니다.');
        });
    };
    void load();
    const stop = store.onLedgerEvent(event => {
      const data = event.data;
      const touched = data.type === 'work' && 'work' in data ? data.work.id === workId || data.work.parentId === workId
        : data.type === 'decision' && 'decision' in data ? data.decision.workId === workId : false;
      if (touched) void load();
    });
    return () => { alive = false; stop(); };
  }, [client, store, workId, attempt]);
  const { feed, loading } = useConversationFeed(work?.conversationId ?? null);
  useEffect(() => {
    // An open popover or dialog consumes Escape first (Radix marks it handled); Escape while typing belongs to the field.
    const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !closing && !event.defaultPrevented && !event.isComposing && !editable(event.target)) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose, closing]);
  // The exit normally ends on animationend; a panel that never animates (hidden, no CSS) still leaves.
  useEffect(() => {
    if (!closing || !onClosed) return;
    const timer = setTimeout(onClosed, EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [closing, onClosed]);

  const names = new Map(state.ghosts.map(ghost => [ghost.id, ghost.name]));
  const pending = (detail?.decisions ?? []).filter(decision => decision.state === 'pending');
  const children = detail?.children ?? [];
  const waiting = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  const carrier = work ? names.get(work.ghostId) ?? 'Ghost' : '';

  return <aside className="thread-panel" data-closing={closing || undefined} aria-label={work ? `스레드: ${work.title}` : '스레드'} aria-hidden={closing || undefined}
    onAnimationEnd={event => { if (closing && event.target === event.currentTarget) onClosed?.(); }}>
    <header className="thread-panel__head">
      {work && <StateGlyph state={workGlyph(work.state, pending.length > 0)}/>}
      <h2>{work?.title ?? (missing ? '스레드를 찾을 수 없습니다' : '스레드')}</h2>
      {work && <button type="button" className="shell-icon-button" aria-label="맡긴 일 전체 화면" title="전체 화면" onClick={() => onOpenPage(work.id)}><ArrowUpRight aria-hidden="true"/></button>}
      <button type="button" className="shell-icon-button" aria-label="스레드 닫기" title="닫기" onClick={onClose}><X aria-hidden="true"/></button>
    </header>
    {loadError && <InlineError className="mx-4 mb-2" onRetry={() => setAttempt(value => value + 1)} retryLabel="다시 시도">스레드를 새로 읽지 못했습니다 · {loadError}</InlineError>}
    {work && <div className="thread-panel__body">
      <div className="thread-panel__meta">
        <span className="work-head__who"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={16}/>{carrier}</span>
        <span>{glyphLabel[workGlyph(work.state, pending.length > 0)]}</span>
        <time className="tabular">{relativeTime(work.updatedAt, now)}</time>
      </div>
      <LifecycleTrack state={work.state} needsOwner={pending.length > 0}/>
      {work.reason && (work.state === 'failed' || work.state === 'blocked' || work.state === 'cancelled') && <p className="work-head__reason" data-state={work.state}>{work.reason}</p>}
      {pending.map(decision => <DecisionCard key={decision.id} decision={decision} ghostName={names.get(decision.ghostId) ?? 'Ghost'} workTitle={work.title} onResolved={() => undefined}/>)}
      {children.length > 0 && <section className="thread-panel__section">
        <h3 className="section-title">위임한 스레드</h3>
        {children.map(child => <button key={child.id} type="button" className="menu-row w-full" onClick={() => onOpenThread(child.id)}>
          <StateGlyph state={workGlyph(child.state, waiting.has(child.id))} size={15}/>
          <span className="min-w-0 flex-1 truncate">{child.title}</span>
          <DotAvatar profileId={child.ghostId} tone={toneFor(child.ghostId)} size={16}/>
        </button>)}
      </section>}
      <section className="thread-panel__section">
        <h3 className="section-title">작업 대화</h3>
        {!work.conversationId ? <p className="work-aside__empty">{liveWork(work) ? '아직 시작 전' : '기록 없음'}</p>
          : loading ? <div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">대화 기록을 읽는 중</span></div>
            : <div className="ghost-conversation__messages thread-panel__transcript">
              <Transcript messages={feed.messages} speaker={message => message.role === 'user' ? `${carrier}에게 전달` : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : carrier}/>
              {feed.live && <LiveReply live={feed.live} ghostId={work.ghostId} ghostName={carrier}/>}
            </div>}
      </section>
    </div>}
  </aside>;
}
