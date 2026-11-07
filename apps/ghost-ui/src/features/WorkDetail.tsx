import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, CircleAlert, FileText, ListTree, Play, Pencil, Square, Wrench } from 'lucide-react';
import { Badge, Button, EmptyState, GPage, GPageHeader, InlineError } from '@garden/ui';
import type { Message, State, Work, WorkDetail as WorkDetailData, Effect, Verdict } from '@ghost/contract';
import { TERMINAL_WORK_STATES } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { DetailDialog } from '../components/DetailDialog';
import { Modal } from '../components/Modal';
import { TranscriptMessage } from '../components/TranscriptMessage';
import { ArtifactPreview } from '../components/ArtifactPreview';
import { toneFor } from './ghostState';
import { workRowStatus, workStateLabel, workStateTone, NewWorkModal } from './WorkViews';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';

const effectStateLabel: Record<Effect['state'], string> = {
  pending: '대기 중', done: '완료', unknown: '결과 미확정', denied: '거부됨',
};

const verdictLabel: Record<Verdict['outcome'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  pass: { label: '통과', tone: 'success' }, revise: { label: '수정 지시', tone: 'warning' }, fail: { label: '미달', tone: 'danger' },
};

const verdictSource: Record<Verdict['source'], string> = { checks: '확인 규칙', review: '검토', owner: '사용자 확인' };

const formatDate = (value: number | null) => value ? new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;

/** 맡긴 일 detail: the tree, the brief, the result, the effects, and the work conversation. */
export function WorkDetail({ state, workId, navigate }: { state: State; workId: string; navigate(path: string): void }) {
  const { store, client } = useHost();
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

  if (notFound) return <GPage>
    <GPageHeader title={uiTerms.work}/>
    <EmptyState icon={<CircleAlert/>} title="맡긴 일을 찾을 수 없습니다"
      description="종료된 지 오래된 일은 목록에서 사라집니다." action={<Button variant="outline" onClick={() => navigate('/work')}>{uiTerms.work} 목록으로</Button>}/>
  </GPage>;
  if (!detail) return <GPage><GPageHeader title={uiTerms.work}/><p className="m-0 text-caption text-ink-2" aria-busy="true">읽는 중…</p></GPage>;

  const { work, children, effects, artifacts, ancestors, decisions } = detail;
  const pendingDecisions = decisions.filter(decision => decision.state === 'pending');
  const live = !TERMINAL_WORK_STATES.includes(work.state);
  const pendingWorkIds = new Set(pendingDecisions.map(decision => decision.workId).filter((id): id is string => id !== null));
  return <GPage width="content" className="grid content-start gap-8 pt-8">
    <div className="grid gap-3">
      <GPageHeader title={work.title}
      actions={<>
        {live && <Button variant="outline" onClick={() => setEditing(true)}><Pencil className="size-4"/>수정</Button>}
        {live && <Button variant="outline" onClick={() => run(() => client.send({ type: 'work.cancel', workId: work.id }))}><Square className="size-4"/>취소</Button>}
        {work.parentId === null && (work.state === 'failed' || work.state === 'blocked')
          && <Button onClick={() => run(() => client.send({ type: 'work.resume', workId: work.id }))}><Play className="size-4"/>재개</Button>}
      </>}/>
    {error && <InlineError>{error}</InlineError>}
    <div className="flex flex-wrap items-center gap-2 text-caption text-ink-2">
      <Badge variant={workRowStatus(work, pendingWorkIds).tone}>{workRowStatus(work, pendingWorkIds).label}</Badge>
      <span className="flex items-center gap-1.5"><DotAvatar profileId={work.ghostId} tone={toneFor(work.ghostId)} size={18}/>{ghostName(work.ghostId)}</span>
      {formatDate(work.deadlineAt) && <span>기한 {formatDate(work.deadlineAt)}</span>}
      {work.revision > 1 && <span>수정 {work.revisionsUsed}/{work.revision - 1}</span>}
    </div>
    </div>

    {(ancestors.length > 0 || children.length > 0) && <section className="grid gap-1 rounded-card border border-line p-3" aria-label="맡긴 일 관계">
      <h2 className="m-0 flex items-center gap-1.5 text-ui font-semibold text-ink"><ListTree className="size-4"/>관계</h2>
      {ancestors.length > 0 && <p className="m-0 flex flex-wrap items-center gap-1 text-caption text-ink-2">
        {ancestors.map(ancestor => <button key={ancestor.id} type="button" className="cursor-pointer rounded-chip px-1.5 py-0.5 hover:bg-hover hover:text-ink" onClick={() => navigate(`/work/${encodeURIComponent(ancestor.id)}`)}>{ancestor.title}</button>)}
        <ArrowUpRight size={12} aria-hidden="true" className="-scale-y-100"/><span className="font-medium text-ink">{work.title}</span>
      </p>}
      {children.map(child => <div key={child.id} className="ml-4 border-l border-line pl-3">
        <WorkRowInline work={child} pendingDecisionIds={pendingWorkIds} ghostName={ghostName(child.ghostId)} onOpen={() => navigate(`/work/${encodeURIComponent(child.id)}`)}/>
      </div>)}
    </section>}

    <section className="grid gap-2" aria-labelledby="work-brief">
      <h2 id="work-brief" className="m-0 text-ui font-semibold text-ink">할 일</h2>
      <p className="m-0 text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{work.brief}</p>
      {work.acceptance.criteria.trim() && <div className="grid gap-1 rounded-card border border-line p-3">
        <h3 className="m-0 text-caption font-semibold text-ink-2">완료 기준</h3>
        <p className="m-0 text-caption leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{work.acceptance.criteria}</p>
      </div>}
    </section>

    {(work.result || work.verdict) && <section className="grid gap-2" aria-labelledby="work-result">
      <h2 id="work-result" className="m-0 text-ui font-semibold text-ink">{uiTerms.workResults}</h2>
      {work.result?.summary && <p className="m-0 text-body leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{work.result.summary}</p>}
      {work.verdict && <div className="flex flex-wrap items-center gap-2 rounded-card border border-line p-3 text-caption">
        <Badge variant={verdictLabel[work.verdict.outcome].tone}>{verdictLabel[work.verdict.outcome].label}</Badge>
        <span className="text-ink-2">{verdictSource[work.verdict.source]} · {formatDate(work.verdict.at)}</span>
        {work.verdict.reasons.trim() && <DetailDialog title="판정 사유" label={<span className="underline underline-offset-2">사유 보기</span>}>
          <pre className="text-caption whitespace-pre-wrap [overflow-wrap:anywhere]">{work.verdict.reasons}</pre>
        </DetailDialog>}
      </div>}
      {artifacts.length > 0 && <div className="flex flex-wrap gap-1.5">{artifacts.map(artifact => <ArtifactPreview key={artifact.digest} artifact={artifact}/>)}</div>}
    </section>}

    {pendingDecisions.length > 0 && <section className="grid gap-1 rounded-card border border-line p-3" aria-labelledby="work-decisions">
      <h2 id="work-decisions" className="m-0 flex items-center gap-1.5 text-ui font-semibold text-ink text-orange"><FileText className="size-4"/>확인 필요</h2>
      {pendingDecisions.map(decision => <button key={decision.id} type="button" onClick={() => navigate(`/inbox?decision=${encodeURIComponent(decision.id)}`)}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-control px-1.5 py-2 text-left text-ui text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3">
        <span className="min-w-0 flex-1 truncate">{decision.title}</span><Badge variant="warning">확인하기</Badge>
      </button>)}
    </section>}

    <section className="grid gap-1" aria-labelledby="work-effects">
      <h2 id="work-effects" className="m-0 flex items-center gap-1.5 text-ui font-semibold text-ink"><Wrench className="size-4"/>실행 기록</h2>
      {effects.map(effect => <div key={effect.id} data-slot="work-row" className="flex w-full min-w-0 items-center gap-3 rounded-control px-2 py-2.5">
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{effect.summary}</span>
          <span className="text-caption text-ink-2">{effect.tool}</span>
        </span>
        {effect.result && <DetailDialog title={`${effect.tool} 실행 기록`} label={<span className="text-caption underline underline-offset-2">기록 보기</span>}>
          <pre className="text-caption whitespace-pre-wrap [overflow-wrap:anywhere]">{effect.result}</pre>
        </DetailDialog>}
        <Badge variant={effect.state === 'unknown' ? 'warning' : effect.state === 'done' ? 'success' : effect.state === 'denied' ? 'outline' : 'default'} className="shrink-0">{effectStateLabel[effect.state]}</Badge>
      </div>)}
      {!effects.length && <p className="m-0 px-2 text-caption text-ink-2">실행 기록 없음</p>}
    </section>

    <WorkConversation work={work} ghostName={ghostName(work.ghostId)}/>
    {editing && <EditWorkModal work={work} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); }}/>}
  </GPage>;
}

function WorkRowInline({ work, pendingDecisionIds, ghostName, onOpen }: { work: Work; pendingDecisionIds: ReadonlySet<string>; ghostName: string; onOpen(): void }) {
  return <button type="button" data-slot="work-row" onClick={onOpen}
    className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-control px-2 py-2 text-left transition-colors hover:bg-hover">
    <span className="grid min-w-0 flex-1 gap-0.5">
      <span className="truncate text-ui font-medium text-ink">{work.title}</span>
      <span className="text-caption text-ink-2">{ghostName}</span>
    </span>
    <Badge variant={workRowStatus(work, pendingDecisionIds).tone} className="shrink-0">{workRowStatus(work, pendingDecisionIds).label}</Badge>
  </button>;
}

/** The assignee's conversation, read-only: the owner steers through 수정 and decisions. */
function WorkConversation({ work, ghostName }: { work: Work; ghostName: string }) {
  const { client } = useHost();
  const [messages, setMessages] = useState<Message[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !work.conversationId) return;
    let alive = true;
    void client.conversation(work.conversationId).then(page => { if (alive) setMessages(page.messages); }).catch(() => { if (alive) setMessages([]); });
    return () => { alive = false; };
  }, [open, work.conversationId, client]);
  if (!work.conversationId) return null;
  const speaker = (message: Message) => message.role === 'user' ? 'Ghost에게 전달' : message.role === 'tool' ? '도구 기록' : message.role === 'note' ? '기록' : ghostName;
  return <section className="grid gap-1" aria-labelledby="work-conversation">
    <div className="flex items-center justify-between gap-2">
      <h2 id="work-conversation" className="m-0 text-ui font-semibold text-ink">작업 대화</h2>
      {!open && <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>대화 기록 보기</Button>}
    </div>
    {open && <div className="grid gap-1 rounded-card border border-line p-2">
      {messages.map(message => <TranscriptMessage key={message.id} message={message} speaker={speaker}/>)}
      {!messages.length && <p className="m-0 p-2 text-caption text-ink-2" aria-busy="true">대화 기록을 읽는 중…</p>}
    </div>}
  </section>;
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
  const deadlineValue = work.deadlineAt ? new Date(work.deadlineAt).toISOString().slice(0, 16) : '';
  return <Modal title="맡긴 일 수정" onClose={() => { if (!busy) onClose(); }}>
    <form className="grid gap-4" onSubmit={e => { e.preventDefault(); submit(new FormData(e.currentTarget)); }}>
      <label className="grid gap-2 text-caption font-medium">제목<input name="title" defaultValue={work.title} maxLength={256} data-slot="input"
        className="h-9 rounded-control border border-line bg-surface px-3 text-ui outline-none focus-visible:outline-2 focus-visible:outline-ink-3"/></label>
      <label className="grid gap-2 text-caption font-medium">할 일<textarea name="brief" defaultValue={work.brief} rows={6} maxLength={32768} data-slot="textarea"
        className="rounded-control border border-line bg-surface p-3 text-ui outline-none focus-visible:outline-2 focus-visible:outline-ink-3"/></label>
      <label className="grid gap-2 text-caption font-medium">기한<input type="datetime-local" name="deadline" defaultValue={deadlineValue} data-slot="input"
        className="h-9 rounded-control border border-line bg-surface px-3 text-ui outline-none focus-visible:outline-2 focus-visible:outline-ink-3"/></label>
      <p className="m-0 text-caption text-ink-2">저장하면 작업 대화에 변경 사항이 전달됩니다.</p>
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy}>{busy ? '저장 중…' : '저장'}</Button>
    </form>
  </Modal>;
}
