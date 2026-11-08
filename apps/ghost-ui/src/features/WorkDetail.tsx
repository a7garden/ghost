import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Pencil, Play, Square } from 'lucide-react';
import { Button, Page, InlineError, Input, Textarea, FormField } from '../ui'
import type { Effect, Message, State, Verdict, Work, WorkDetail as WorkDetailData } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { LifecycleTrack, StateGlyph, glyphLabel, workGlyph, type GlyphState } from '../components/agent';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { LiveReply, Transcript } from '../components/TranscriptMessage';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { MessageBody } from '../components/MessageBody';
import { DecisionCard } from './Decision';
import { toneFor } from './ghostState';
import { useConversationFeed } from './conversationFeed';
import { absoluteTime, relativeTime, useNow } from './time';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';

const effectGlyph: Record<Effect['state'], GlyphState> = { pending: 'running', done: 'done', unknown: 'blocked', denied: 'cancelled' };
const effectLabel: Record<Effect['state'], string> = { pending: '실행 중', done: '완료', unknown: '결과 미확정', denied: '거부됨' };
const verdictText: Record<Verdict['outcome'], string> = { pass: '통과', revise: '수정 지시', fail: '미달' };
const verdictSource: Record<Verdict['source'], string> = { checks: '확인 규칙', review: '검토', owner: '사용자 확인' };

/** 맡긴 일 detail: where it stands, what waits on the owner, the brief and result, and how it got there. */
export function WorkDetail({ state, workId, navigate }: { state: State; workId: string; navigate(path: string): void }) {
  const { store, client } = useHost();
  const now = useNow();
  const [detail, setDetail] = useState<WorkDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const ghostName = (id: string) => state.ghosts.find(ghost => ghost.id === id)?.name ?? 'Ghost';

  const reload = useCallback(async () => {
    try {
      const next = await client.work(workId);
      setDetail(next); setNotFound(false);
    } catch {
      setNotFound(true);
    }
  }, [client, workId]);

  useEffect(() => { setDetail(null); setNotFound(false); void reload(); }, [reload]);
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
  if (!detail) return <Page><div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">읽는 중</span></div></Page>;

  const { work, children, effects, artifacts, ancestors, decisions } = detail;
  const pending = decisions.filter(decision => decision.state === 'pending');
  const live = !TERMINAL_WORK_STATES.includes(work.state);
  const needsOwner = pending.length > 0;
  const glyph = workGlyph(work.state, needsOwner);
  const resumable = work.parentId === null && (work.state === 'failed' || work.state === 'blocked');
  const pendingChildIds = new Set(state.decisions.filter(decision => decision.state === 'pending' && decision.workId).map(decision => decision.workId!));

  return <Page className="work-detail">
    <header className="work-head">
      {ancestors.length > 0 && <nav className="work-head__trail" aria-label="상위 맡긴 일">
        {ancestors.map(ancestor => <span key={ancestor.id}>
          <button type="button" onClick={() => navigate(`/work/${encodeURIComponent(ancestor.id)}`)}>{ancestor.title}</button>
          <ChevronRight size={12} aria-hidden="true"/>
        </span>)}
      </nav>}
      <div className="work-head__row">
        <h1 className="work-head__title">{work.title}</h1>
        <div className="work-head__actions">
          {live && <Button variant="outline" onClick={() => setEditing(true)}><Pencil/>수정</Button>}
          {live && <Button variant="outline" onClick={() => run(() => client.send({ type: 'work.cancel', workId: work.id }))}><Square/>취소</Button>}
          {resumable && <Button onClick={() => run(() => client.send({ type: 'work.resume', workId: work.id }))}><Play/>재개</Button>}
        </div>
      </div>
      <div className="work-head__meta">
        <StateGlyph state={glyph} label/>
        <span className="work-head__who"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={16}/>{ghostName(work.ghostId)}</span>
        <span title={absoluteTime(work.createdAt)}>{relativeTime(work.createdAt, now)} 맡김</span>
        {work.deadlineAt && <span data-overdue={live && work.deadlineAt < now || undefined}>기한 {absoluteTime(work.deadlineAt)}</span>}
        {work.revision > 1 && <span>수정 {work.revisionsUsed}/{work.revision - 1}</span>}
      </div>
      <LifecycleTrack state={work.state} needsOwner={needsOwner} className="work-head__track"/>
      {work.reason && (work.state === 'failed' || work.state === 'blocked' || work.state === 'cancelled') && <p className="work-head__reason" data-state={work.state}>{work.reason}</p>}
    </header>
    {error && <InlineError>{error}</InlineError>}

    {pending.length > 0 && <section className="grid gap-3" aria-label="확인 필요">
      {pending.map(decision => <DecisionCard key={decision.id} decision={decision} ghostName={ghostName(decision.ghostId)} workTitle={work.title} onResolved={() => void reload()}/>)}
    </section>}

    <div className="work-body">
      <div className="work-main">
        {(work.result || work.verdict) && !pending.some(decision => decision.kind === 'accept_result') && <section className="work-section" aria-labelledby="work-result">
          <h2 id="work-result" className="section-title">{uiTerms.workResults}</h2>
          <div className="receipt">
            {work.verdict && <VerdictStamp verdict={work.verdict}/>}
            {work.result?.summary && <div className="receipt__body"><MessageBody text={work.result.summary}/></div>}
            {artifacts.length > 0 && <div className="receipt__files">{artifacts.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}</div>}
          </div>
        </section>}

        <section className="work-section" aria-labelledby="work-brief">
          <h2 id="work-brief" className="section-title">할 일</h2>
          <p className="work-brief">{work.brief}</p>
          {work.acceptance.criteria.trim() && <div className="work-criteria"><span>완료 기준</span><p>{work.acceptance.criteria}</p></div>}
        </section>

        <WorkConversation work={work} ghostName={ghostName(work.ghostId)}/>
      </div>

      <aside className="work-aside">
        {(ancestors.length > 0 || children.length > 0) && <section className="work-section" aria-labelledby="work-tree">
          <h2 id="work-tree" className="section-title">위임</h2>
          <ol className="branch-map">
            {ancestors.map(ancestor => <BranchNode key={ancestor.id} work={ancestor} ghostName={ghostName(ancestor.ghostId)} depth="up" needsOwner={pendingChildIds.has(ancestor.id)}
              onOpen={() => navigate(`/work/${encodeURIComponent(ancestor.id)}`)}/>)}
            <BranchNode work={work} ghostName={ghostName(work.ghostId)} depth="self" needsOwner={needsOwner}/>
            {children.map(child => <BranchNode key={child.id} work={child} ghostName={ghostName(child.ghostId)} depth="down" needsOwner={pendingChildIds.has(child.id)}
              onOpen={() => navigate(`/work/${encodeURIComponent(child.id)}`)}/>)}
          </ol>
        </section>}

        <section className="work-section" aria-labelledby="work-effects">
          <h2 id="work-effects" className="section-title">실행 기록<span className="count">{effects.length || ''}</span></h2>
          {effects.length > 0 ? <ol className="timeline">{[...effects].sort((a, b) => a.createdAt - b.createdAt).map(effect => <li key={effect.id} data-state={effect.state}>
            <StateGlyph state={effectGlyph[effect.state]} size={14}/>
            <div className="timeline__copy">
              <span className="timeline__summary">{effect.summary}</span>
              <span className="timeline__meta"><code>{effect.tool}</code><span>{effectLabel[effect.state]}</span><time className="tabular" title={absoluteTime(effect.createdAt)}>{relativeTime(effect.endedAt ?? effect.createdAt, now)}</time></span>
              {effect.result && <details className="timeline__result"><summary>출력</summary><pre>{effect.result}</pre></details>}
            </div>
          </li>)}</ol> : <p className="work-aside__empty">실행 기록 없음</p>}
        </section>
      </aside>
    </div>
    {editing && <EditWorkModal work={work} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); }}/>}
  </Page>;
}

export function VerdictStamp({ verdict }: { verdict: Verdict }) {
  return <div className="verdict" data-outcome={verdict.outcome}>
    <StateGlyph state={verdict.outcome === 'pass' ? 'done' : verdict.outcome === 'fail' ? 'failed' : 'attention'} size={15}/>
    <strong>{verdictText[verdict.outcome]}</strong>
    <span>{verdictSource[verdict.source]} · {absoluteTime(verdict.at)}</span>
    {verdict.reasons.trim() && <details><summary>사유</summary><p>{verdict.reasons}</p></details>}
    {verdict.evidence?.trim() && <details><summary>근거</summary><p>{verdict.evidence}</p></details>}
    {verdict.scope?.trim() && <details><summary>수정 범위</summary><p>{verdict.scope}</p></details>}
  </div>;
}

/** One stop on the delegation line: parents above, this Work highlighted, delegated children below. */
function BranchNode({ work, ghostName, depth, needsOwner, onOpen }: { work: Work; ghostName: string; depth: 'up' | 'self' | 'down'; needsOwner: boolean; onOpen?(): void }) {
  const glyph = workGlyph(work.state, needsOwner);
  const content = <>
    <span className="branch-map__dot"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={depth === 'self' ? 22 : 18}/></span>
    <span className="branch-map__copy"><span>{work.title}</span><small>{ghostName} · {glyphLabel[glyph]}</small></span>
    <StateGlyph state={glyph} size={14}/>
  </>;
  return <li className="branch-map__node" data-depth={depth}>
    {onOpen ? <button type="button" onClick={onOpen}>{content}</button> : <div aria-current="true">{content}</div>}
  </li>;
}

/** The assignee's conversation, read-only and live while it runs: the owner steers through 수정 and decisions. */
function WorkConversation({ work, ghostName }: { work: Work; ghostName: string }) {
  const [open, setOpen] = useState(false);
  if (!work.conversationId) return null;
  return <section className="work-section" aria-labelledby="work-conversation">
    <button type="button" className="work-disclosure" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <ChevronRight size={14} aria-hidden="true"/><h2 id="work-conversation" className="section-title">작업 대화</h2>
    </button>
    {open && <WorkTranscript conversationId={work.conversationId} ghostId={work.ghostId} ghostName={ghostName}/>}
  </section>;
}

function WorkTranscript({ conversationId, ghostId, ghostName }: { conversationId: string; ghostId: string; ghostName: string }) {
  const { feed, loading } = useConversationFeed(conversationId);
  const speaker = (message: Message) => message.role === 'user' ? 'Ghost에게 전달' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghostName;
  const running = Boolean(feed.live?.running);
  return <div className="work-transcript">
    {loading && !feed.messages.length ? <div className="chat-loading" aria-busy="true"><span/><span/><span/><span className="sr-only">대화 기록을 읽는 중</span></div>
      : feed.messages.length || running ? <div className="ghost-conversation__messages">
        <Transcript messages={feed.messages} speaker={speaker}/>
        {feed.live && <LiveReply live={feed.live} ghostId={ghostId} ghostName={ghostName}/>}
      </div>
        : <p className="work-aside__empty">대화 기록 없음</p>}
  </div>;
}

function EditWorkModal({ work, onClose, onSaved }: { work: Work; onClose(): void; onSaved(): void }) {
  const { client } = useHost();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
          ...(brief && brief !== work.brief ? { brief } : {}),
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
      <FormField label="할 일">{control => <Textarea {...control} name="brief" defaultValue={work.brief} rows={6} maxLength={32768}/>}</FormField>
      <FormField label="기한">{control => <Input {...control} type="datetime-local" name="deadline" defaultValue={deadlineValue}/>}</FormField>
      <p className="m-0 text-caption text-ink-2">저장하면 작업 대화에 변경 사항이 전달됩니다.</p>
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button>
    </form>
  </Modal>;
}
