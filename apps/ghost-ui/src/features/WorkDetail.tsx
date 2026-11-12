import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight, Pencil, Play, Square } from 'lucide-react';
import { Button, Page, InlineError, Input, Textarea, FormField } from '../ui'
import type { Effect, Message, State, Verdict, Work, WorkDetail as WorkDetailData } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { LifecycleTrack, StateGlyph, glyphLabel, workGlyph, type GlyphState } from '../components/agent';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { GhostRunLabel, LiveReply, Transcript, endsInGhostRun } from '../components/TranscriptMessage';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { InlineText, MessageBody } from '../components/MessageBody';
import { DecisionCard } from './Decision';
import { toneFor } from './ghostState';
import { useConversationFeed } from './conversationFeed';
import { absoluteTime, relativeTime, useNow } from './time';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { useCompact } from '../ui/adaptive';
import { hostStatus } from './hostStatus';
import { HostError } from '../host/client';
import { uiTerms } from '../uiText';
import { executionLabel } from './activity-config';
import { readVerdict, workReason } from './workText';
import { ProjectChips } from '../components/composer/ProjectMentions';
import { CancelWorkDialog } from './WorkViews';

const effectGlyph: Record<Effect['state'], GlyphState> = { pending: 'running', done: 'done', unknown: 'blocked', denied: 'cancelled' };
const effectLabel: Record<Effect['state'], string> = { pending: '실행 중', done: '완료', unknown: '결과 미확정', denied: '거부됨' };
const verdictText: Record<Verdict['outcome'], string> = { pass: '통과', revise: '수정 지시', fail: '미달' };

/** 맡긴 일 detail: where it stands, what waits on the owner, the brief and result, and how it got there. */
export function WorkDetail({ state, workId, navigate }: { state: State; workId: string; navigate(path: string): void }) {
  const { store, client } = useHost();
  const now = useNow();
  const [detail, setDetail] = useState<WorkDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  /** The last read failed for another reason than not-found: the previous detail stays on screen. */
  const [loadError, setLoadError] = useState('');
  const [reloading, setReloading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancellingWorkId, setCancellingWorkId] = useState<string | null>(null);
  const ghostName = (id: string) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';
  const { connection, offlineSince } = useHostState(store);
  const compact = useCompact();
  const pendingRef = useRef<HTMLElement>(null);

  const reload = useCallback(async () => {
    try {
      const next = await client.work(workId);
      setDetail(next); setNotFound(false); setLoadError('');
    } catch (e) {
      // Only the host saying the Work is gone means gone; a dropped connection is not.
      if (e instanceof HostError && e.code === 'not_found') { setNotFound(true); setLoadError(''); }
      else setLoadError(e instanceof Error ? e.message : '맡긴 일을 읽지 못했습니다.');
    }
  }, [client, workId]);
  const retry = () => { setReloading(true); void reload().finally(() => setReloading(false)); };

  useEffect(() => { setDetail(null); setNotFound(false); setLoadError(''); void reload(); }, [reload]);
  // Ledger events carry the whole row; refetch the detail bundle when anything in this tree changes.
  useEffect(() => store.onLedgerEvent(event => {
    if (!detail) return;
    const tree = new Set([workId, ...detail.ancestors.map(row => row.id), ...detail.children.map(row => row.id)]);
    const data = event.data;
    const affected = data.type === 'work' && 'work' in data ? data.work.id
      : data.type === 'effect' && 'effect' in data ? data.effect.workId
        : data.type === 'decision' && 'decision' in data ? data.decision.workId : null;
    if (affected && tree.has(affected)) void reload();
  }), [store, detail, workId, reload]);

  const run = (fn: () => Promise<unknown>) => { setError(''); void fn().then(() => reload()).catch(e => setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.')); };

  if (notFound) return <Page className="grid content-start gap-4">
    <div className="calm"><p>맡긴 일을 찾을 수 없습니다. 끝난 지 오래된 일은 목록에서 사라집니다.</p></div>
    <Button variant="outline" className="justify-self-start" onClick={() => navigate('/work')}>{uiTerms.work} 목록</Button>
  </Page>;
  const loadAlert = loadError && <InlineError onRetry={retry} retryLabel="다시 시도" pending={reloading}>맡긴 일을 새로 읽지 못했습니다 · {loadError}</InlineError>;
  if (!detail && loadAlert) return <Page className="grid content-start gap-4">{loadAlert}</Page>;
  if (!detail) return <Page><div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">읽는 중</span></div></Page>;

  const { work, children, effects, artifacts, ancestors, decisions } = detail;
  const brief = { text: work.brief, scopes: work.scopeReferences ?? [] };
  const pending = decisions.filter(decision => decision.state === 'pending');
  const live = !TERMINAL_WORK_STATES.includes(work.state);
  const needsOwner = pending.length > 0;
  const glyph = workGlyph(work.state, needsOwner);
  const resumable = work.parentId === null && (work.state === 'failed' || work.state === 'blocked');
  const pendingChildIds = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));
  // The bar's 확인 필요 points at the cards below; they keep their place at the top of the page.
  const showPending = () => {
    const section = pendingRef.current;
    if (!section) return;
    // Measured on the next frame, once a panel the click folded is gone. On a phone the bar sticks over the
    // sheet's top: the cards land just below it, however tall it has wrapped.
    requestAnimationFrame(() => {
      const bar = section.parentElement?.querySelector<HTMLElement>(':scope > .work-bar');
      section.style.scrollMarginTop = bar && getComputedStyle(bar).position === 'sticky' ? `${bar.offsetHeight + 12}px` : '';
      section.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      section.focus({ preventScroll: true });
    });
  };
  // The quiet first seconds of a drop stay silent here as everywhere else (hostStatus).
  const link = hostStatus(connection, true, offlineSince, Date.now());
  // A result card waiting on the owner already carries the report, its files and the criteria.
  const judging = pending.some(decision => decision.kind === 'accept_result');
  // While a revision runs, the last verdict says why; the result it judged is no longer the answer.
  const revising = live && work.verdict?.outcome === 'revise';
  const verdict = work.verdict ? readVerdict(work.verdict, decisions) : null;

  return <Page className="work-detail">
    <WorkHeader work={work} ancestors={ancestors} glyph={glyph} pending={pending.length} criteria={judging ? '' : work.acceptance.criteria.trim()} ghostName={ghostName(work.ghostId)} now={now}
      link={live && link.state !== 'connected' && !link.quiet ? link.label : undefined} navigate={navigate} onPending={showPending}
      onEdit={live ? () => setEditing(true) : undefined} onCancel={live ? () => setCancellingWorkId(work.id) : undefined}
      onResume={resumable ? () => run(() => client.send({ type: 'work.resume', workId: work.id })) : undefined}/>
    {loadAlert}
    {error && <InlineError>{error}</InlineError>}

    {pending.length > 0 && <section ref={pendingRef} tabIndex={-1} className="work-pending grid gap-3" aria-label="확인 필요">
      {pending.map(decision => <DecisionCard key={decision.id} decision={decision} ghostName={ghostName(decision.ghostId)} workTitle={work.title} onResolved={() => void reload()}/>)}
    </section>}

    <div className="work-body">
      <div className="work-main">
        {(work.result || work.verdict) && !judging && <section className="work-section" aria-labelledby="work-result">
          <h2 id="work-result" className="section-title">{uiTerms.workResults}</h2>
          <div className="receipt">
            {work.verdict && verdict && <VerdictStamp verdict={work.verdict} judge={verdict.judge} note={verdict.note}/>}
            {!revising && work.result?.summary && <div className="receipt__body"><MessageBody text={work.result.summary}/></div>}
            {!revising && artifacts.length > 0 && <div className="receipt__files">{artifacts.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}</div>}
          </div>
        </section>}

        <section className="work-section" aria-labelledby="work-brief">
          <h2 id="work-brief" className="section-title">할 일</h2>
          <ProjectChips scopes={brief.scopes}/>
          <div className="work-brief"><MessageBody text={brief.text}/></div>
          {/* Only the Mac is worth naming: there the Ghost acts with the owner's own access. */}
          {work.execution?.kind === 'host' && <div className="work-criteria"><span>실행 환경</span><p>{executionLabel.host} · {work.execution.cwd}</p></div>}
          {work.activityId && <Button variant="ghost" size="sm" onClick={() => navigate('/settings?tab=activities')}>자동 활동 열기</Button>}
        </section>

        <WorkConversation work={work} ghostName={ghostName(work.ghostId)} onEdit={live ? () => setEditing(true) : undefined}/>
      </div>

      <aside className="work-aside">
        {/* Parents are the trail above the title; only the Work handed on from here is listed. */}
        {children.length > 0 && <AsideSection compact={compact} title="위임" count={children.length}>
          <ol className="branch-map">
            {children.map(child => <BranchNode key={child.id} work={child} ghostName={ghostName(child.ghostId)} needsOwner={pendingChildIds.has(child.id)}
              onOpen={() => navigate(`/work/${encodeURIComponent(child.id)}`)}/>)}
          </ol>
        </AsideSection>}

        <AsideSection compact={compact} title="실행 기록" count={effects.length}>
          {effects.length > 0 ? <ol className="timeline">{[...effects].sort((a, b) => a.createdAt - b.createdAt).map(effect => <li key={effect.id} data-state={effect.state}>
            <StateGlyph state={effectGlyph[effect.state]} size={14}/>
            <div className="timeline__copy">
              <span className="timeline__summary">{effect.summary}</span>
              <span className="timeline__meta">
                {effect.state !== 'done' && <span>{effectLabel[effect.state]}</span>}
                <time className="tabular" title={absoluteTime(effect.createdAt)}>{relativeTime(effect.endedAt ?? effect.createdAt, now)}</time>
              </span>
              {effect.result && <details className="timeline__result"><summary>출력</summary><pre>{effect.result}</pre></details>}
            </div>
          </li>)}</ol> : <p className="work-aside__empty">실행 기록 없음</p>}
        </AsideSection>
      </aside>
    </div>
    {editing && <EditWorkModal work={work} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); }}/>}
    {cancellingWorkId === work.id && <CancelWorkDialog work={work} onCancel={async () => { await client.send({ type: 'work.cancel', workId: work.id }); void reload(); }} onClose={() => setCancellingWorkId(null)}/>}
  </Page>;
}

/**
 * The top of a 맡긴 일: where it sits (parents, title, and the lifecycle while it runs), then one bar that
 * answers 「where is it, and what is mine to do」 — state and deadline, who has it since when, why it stopped,
 * then 완료 기준 and the owner's moves. On a phone the bar sticks while the page scrolls; it is the parent's
 * direct child (a sibling of the header) so it can stick for the whole page.
 */
export function WorkHeader({ work, ancestors, glyph, pending, criteria, ghostName, now, link, navigate, onPending, onEdit, onCancel, onResume }: {
  work: Work; ancestors: Work[]; glyph: GlyphState; pending: number;
  /** 완료 기준 to unfold; empty when a result card below already shows it. */
  criteria: string;
  ghostName: string; now: number;
  /** The host link's label (재연결 중…, 연결 끊김) while what this page shows may be behind the host. */
  link?: string;
  navigate(path: string): void; onPending(): void; onEdit?(): void; onCancel?(): void; onResume?(): void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const live = !TERMINAL_WORK_STATES.includes(work.state);
  const overdue = live && work.deadlineAt !== null && work.deadlineAt < now;
  const verbs = Boolean(onEdit || onCancel || onResume);
  const reason = workReason(work);
  const at = live ? work.createdAt : work.endedAt ?? work.updatedAt;
  // Escape folds the open criteria back onto its toggle.
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open || !event.currentTarget.contains(event.target as Node)) return;
    event.currentTarget.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
    setOpen(false);
  };
  return <>
    <header className="work-head">
      {ancestors.length > 0 && <nav className="work-head__trail" aria-label="상위 맡긴 일">
        {ancestors.map(ancestor => <span key={ancestor.id}>
          <button type="button" onClick={() => navigate(`/work/${encodeURIComponent(ancestor.id)}`)}>{ancestor.title}</button>
          <ChevronRight size={12} aria-hidden="true"/>
        </span>)}
      </nav>}
      <h1 className="work-head__title">{work.title}</h1>
      {/* A settled Work has no next step to point at: its state word says how it ended. */}
      {live && <LifecycleTrack state={work.state} needsOwner={pending > 0} stageOnly className="work-head__track"/>}
    </header>
    <div className="work-bar" onKeyDown={closeOnEscape}>
      <div className="work-bar__state">
        {glyph !== 'attention' && <StateGlyph state={glyph} label/>}
        {pending > 0 && <button type="button" className="work-bar__pending" onClick={() => { setOpen(false); onPending(); }}>
          <StateGlyph state="attention" label/><span className="tabular">{pending}</span>
        </button>}
        {live && work.deadlineAt && <span className="work-bar__due" data-overdue={overdue || undefined}>{overdue ? '기한 지남' : '기한'} {absoluteTime(work.deadlineAt)}</span>}
      </div>
      {link && <p className="work-bar__link" role="status">{link} · 마지막 기록 {relativeTime(work.updatedAt, now)}</p>}
      <div className="work-bar__who">
        <span className="work-head__who"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={16}/>{ghostName}</span>
        <span title={absoluteTime(at)}>{relativeTime(at, now)} {live ? '맡김' : '끝남'}</span>
      </div>
      {(criteria || verbs) && <div className="work-bar__actions">
        {criteria && <button type="button" className="work-bar__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
          <ChevronRight aria-hidden="true"/>완료 기준
        </button>}
        {verbs && <span className="work-bar__verbs">
          {onEdit && <Button variant="outline" onClick={onEdit}><Pencil/>수정</Button>}
          {onCancel && <Button variant="outline" onClick={onCancel}><Square/>취소</Button>}
          {onResume && <Button onClick={onResume}><Play/>재개</Button>}
        </span>}
      </div>}
      {open && criteria && <div id={panelId} className="work-bar__panel" role="region" aria-label="완료 기준">
        <div className="work-criteria"><MessageBody text={criteria}/></div>
      </div>}
    </div>
    {reason && <p className="work-head__reason" data-state={work.state}><InlineText text={reason}/></p>}
  </>;
}

/** 위임 and 실행 기록 sit beside the work on a wide sheet; on a phone they follow it, folded to their title line. */
function AsideSection({ compact, title, count, children }: { compact: boolean; title: string; count?: number; children: ReactNode }) {
  const headingId = useId();
  const heading = <h2 id={headingId} className="section-title">{title}{count !== undefined && <span className="count">{count || ''}</span>}</h2>;
  if (compact) return <details className="work-section work-fold"><summary>{heading}</summary>{children}</details>;
  return <section className="work-section" aria-labelledby={headingId}>{heading}{children}</section>;
}

/** How a result was judged and by whom; what the judge said folds beneath when there is something to say. */
export function VerdictStamp({ verdict, judge, note }: { verdict: Verdict; judge: string; note: string | null }) {
  return <div className="verdict" data-outcome={verdict.outcome}>
    <StateGlyph state={verdict.outcome === 'pass' ? 'done' : verdict.outcome === 'fail' ? 'failed' : 'attention'} size={15}/>
    <strong>{verdictText[verdict.outcome]}</strong>
    <span>{judge} · {absoluteTime(verdict.at)}</span>
    {note && <details><summary>사유</summary><p>{note}</p></details>}
  </div>;
}

/** One Work handed on from this one: who carries it and where it stands. */
function BranchNode({ work, ghostName, needsOwner, onOpen }: { work: Work; ghostName: string; needsOwner: boolean; onOpen(): void }) {
  const glyph = workGlyph(work.state, needsOwner);
  return <li className="branch-map__node">
    <button type="button" onClick={onOpen}>
      <span className="branch-map__dot"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={18}/></span>
      <span className="branch-map__copy"><span>{work.title}</span><small>{ghostName} · {glyphLabel[glyph]}</small></span>
      <StateGlyph state={glyph} size={14}/>
    </button>
  </li>;
}

/** The assignee's conversation, read-only and live while it runs: the owner steers through 수정 and decisions. */
function WorkConversation({ work, ghostName, onEdit }: { work: Work; ghostName: string; onEdit?(): void }) {
  const [open, setOpen] = useState(false);
  if (!work.conversationId) return null;
  return <section className="work-section" aria-labelledby="work-conversation">
    <button type="button" className="work-disclosure" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronRight size={14} aria-hidden="true"/><h2 id="work-conversation" className="section-title">작업 대화</h2>
    </button>
    {open && <WorkTranscript conversationId={work.conversationId} ghostId={work.ghostId} ghostName={ghostName} onEdit={onEdit}/>}
  </section>;
}

/**
 * The stream reads as a record, not a chat: the owner's turns hang on a rule at the left, the Ghost's
 * name heads each run of its rows, and tool work folds to one line of what was done. Wide code, tables
 * and tool output scroll inside their own block; the stream itself never scrolls the page sideways.
 */
function WorkTranscript({ conversationId, ghostId, ghostName, onEdit }: { conversationId: string; ghostId: string; ghostName: string; onEdit?(): void }) {
  const { feed, loading, olderLoading, loadOlder, error, setError } = useConversationFeed(conversationId);
  const speaker = (message: Message) => message.role === 'user' ? 'Ghost에게 전달' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghostName;
  const running = Boolean(feed.live?.running);
  return <div className="work-transcript">
    {error && <InlineError>{error}</InlineError>}
    {feed.before && <div className="grid justify-items-center">
      <button type="button" className="link-quiet" disabled={olderLoading} onClick={() => { setError(''); loadOlder(); }}>{olderLoading ? '불러오는 중…' : '이전 메시지'}</button>
    </div>}
    {loading && !feed.messages.length ? <div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">대화 기록을 읽는 중</span></div>
      : feed.messages.length || running ? <div className="ghost-conversation__messages work-stream">
        <Transcript messages={feed.messages} speaker={speaker} runLabel={ghostName}/>
        {running && !endsInGhostRun(feed.messages) && <GhostRunLabel name={ghostName}/>}
        {feed.live && <LiveReply live={feed.live} ghostId={ghostId} ghostName={ghostName}/>}
      </div>
        // Nothing said yet: 수정 is how the owner speaks into this conversation.
        : !error && <div className="work-transcript__empty">
          <p className="work-aside__empty">대화 기록 없음</p>
          {onEdit && <button type="button" className="link-quiet" onClick={onEdit}>수정</button>}
        </div>}
  </div>;
}

function EditWorkModal({ work, onClose, onSaved }: { work: Work; onClose(): void; onSaved(): void }) {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const currentBrief = { text: work.brief, scopes: work.scopeReferences ?? [] };
  const submit = (data: FormData) => {
    setBusy(true); setError('');
    void (async () => {
      try {
        const title = String(data.get('title')).trim();
        const brief = String(data.get('brief')).trim();
        const deadline = String(data.get('deadline'));
        await client.send({
          type: 'work.update', workId: work.id,
          ...(title && title !== work.title ? { title } : {}),
          ...(brief && brief !== currentBrief.text ? { brief } : {}),
          ...(deadline ? { deadlineAt: new Date(deadline).getTime() } : { deadlineAt: null }),
        });
        onSaved();
      } catch (e) {
        setError(e instanceof Error ? e.message : '맡긴 일을 저장하지 못했습니다.');
        setBusy(false);
      }
    })();
  };
  const deadlineValue = work.deadlineAt ? new Date(work.deadlineAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  return <Modal title="맡긴 일 수정" onClose={() => { if (!busy) onClose(); }}>
    <form className="grid gap-4" onSubmit={e => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}>
      <FormField label="제목">{control => <Input {...control} name="title" defaultValue={work.title} maxLength={256}/>}</FormField>
      <ProjectChips scopes={currentBrief.scopes}/>
      <FormField label="할 일">{control => <Textarea {...control} name="brief" defaultValue={currentBrief.text} rows={6} maxLength={32768}/>}</FormField>
      <FormField label="기한">{control => <Input {...control} type="datetime-local" name="deadline" defaultValue={deadlineValue}/>}</FormField>
      <p className="m-0 text-caption text-ink-2">저장하면 작업 대화에 변경 사항이 전달됩니다.</p>
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button>
    </form>
  </Modal>;
}
