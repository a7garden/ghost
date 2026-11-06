import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import type { Goal, Work } from "../../../../contracts/lifetime/bindings.ts";
import { Badge, Button, Textarea } from "@garden/ui";
import { Modal } from "../components/Modal";
import type { LifetimeClient } from "./types";
import { WorkArtifactPreview } from "./WorkArtifactPreview";
import { followUpCommand, parseWorkThread, threadProgressWork, workThreadTitle, type FollowUpDraft, type WorkThread } from "./workThread";

interface Props {
  client: LifetimeClient;
  goalID: string;
  target?: { ghost_id: string; conversation_id: string };
  goals: Goal[];
  work: Work[];
  ghostName: (id: string) => string;
  goalStatus: (goal: Goal, work: Work[]) => string;
  workStatus: (state: string) => string;
  connected: boolean;
  busy: boolean;
  writeDisabled: boolean;
  feedback: ReactNode;
  draft?: FollowUpDraft;
  onDraft: (draft: FollowUpDraft) => void;
  onSend: (goal: Goal, draft: FollowUpDraft) => Promise<void>;
  onClose: () => void;
}

export function WorkThreadDrawer({ client, goalID, target, goals, work, ghostName, goalStatus, workStatus,
  connected, busy, writeDisabled, feedback, draft, onDraft, onSend, onClose }: Props) {
  const [thread, setThread] = useState<WorkThread | null>(null);
  const [readError, setReadError] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const knownGoal = goals.find(goal => goal.id === goalID);
  const observedRevision = knownGoal?.revision;
  const ghostID = target?.ghost_id;
  const conversationID = target?.conversation_id;
  const reload = () => setRefreshKey(key => key + 1);

  useEffect(() => {
    if (!connected) { setRefreshing(false); return; }
    let active = true;
    let timer = 0;
    async function read(foreground: boolean): Promise<void> {
      if (foreground) setRefreshing(true);
      try {
        if (foreground || document.visibilityState !== "hidden") {
          const response = await client.request({ method: "goal.thread.inspect", goal_id: goalID });
          if (!active) return;
          const value = parseWorkThread(response, goalID, ghostID && conversationID ? { ghost_id: ghostID, conversation_id: conversationID } : undefined);
          setThread(current => current && current.goal.revision > value.goal.revision ? current : value);
          setReadError("");
        }
      } catch (reason) {
        if (active) setReadError(reason instanceof Error ? reason.message : "작업 스레드를 불러오지 못했습니다.");
      } finally {
        if (active) {
          setRefreshing(false);
          timer = window.setTimeout(() => void read(false), 5000);
        }
      }
    }
    void read(true);
    return () => { active = false; window.clearTimeout(timer); };
  }, [client, goalID, ghostID, conversationID, connected, observedRevision, refreshKey]);

  const goal = thread?.goal;
  const effectUnsettled = thread?.follow_up_blocker === "effect_unsettled";
  const fixedThread = Boolean(thread?.follow_up_blocker && !effectUnsettled);
  const graph = thread?.graph;
  const workItems = graph?.work ?? work.filter(item => item.goal_id === goalID && item.goal_revision === goal?.revision);
  const linkByChild = new Map(graph?.links.map(link => [link.child_work_id, link]));
  const currentWork = threadProgressWork(goal, workItems, linkByChild);
  const workByID = new Map(workItems.map(item => [item.id, item]));
  const itemsByGoal = new Map(goals.map(item => [item.id, item]));
  const resultsByWork = new Map(graph?.results.map(result => [result.work_id, result.artifacts]));
  const notes = thread && [
    ...thread.follow_ups.map(note => ({ ...note, kind: "follow_up" as const })),
    ...thread.reports.map(note => ({ ...note, kind: "report" as const })),
  ].sort((a, b) => a.revision - b.revision);
  const staleDraft = Boolean(draft && goal && draft.revision !== goal.revision);
  const fresh = Boolean(goal && connected && !refreshing && !readError && (observedRevision ?? 0) <= goal.revision);
  const command = goal && draft ? followUpCommand(goal, draft) : null;
  const oversize = Boolean(draft?.text.trim() && fresh && !staleDraft && !command);
  const revisesActiveWork = currentWork.some(item => ["active", "running", "steering", "steer_requested", "cancel_requested"].includes(item.state)
    || item.state === "blocked" && (item.execution_id !== null || graph?.blocking_edges.some(edge => edge.waiter_work_id === item.id)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal || !draft || !command || !fresh || busy || writeDisabled || thread?.follow_up_blocker) return;
    await onSend(goal, draft);
    reload();
  }

  return <Modal title="작업 스레드" onClose={onClose} drawer focusClose>
    <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto overscroll-contain pr-1 pb-3">
      {feedback}
      {(readError || !connected) && <div className="flex flex-wrap items-center gap-2 text-caption text-ink-2" role="status">
        <span className="min-w-0 [overflow-wrap:anywhere]">{connected ? readError : "Host에 연결되면 최신 작업 상태를 확인할 수 있습니다."}</span>
        {connected && <Button type="button" variant="secondary" onClick={reload} disabled={refreshing}><RefreshCw size={14}/>다시 불러오기</Button>}
      </div>}
      {refreshing && !thread && connected && <p className="m-0 text-ui text-ink-2" role="status">작업 스레드를 불러오는 중입니다.</p>}
      {thread && goal && <>
        <div className="grid gap-2">
          <h3 className="m-0 text-body font-semibold text-ink [overflow-wrap:anywhere]">{workThreadTitle(goal.prompt)}</h3>
          <div className="flex flex-wrap items-center gap-2 text-caption text-ink-2">
            <Badge variant="outline">{goalStatus(goal, currentWork.filter(item => item.goal_id === goalID))}</Badge>
            <span>담당 {ghostName(goal.accountable_ghost)}</span>
          </div>
        </div>
        <section aria-label="작업 진행" className="grid gap-1.5">
          <h4 className="m-0 text-ui font-semibold text-ink">진행</h4>
          {workItems.some(item => item.cancellation === "requested") &&
            <p className="m-0 text-caption text-ink-2" role="status">이전 실행 정리 대기</p>}
          {currentWork.length === 0 && <p className="m-0 text-caption text-ink-2">아직 배정된 작업이 없습니다.</p>}
          {currentWork.length > 0 && <ul className="grid list-none gap-1.5 p-0">{currentWork.map(item => {
            const parent = workByID.get(linkByChild.get(item.id)?.parent_work_id ?? "");
            const edges = graph?.blocking_edges.filter(edge => edge.waiter_work_id === item.id) ?? [];
            const itemGoal = itemsByGoal.get(item.goal_id);
            const artifacts = resultsByWork.get(item.id) ?? [];
            return <li key={item.id} className="grid gap-1.5 border-t border-line py-2 text-caption">
              <div className="flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1">
                <strong className="inline-flex min-w-0 items-center gap-1.5 [overflow-wrap:anywhere]">{parent ? <><GitBranch size={14} aria-hidden="true"/>{ghostName(parent.owner)} → {ghostName(item.owner)}</> : ghostName(item.owner)}</strong>
                <Badge variant="outline">{workStatus(item.state)}</Badge>
              </div>
              {item.goal_id !== goalID && itemGoal && <p className="m-0 [overflow-wrap:anywhere]">{workThreadTitle(itemGoal.prompt)}</p>}
              {edges.length > 0 ? <p className="m-0 text-ink-2 [overflow-wrap:anywhere]">선행 작업 대기: {edges.map(edge => {
                const blocker = workByID.get(edge.blocker_work_id);
                return blocker ? ghostName(blocker.owner) : "연결된 작업";
              }).join(", ")}</p> : item.blocker && <p className="m-0 text-ink-2 [overflow-wrap:anywhere]">{item.blocker}</p>}
              {artifacts.length > 0 && <div className="flex flex-wrap gap-1.5">{artifacts.map(artifact =>
                <WorkArtifactPreview key={artifact.digest} client={client} work={item} artifact={artifact} disabled={!connected}/>)}</div>}
            </li>;
          })}</ul>}
          {graph?.truncated && <p className="m-0 text-caption text-ink-2">연결된 작업 중 일부만 표시합니다.</p>}
        </section>
        <ol className="grid list-none gap-2 p-0" aria-label="작업 메시지">
          {thread.origin && <li className="border-l-2 border-line pl-2.5"><strong className="text-caption font-semibold">처음 요청</strong><p className="mt-1 mb-0 whitespace-pre-wrap text-body leading-relaxed [overflow-wrap:anywhere]">{thread.origin.text}</p></li>}
          {notes?.map(note => <li key={`${note.kind}:${note.id}`} className="border-l-2 border-line pl-2.5" data-kind={note.kind}>
            <strong className="text-caption font-semibold">{note.kind === "report" ? "작업 보고" : "후속 지시"}</strong>
            {note.revision !== goal.revision && <span className="text-caption text-ink-2"> · 이전 판본</span>}
            <p className="mt-1 mb-0 whitespace-pre-wrap text-body leading-relaxed [overflow-wrap:anywhere]">{note.text}</p>
          </li>)}
        </ol>
        <details className="text-caption" open={staleDraft || undefined}>
          <summary className="cursor-pointer text-ink-2">현재 작업 내용</summary><p className="mt-1 mb-0 whitespace-pre-wrap text-body leading-relaxed [overflow-wrap:anywhere]">{goal.prompt}</p>
        </details>
      </>}
    </div>
    {fixedThread && <p className="m-0 pt-3 text-caption text-ink-2">
      {thread?.follow_up_blocker === "fixed_contract" ? "이 작업의 계약은 고정되어 있습니다." : "대화의 공개 범위가 바뀌어 이 작업에 새 지시를 보낼 수 없습니다."}
    </p>}
    {goal && !fixedThread && <form className="grid gap-2 border-t border-line pt-3" onSubmit={event => void submit(event)}>
      <label className="grid gap-1.5 text-caption text-ink-2">후속 지시<Textarea rows={2} value={draft?.text ?? ""} readOnly={busy}
        onChange={event => onDraft({ text: event.currentTarget.value, revision: draft?.revision ?? goal.revision })}/></label>
      {staleDraft && <p className="m-0 text-caption text-ink-2" role="status">작성 중 작업이 바뀌었습니다. 최신 작업 내용을 확인한 뒤 보내세요.</p>}
      {oversize && <p className="m-0 text-caption text-ink-2" role="status">지시가 너무 깁니다. 내용을 줄여 주세요.</p>}
      {effectUnsettled && <p className="m-0 text-caption text-ink-2" role="status">현재 동작이 확인되면 후속 지시를 보낼 수 있습니다.</p>}
      {command && revisesActiveWork && !effectUnsettled && <p className="m-0 text-caption text-ink-2">현재 실행을 정리한 뒤 새 지시를 반영합니다.</p>}
      <div className="flex flex-wrap justify-end gap-1.5">
        {staleDraft && draft && <Button type="button" variant="secondary" disabled={!fresh || busy}
          onClick={() => onDraft({ ...draft, revision: goal.revision })}>최신 판본에서 계속</Button>}
        <Button type="submit" disabled={!fresh || busy || writeDisabled || effectUnsettled || !command}>후속 지시 보내기</Button>
      </div>
    </form>}
  </Modal>;
}
