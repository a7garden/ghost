import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, ChevronRight, CircleAlert, Clock3, LayoutGrid, MessageSquare, RefreshCw, Send, Settings2 } from "lucide-react";
import type { Artifact, ConversationRun, Envelope, Goal, Response, Snapshot, Work } from "../../../../contracts/lifetime/bindings.ts";
import { isArtifact, isPrivacy } from "./guards";
import { atLeastPrivacy, conversationTargetKey, mergeConversationRuns, parseConversationPage, parseRegistryResponse } from "./conversation";
import type { ConversationPage, ConversationTurn, RegistryConversation } from "./conversation";
import type { LifetimeClient, LifetimeMode, LifetimeRecoveryCommand } from "./types";
import type { Review, Command } from "../client/types";
import { MemorySourceReview } from "./MemorySourceReview";
import "./lifetime.css";
import { InferenceSettings } from '../pets/InferenceSettings';
import { BotRoster } from './BotRoster';
import { AgentStatus } from '../components/AgentStatus';
import { Modal } from '../components/Modal';
import { createAgentStatusReadFence, projectAgentStatus, runAgentStatusOwnerRead } from './agentStatus';
import type { AgentStatusReadToken } from './agentStatus';

export interface LifetimeViewProps {
  mode: LifetimeMode;
  client: LifetimeClient;
  /** Host workspace reviews for the current authority, or undefined while offline. */
  documentReviews?: Review[];
  /** Current lifetime authority epoch; proposals from other epochs are stale and hidden. */
  documentAuthorityEpoch?: number;
  /** Opens the existing Owner approval modal on the same workspace surface. */
  onOpenDocumentReview?: (review: Review) => void;
  /** Existing workspace Owner action (CSRF + envelope journal) for the Owner memory source surface. */
  memoryAction?: (command: Command) => Promise<Record<string, any>>;
  initialGhostID?: string;
  createRequested?: boolean;
  legacyGhostIDs?: string[];
  onOpenHistory?: (ghostID: string) => void;
}

const goalStateLabels: Record<string, string> = {
  open: "접수됨",
  queued: "접수됨",
  active: "진행 중",
  blocked: "대기 중",
  verifying: "결과 확인 중",
  accepted: "검수 완료",
  complete: "완료",
  cancelled: "취소됨",
  rejected: "반려됨",
  failed: "실패",
  review: "확인 필요",
  cancel_requested: "취소 확인 중",
  work_cancelled: "작업 취소됨",
};

const movingWorkStates = new Set(["active", "running", "steering", "steer_requested"]);

const goalStages = [
  { id: "queued", label: "접수" },
  { id: "active", label: "진행" },
  { id: "review", label: "결과 확인" },
  { id: "closed", label: "종료" },
] as const;

function boardState(goal: Goal, workItems: Work[]): { stage: typeof goalStages[number]["id"]; state: string } {
  if (["accepted", "complete", "cancelled", "rejected"].includes(goal.state)) {
    return { stage: "closed", state: goal.state };
  }
  const current = workItems.filter(work => work.goal_revision === goal.revision);
  const failure = current.find(work => work.state === "failed" || work.state === "rejected");
  if (failure) return { stage: "review", state: failure.state };
  if (goal.state === "verifying" || current.some(work => ["completed", "verifying", "unknown"].includes(work.state))) {
    return { stage: "review", state: "review" };
  }
  if (goal.state === "active" || current.some(work => movingWorkStates.has(work.state))) {
    return { stage: "active", state: "active" };
  }
  if (current.some(work => work.state === "cancel_requested")) {
    return { stage: "active", state: "cancel_requested" };
  }
  if (current.length > 0 && current.every(work => work.state === "cancelled")) {
    return { stage: "closed", state: "work_cancelled" };
  }
  return { stage: "queued", state: goal.state };
}

const workStateLabels: Record<string, string> = {
  queued: "대기 중",
  active: "진행 중",
  running: "진행 중",
  completed: "결과 확인 전",
  unknown: "실행 결과 확인 필요",
  stale: "이전 목표 결과",
  verifying: "결과 확인 중",
  blocked: "대기 중",
  accepted: "검수 완료",
  complete: "완료",
  cancelled: "취소됨",
  failed: "실패",
  rejected: "반려됨",
  steering: "방향 전달됨",
  steer_requested: "방향 전달됨",
  cancel_requested: "취소 확인 중",
};

const privacyLabels: Record<Goal["privacy"], string> = {
  public: "공개 자료 허용",
  private: "비공개",
  local_only: "이 기기에서만",
};

const terminalWorkStates: Record<string, true> = {
  accepted: true,
  complete: true,
  completed: true,
  cancelled: true,
  failed: true,
  rejected: true,
};

const pendingCancellations: Record<string, true> = {
  requested: true,
  acknowledged: true,
  stopped: true,
  reconciled: true,
};

const cancellationLabels: Record<string, string> = {
  none: "취소 요청 전",
  requested: "취소 요청됨 · 중지 확인 전",
  confirmed: "취소 확인됨",
  acknowledged: "중지 확인 중",
  stopped: "중지됨 · 실행 결과 확인 전",
  reconciled: "취소 결과 확인됨",
};

const turnStateLabels: Record<ConversationRun["state"], string> = {
  queued: "응답 대기",
  running: "응답 작성 중",
  answered: "응답 저장됨",
  failed: "응답 실행 실패",
  cancelled: "응답 취소 확인됨",
  effect_unknown: "응답 실행 상태 확인 필요",
};

const pendingCommandLabels: Record<string, string> = {
  "conversation.input": "대화 메시지",
  "conversation.cancel_turn": "이 응답 취소 요청",
  "goal.submit": "목표 등록",
  "goal.update": "목표 수정",
  "goal.inspect": "목표 확인",
  "work.inspect": "진행 확인",
  "work.steer": "방향 조정",
  "work.cancel": "취소 요청",
  "bot.lifecycle.set": "Ghost 사용 상태 변경",
  "bot.update.prepare": "Ghost 역할 수정",
  "bot.clone.prepare": "새 Ghost로 복제",
};

function attachmentKey(artifact: Artifact): string {
  return JSON.stringify([artifact.digest, artifact.producing_attempt, artifact.locator, artifact.privacy]);
}

function conversationLabel(target: RegistryConversation): string {
  const role = target.roles.join(" · ");
  if (target.kind === "primary") return role ? `주 Ghost · ${role}` : "주 Ghost";
  return role || "전문 담당";
}
async function fetchConversationPage(client: LifetimeClient, target: RegistryConversation, beforeSequence?: number): Promise<ConversationPage> {
  const body = {
    method: "conversation.inspect",
    ghost_id: target.ghost_id,
    conversation_id: target.conversation_id,
    limit: 100,
    ...(beforeSequence === undefined ? {} : { before_sequence: beforeSequence }),
  };
  return parseConversationPage(await client.request(body), target);
}
export function LifetimeView({ mode, client, documentReviews, documentAuthorityEpoch, onOpenDocumentReview, memoryAction, initialGhostID, createRequested, legacyGhostIDs = [], onOpenHistory }: LifetimeViewProps) {
  const [selectedPanel, setSelectedPanel] = useState<"conversation" | "work" | "ghosts">("conversation");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<Envelope[]>([]);
  const [recovery, setRecovery] = useState<LifetimeRecoveryCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [notice, setNotice] = useState("");
  const [prompt, setPrompt] = useState("");
  const [privacy, setPrivacy] = useState<Artifact["privacy"]>("local_only");
  const [attachmentDrafts, setAttachmentDrafts] = useState(() => new Map<string, Artifact[]>());
  const [registry, setRegistry] = useState<RegistryConversation[]>([]);
  const [registryError, setRegistryError] = useState("");
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [turnRuns, setTurnRuns] = useState<Map<string, ConversationRun>>(() => new Map());
  const [conversationPrivacy, setConversationPrivacy] = useState<Artifact["privacy"]>("local_only");
  const [hasOlder, setHasOlder] = useState(false);
  const [oldestSequence, setOldestSequence] = useState<number | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState("");
  const [conversationRefresh, setConversationRefresh] = useState(0);
  const [loadedConversationKey, setLoadedConversationKey] = useState("");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptAtBottom = useRef(true);
  const [goalDetailID, setGoalDetailID] = useState<string | null>(null);
  const [goalDrafts, setGoalDrafts] = useState(() => new Map<string, { text: string; revision: number }>());
  const [steerDrafts, setSteerDrafts] = useState<Map<string, string>>(() => new Map());
  const [inspectSummaries, setInspectSummaries] = useState<Map<string, string>>(() => new Map());
  const [selectedPairKey, setSelectedPairKey] = useState("");
  const [snapshotObservedAt, setSnapshotObservedAt] = useState(0);
  const [conversationObservedAt, setConversationObservedAt] = useState(0);
  const snapshotReads = useRef(createAgentStatusReadFence());
  const foregroundReads = useRef(new Set<AgentStatusReadToken>());
  const [pairRefreshRequest, setPairRefreshRequest] = useState(0);

  function updateAttachments(targetKey: string, update: (current: Artifact[] | undefined) => Artifact[] | undefined) {
    setAttachmentDrafts(drafts => {
      const current = drafts.get(targetKey);
      const next = update(current);
      if (next === current) return drafts;
      const updated = new Map(drafts);
      if (next?.length) updated.set(targetKey, next);
      else updated.delete(targetKey);
      return updated;
    });
  }

  function acceptLatest(read: AgentStatusReadToken | null, latest: Snapshot, commands: Envelope[], unresolved: LifetimeRecoveryCommand[], registryResponse: Response): boolean {
    if (!snapshotReads.current.isCurrent(read, currentTargetKey.current)) return false;
    if ((mode === "fixture") !== (latest.mode === "fixture")) throw new Error("The configured lifetime mode does not match the transport snapshot.");
    const entries = parseRegistryResponse(registryResponse);
    setSnapshot(latest);
    setSnapshotObservedAt(Date.now());
    setPending(commands);
    setRecovery(unresolved);
    setRegistry(entries);
    setRegistryError("");
    const activePrimary = entries.filter(entry => entry.mode === "active" && entry.kind === "primary");
    const conversationInputs = commands.filter(command => command.body.method === "conversation.input");
    if (conversationInputs.length === 1) {
      const body = conversationInputs[0]!.body;
      if (typeof body.ghost_id === "string" && typeof body.conversation_id === "string") {
        const key = conversationTargetKey({ ghost_id: body.ghost_id, conversation_id: body.conversation_id });
        setSelectedPairKey(key);
        const savedAttachments = body.attachments;
        if (Array.isArray(savedAttachments) && savedAttachments.every(isArtifact)) {
          updateAttachments(key, () => savedAttachments);
        }
      }
      if (!prompt && typeof body.text === "string") setPrompt(body.text);
      if (isPrivacy(body.privacy)) setPrivacy(body.privacy);
    } else if (conversationInputs.length === 0 && !selectedPairKey && !initialGhostID && activePrimary.length === 1) {
      setSelectedPairKey(conversationTargetKey(activePrimary[0]!));
    }
    return true;
  }

  async function loadLatest(): Promise<boolean> {
    return runAgentStatusOwnerRead({
      fence: snapshotReads.current, foregroundReads: foregroundReads.current,
      currentScope: () => currentTargetKey.current,
      fetch: () => Promise.all([
        client.snapshot(),
        client.pendingCommands(),
        client.recoveryCommands(),
        client.request({ method: "registry.inspect" }),
      ]),
      onSuccess: ([latest, commands, unresolved, registryResponse], read) => acceptLatest(read, latest, commands, unresolved, registryResponse),
      onError: reason => {
        const message = reason instanceof Error ? reason.message : "최신 상태를 불러오지 못했습니다.";
        setRegistryError(message);
        setSyncWarning(message);
      },
      onSettled: () => setLoading(false),
    });
  }

  useEffect(() => {
    snapshotReads.current.activate();
    setLoading(true);
    void runAgentStatusOwnerRead({
      fence: snapshotReads.current, foregroundReads: foregroundReads.current,
      currentScope: () => currentTargetKey.current,
      fetch: () => Promise.all([client.snapshot(), client.pendingCommands(), client.recoveryCommands(), client.request({ method: "registry.inspect" })]),
      onSuccess: ([latest, commands, unresolved, registryResponse], read) => {
        const applied = acceptLatest(read, latest, commands, unresolved, registryResponse);
        if (applied) setError("");
        return applied;
      },
      onError: reason => {
        const message = reason instanceof Error ? reason.message : "지속 작업을 불러오지 못했습니다.";
        setError(message);
        setRegistryError(message);
      },
      onSettled: () => setLoading(false),
    });
    return () => { snapshotReads.current.deactivate(); };
  }, [client, mode]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setSyncWarning("");
    try {
      if (await loadLatest()) setConversationRefresh(current => current + 1);
    } finally {
      setRefreshing(false);
    }
  }

  // Selection state and its scope ref commit before the queued Owner bundle begins.
  useEffect(() => {
    if (pairRefreshRequest > 0) void refresh();
  }, [pairRefreshRequest]);

  async function run(key: string, operation: () => Promise<Response>): Promise<Response | null> {
    if (busy) return null;
    setBusy(key);
    setError("");
    setSyncWarning("");
    setNotice("");
    try {
      let response: Response;
      try {
        response = await operation();
      } catch {
        setError("요청 응답을 확인하지 못했습니다. 원래 요청 ID를 보존했으며, 다시 전송하지 않고 접수 기록을 확인할 수 있습니다.");
        try {
          setPending(await client.pendingCommands());
        } catch (reason) {
          setSyncWarning(reason instanceof Error ? reason.message : "저장된 요청 기록을 읽지 못했습니다.");
        }
        await loadLatest();
        return null;
      }
      if (response.status === "error") setError(response.summary || "요청을 처리하지 못했습니다.");
      else setNotice(response.summary);
      await loadLatest();
      return response;
    } finally {
      setBusy("");
    }
  }

  async function reconcile(recoveryId: string): Promise<void> {
    if (busy) return;
    setBusy(`reconcile:${recoveryId}`);
    setError("");
    setSyncWarning("");
    setNotice("");
    try {
      const result = await client.reconcile(recoveryId);
      if (result.status === "confirmed_success") setNotice("이전 요청이 성공으로 처리된 접수 기록을 확인했습니다.");
      else if (result.status === "confirmed_no_effect") setNotice("이전 요청이 효과 없이 거절된 접수 기록을 확인했습니다.");
      else if (result.status === "not_found") setError("호스트에 접수 기록이 없습니다. 원래 요청은 미확정으로 유지되며 새 요청은 차단됩니다.");
      else setError("이전 요청의 실행 결과를 확정할 수 없습니다. 원래 기록은 그대로 보존됩니다.");
      await loadLatest();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "이전 요청의 접수 기록을 확인하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  const activeTargets = registry.filter(target => target.mode === "active");
  const activePrimary = activeTargets.filter(target => target.kind === "primary");
  const appliedEntry = useRef('');
  useEffect(() => {
    const entry = `${initialGhostID ?? ''}:${Boolean(createRequested)}`;
    if (!registry.length || appliedEntry.current === entry || pending.length > 0) return;
    const requested = initialGhostID ? registry.filter(target => target.ghost_id === initialGhostID) : createRequested ? activePrimary : [];
    if (requested.length !== 1) { if (initialGhostID) setSelectedPairKey(''); return; }
    setSelectedPairKey(conversationTargetKey(requested[0]!));
    if (createRequested) {
      setGoalDetailID(null);
      setSelectedPanel("conversation");
      setPrompt(current => current || '이걸 봇으로 만들어 줘');
    }
    appliedEntry.current = entry;
  }, [initialGhostID, createRequested, registry, pending.length]);
  const selectedTarget = selectedPairKey
    ? registry.find(target => conversationTargetKey(target) === selectedPairKey)
    : initialGhostID ? registry.find(target => target.ghost_id === initialGhostID)
      : activePrimary.length === 1 ? activePrimary[0] : undefined;
  const selectedTargetKey = selectedTarget ? conversationTargetKey(selectedTarget) : "";
  const currentTargetKey = useRef(selectedTargetKey);
  const previousTargetKey = useRef(selectedTargetKey);
  const historyGhostID = selectedTarget?.ghost_id ?? initialGhostID;
  currentTargetKey.current = selectedTargetKey;
  useLayoutEffect(() => {
    if (previousTargetKey.current !== selectedTargetKey) {
      snapshotReads.current.invalidate();
      setGoalDetailID(null);
      previousTargetKey.current = selectedTargetKey;
      if (loading) void loadLatest();
    }
  }, [selectedTargetKey]);
  const writesDisabled = !client.dispatch_enabled || recovery.length > 0 || pending.length > 0
    || Boolean(registryError) || Boolean(conversationError) || Boolean(selectedTarget && loadedConversationKey !== selectedTargetKey);
  const conversationGoals = snapshot?.goals.filter(goal => goal.accountable_ghost === selectedTarget?.ghost_id
    && goal.reply_conversation === selectedTarget?.conversation_id) ?? [];
  const goalRevisions = new Map(conversationGoals.map(goal => [goal.id, goal.revision]));
  const targetExecutions = new Set((snapshot?.work ?? [])
    .filter(work => goalRevisions.get(work.goal_id) === work.goal_revision && work.state !== "stale" && work.execution_id !== null)
    .map(work => work.execution_id!));
  const attachmentChoices = (snapshot?.artifacts ?? [])
    .filter(artifact => targetExecutions.has(artifact.producing_attempt));
  const eligibleAttachments = new Set(attachmentChoices.map(attachmentKey));
  const savedAttachments = attachmentDrafts.get(selectedTargetKey);
  const attachments = savedAttachments?.filter(artifact => eligibleAttachments.has(attachmentKey(artifact))) ?? [];
  const privacyFloor = turns.length > 0 ? conversationPrivacy : "public";
  const effectivePrivacy = atLeastPrivacy(privacy, privacyFloor, ...attachments.map(artifact => artifact.privacy));
  const awaitingController = [...turnRuns.values()].some(run => !["answered", "failed", "cancelled"].includes(run.state));
  const awaitingWork = (snapshot?.work ?? []).some(work => goalRevisions.has(work.goal_id) && !terminalWorkStates[work.state]);

  useEffect(() => {
    let mounted = true;
    if (!selectedTarget) {
      setTurns([]);
      setTurnRuns(new Map());
      setHasOlder(false);
      setOldestSequence(null);
      setLoadedConversationKey("");
      setConversationLoading(false);
      setConversationError("");
      return () => { mounted = false; };
    }
    if (loadedConversationKey !== selectedTargetKey) {
      setTurns([]);
      setTurnRuns(new Map());
    }
    setLoadedConversationKey("");
    setConversationLoading(true);
    setConversationError("");
    fetchConversationPage(client, selectedTarget).then(page => {
      if (mounted) {
        setTurns(page.turns);
        setTurnRuns(current => mergeConversationRuns(current, page.turn_runs));
        setConversationPrivacy(page.privacy);
        setHasOlder(page.has_older);
        setOldestSequence(page.oldest_sequence);
        setLoadedConversationKey(conversationTargetKey(selectedTarget));
        setConversationObservedAt(Date.now());
      }
    }).catch(reason => {
      if (mounted) {
        setConversationError(reason instanceof Error ? reason.message : "대화 기록을 불러오지 못했습니다.");
        void client.pendingCommands().then(commands => { if (mounted) setPending(commands); }).catch(() => undefined);
      }
    }).finally(() => {
      if (mounted) setConversationLoading(false);
    });
    return () => { mounted = false; };
  }, [client, selectedTarget?.ghost_id, selectedTarget?.conversation_id, conversationRefresh]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (conversationLoading || !transcript || !transcriptAtBottom.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [turns, conversationLoading, selectedPanel]);

  useEffect(() => {
    if (mode !== "live" || !selectedTarget || loading) return;
    const target = selectedTarget;
    let mounted = true;
    let timer = 0;
    async function observeProgress(): Promise<void> {
      let read: AgentStatusReadToken | null = null;
      try {
        const ownerReadPending = [...foregroundReads.current].some(read => snapshotReads.current.isCurrent(read, currentTargetKey.current));
        if (document.visibilityState !== "hidden" && !ownerReadPending) {
          read = snapshotReads.current.begin(conversationTargetKey(target));
          if (!read) return;
          const [page, latest] = await Promise.all([fetchConversationPage(client, target), client.snapshot()]);
          if (mounted && snapshotReads.current.isCurrent(read, currentTargetKey.current)) {
            setTurns(current => {
              const merged = new Map(current.map(turn => [turn.id, turn]));
              for (const turn of page.turns) merged.set(turn.id, turn);
              return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
            });
            setTurnRuns(current => mergeConversationRuns(current, page.turn_runs));
            setConversationPrivacy(page.privacy);
            setSnapshot(latest);
            const observedAt = Date.now();
            setSnapshotObservedAt(observedAt);
            setConversationObservedAt(observedAt);
            setConversationError("");
            setSyncWarning("");
          }
        }
      } catch {
        if (mounted && snapshotReads.current.isCurrent(read, currentTargetKey.current)) setSyncWarning("응답과 맡긴 일의 최신 상태를 확인하지 못했습니다. 새 실행은 요청하지 않았습니다.");
      } finally {
        if (mounted) timer = window.setTimeout(() => void observeProgress(), awaitingController || awaitingWork ? 1000 : 5000);
      }
    }
    timer = window.setTimeout(() => void observeProgress(), awaitingController || awaitingWork ? 1000 : 5000);
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [client, mode, selectedTargetKey, awaitingController, awaitingWork, loading]);

  async function loadOlderConversation(): Promise<void> {
    if (!selectedTarget || !hasOlder || oldestSequence === null || conversationLoading) return;
    const targetKey = selectedTargetKey;
    setConversationLoading(true);
    setConversationError("");
    try {
      const page = await fetchConversationPage(client, selectedTarget, oldestSequence);
      if (currentTargetKey.current !== targetKey) return;
      setTurns(current => {
        const unique = new Map(page.turns.map(turn => [turn.id, turn]));
        for (const turn of current) unique.set(turn.id, turn);
        return [...unique.values()].sort((left, right) => left.sequence - right.sequence);
      });
      setTurnRuns(current => mergeConversationRuns(current, page.turn_runs));
      setConversationPrivacy(page.privacy);
      setHasOlder(page.has_older);
      setOldestSequence(page.oldest_sequence);
    } catch (reason) {
      if (currentTargetKey.current === targetKey) setConversationError(reason instanceof Error ? reason.message : "이전 대화를 불러오지 못했습니다.");
    } finally {
      if (currentTargetKey.current === targetKey) setConversationLoading(false);
    }
  }

  async function submitConversation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedTarget) {
      setError("등록된 주 Ghost의 활성 대화를 확인할 수 없습니다.");
      return;
    }
    const capturedPrompt = prompt;
    const capturedTargetKey = selectedTargetKey;
    const capturedAttachments = attachments;
    const capturedSelection = savedAttachments;
    if (!capturedPrompt.trim() || new TextEncoder().encode(capturedPrompt).length > 65_536 || capturedAttachments.length > 16) {
      setError("메시지는 비어 있을 수 없고 UTF-8 65,536바이트 및 첨부 자료 16개 한도 안이어야 합니다.");
      return;
    }
    const response = await run("conversation.input", () => client.request({
      method: "conversation.input",
      ghost_id: selectedTarget.ghost_id,
      conversation_id: selectedTarget.conversation_id,
      text: capturedPrompt,
      privacy: effectivePrivacy,
      attachments: capturedAttachments,
    }));
    if (response?.status === "success") {
      setPrompt(current => current === capturedPrompt ? "" : current);
      updateAttachments(capturedTargetKey, current => current === capturedSelection ? undefined : current);
      setConversationRefresh(current => current + 1);
    }
  }

  async function cancelConversationTurn(turnID: string): Promise<void> {
    if (!selectedTarget) return;
    const current = turnRuns.get(turnID);
    if (!current || current.cancel_requested || ["answered", "failed", "cancelled"].includes(current.state)) return;
    const response = await run(`conversation.cancel_turn:${turnID}`, () => client.request({
      method: "conversation.cancel_turn",
      ghost_id: selectedTarget.ghost_id,
      conversation_id: selectedTarget.conversation_id,
      turn_id: turnID,
    }));
    if (response?.status === "success") setConversationRefresh(current => current + 1);
  }

  async function inspectWork(workID: string): Promise<void> {
    const work = snapshot?.work.find(item => item.id === workID);
    if (!work || !goalRevisions.has(work.goal_id)) return;
    await run(`work.inspect:${workID}`, async () => {
      const response = await client.request({ method: "work.inspect", work_id: workID });
      if (response.status !== "error") setInspectSummaries(current => new Map(current).set(workID, response.summary));
      return response;
    });
  }

  async function inspectPendingInput(envelope: Envelope): Promise<void> {
    const response = await run(`inspect:${envelope.command_id}`, () => client.retry(envelope.command_id));
    if (response?.status !== "success" || envelope.body.method !== "conversation.input") return;
    if (typeof envelope.body.text === "string") setPrompt(current => current === envelope.body.text ? "" : current);
    const { ghost_id, conversation_id } = envelope.body;
    if (typeof ghost_id === "string" && typeof conversation_id === "string") {
      updateAttachments(conversationTargetKey({ ghost_id, conversation_id }), () => undefined);
    }
    setConversationRefresh(current => current + 1);
  }

  const boardGoals = selectedPanel === "work" && snapshot ? conversationGoals.map(goal => {
    const workItems = snapshot.work.filter(work => work.goal_id === goal.id);
    return { goal, workItems, ...boardState(goal, workItems) };
  }) : [];

  const goalDetail = boardGoals.find(item => item.goal.id === goalDetailID);
  const detailGoal = goalDetail?.goal;
  const detailDraft = detailGoal && goalDrafts.get(detailGoal.id);
  const staleGoalDraft = detailDraft && detailDraft.revision !== detailGoal?.revision;
  function clearGoalDraft(id: string) {
    setGoalDrafts(current => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }
  function closeGoalDetail() {
    const id = goalDetailID;
    setGoalDetailID(null);
    requestAnimationFrame(() => {
      if (id) document.querySelector<HTMLButtonElement>(`[data-lifetime-goal="${CSS.escape(id)}"]`)?.focus();
    });
  }

  // Actual lifetime document proposals for exactly the current Primary ghost,
  // conversation and authority epoch. State is always the Host's saved state;
  // nothing here claims a save before the Owner decision is authoritative.
  const lifetimeDocumentReviews = (documentReviews ?? []).filter(review =>
    review.lifetime_origin !== undefined
    && selectedTarget !== undefined
    && review.profile_id === selectedTarget.ghost_id
    && review.conversation_id === selectedTarget.conversation_id
    && documentAuthorityEpoch !== undefined
    && review.lifetime_origin.authority_epoch === documentAuthorityEpoch
    && (review.state === "pending" || review.state === "approved" || review.state === "saved" || review.state === "declined"));
  const documentReviewStateLabels: Record<string, string> = {
    pending: "검토 대기", approved: "승인됨 · 저장 대기", saved: "저장 완료", declined: "저장하지 않음",
  };
  const agentStatus = projectAgentStatus({
    target: selectedTarget, snapshot, runs: turnRuns.values(),
    availability: loading || conversationLoading || Boolean(selectedTarget && loadedConversationKey !== selectedTargetKey) ? "loading"
      : !client.dispatch_enabled || Boolean(registryError || conversationError || syncWarning) ? "unavailable" : "current",
  });

  const feedback = <>
      {error && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{error}</span></p>}
      {syncWarning && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>{syncWarning}</span></p>}
      {notice && <p className="lifetime-notice" role="status"><Check size={16}/><span>{notice}</span></p>}
  </>;

  return <section className="lifetime-panel" aria-labelledby="lifetime-heading">
    <header className="lifetime-heading">
      <div>
        <h2 id="lifetime-heading">Ghost 작업실</h2>
      </div>
      <div className="lifetime-heading-actions">
        {onOpenHistory && historyGhostID && legacyGhostIDs.includes(historyGhostID) && <button type="button" className="button secondary" onClick={() => onOpenHistory(historyGhostID)}>이전 대화</button>}
        <button type="button" className="button secondary" onClick={() => void refresh()} disabled={refreshing || loading}>
          <RefreshCw size={14}/>{refreshing ? "새로 고치는 중" : "새로 고침"}
        </button>
      </div>
    </header>
    {mode === "fixture" && <p className="lifetime-fixture-note">예시 모드입니다. 요청은 이 브라우저의 예시 기록에만 반영되며 실제 호스트나 작업 실행자에게 전달되지 않습니다.</p>}
    {!goalDetail && feedback}
    {!client.dispatch_enabled && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>호스트 복구 모드: 저장된 상태는 읽을 수 있지만 새 변경과 재전송은 사용할 수 없습니다.</span></p>}
    {recovery.length > 0 && <section className="lifetime-outbox" aria-label="이전 연결의 미확정 요청">
      <div className="lifetime-section-heading"><div><h3>이전 요청 확인 필요</h3><p>이전 작업실 또는 권한 버전의 요청은 다시 보내지 않습니다. 확인 전까지 새 변경을 차단합니다.</p></div></div>
      {recovery.map(item => <article className="lifetime-outbox-row" key={item.id}>
        <div>
          <strong>미확정 요청 · {item.authority_epoch === null ? "권한 버전 알 수 없음" : `권한 버전 ${item.authority_epoch}`}</strong>
          <span>{item.issue ? "저장 기록을 해석할 수 없어 자동 확인할 수 없습니다." : "원래 요청 ID와 권한 버전을 보존하고 있습니다."}</span>
          <details><summary>기술 정보</summary><span>작업실 ID: {item.workspace_id ?? "알 수 없음"}</span><code>{item.command_id ?? "원래 요청 ID 알 수 없음"}</code></details>
        </div>
        <button type="button" className="button secondary" disabled={Boolean(busy) || !item.envelope || !item.command_id} onClick={() => void reconcile(item.id)}>
          <RefreshCw size={14}/>접수 기록 확인
        </button>
      </article>)}
    </section>}

    {pending.length > 0 && <section className="lifetime-outbox" aria-label="확인되지 않은 저장 요청">
      <div className="lifetime-section-heading"><div><h3>접수 결과 확인 필요</h3><p>미확정 저장 요청은 다시 보내지 않습니다. 같은 요청 ID의 접수 기록을 확인합니다.</p></div></div>
      {pending.map(envelope => <article className="lifetime-outbox-row" key={envelope.command_id}>
        <div>
          <strong>{typeof envelope.body.method === "string" ? pendingCommandLabels[envelope.body.method] ?? "저장된 요청" : "저장된 요청"}</strong>
          <span>원래 요청 ID와 권한 버전을 보존했습니다.</span>
          {envelope.body.method === "conversation.input" && <p>{String(envelope.body.text ?? "")}</p>}
          {typeof envelope.body.ghost_id === "string" && typeof envelope.body.conversation_id === "string"
            && <details><summary>저장된 대상</summary><code>{envelope.body.ghost_id} · {envelope.body.conversation_id}</code></details>}
        </div>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void (envelope.body.method === "conversation.input"
          ? inspectPendingInput(envelope)
          : run(`inspect:${envelope.command_id}`, () => client.retry(envelope.command_id)))}>
          <RefreshCw size={14}/>접수 기록 확인
        </button>
      </article>)}
    </section>}

    {snapshot && registry.length > 0 && !registryError && <section className="lifetime-roster" aria-labelledby="ghost-team-heading">
      <h3 id="ghost-team-heading" className="lifetime-roster-label">대화 상대</h3>
      <ul className="ghost-team-list">
        {[...registry].sort((left, right) => Number(right.kind === "primary") - Number(left.kind === "primary")).map(target => {
          const currentWork = snapshot.work.filter(work => work.owner === target.ghost_id
            && snapshot.goals.some(goal => goal.id === work.goal_id && goal.revision === work.goal_revision));
          const counts = [
            { label: "대기·진행", tone: "neutral", count: currentWork.filter(work => work.state === "queued" || work.state === "blocked" || movingWorkStates.has(work.state)).length },
            { label: "확인 필요", tone: "review", count: currentWork.filter(work => ["completed", "verifying", "unknown", "failed", "rejected"].includes(work.state)).length },
            { label: "검수 완료", tone: "neutral", count: currentWork.filter(work => work.state === "accepted").length },
          ];
          const key = conversationTargetKey(target);
          const roleNames: Record<string, string> = { engineering: "개발", operations: "운영", research: "조사", primary: "마스터" };
          const name = target.kind === "primary" ? "마스터" : target.roles.map(role => roleNames[role] ?? role).join(" · ") || "전문 Ghost";
          return <li className="ghost-team-row" key={key}>
            <button className="ghost-team-card" type="button" aria-pressed={key === selectedTargetKey}
              disabled={Boolean(busy) || pending.length > 0} onClick={() => setSelectedPairKey(key)}>
              <span className="ghost-team-card-heading"><strong>{name}</strong>{target.mode !== "active" && <span>접수 중지</span>}</span>
              <span className="ghost-team-counts">{counts.filter(({ count }) => count > 0).map(({ label, tone, count }) =>
                <span key={label} data-tone={tone}>{label} {count}</span>)}</span>
            </button>
          </li>;
        })}
      </ul>
    </section>}

    <nav className="lifetime-nav" aria-label="Ghost 작업실 보기">
      <button type="button" aria-pressed={selectedPanel === "conversation"} onClick={() => setSelectedPanel("conversation")}><MessageSquare size={14} aria-hidden="true"/>대화</button>
      <button type="button" aria-pressed={selectedPanel === "work"} onClick={() => setSelectedPanel("work")}><LayoutGrid size={14} aria-hidden="true"/>맡긴 일 <span>{conversationGoals.length}</span></button>
      <button type="button" aria-pressed={selectedPanel === "ghosts"} onClick={() => setSelectedPanel("ghosts")}><Settings2 size={14} aria-hidden="true"/>Ghost 관리</button>
    </nav>

    {selectedPanel === "conversation" && <section className="lifetime-conversation" aria-label="선택한 Ghost와의 대화">
      {selectedTarget && <AgentStatus key={selectedTargetKey} model={agentStatus} ghostID={selectedTarget.ghost_id}
        observedAt={Math.min(snapshotObservedAt, conversationObservedAt) || undefined} fixture={mode === 'fixture'}
        busy={Boolean(busy)} actionsDisabled={writesDisabled || loading || agentStatus.state === 'unknown' || agentStatus.state === 'stale'}
        onInspectWork={workID => void inspectWork(workID)} onCancelTurn={turnID => void cancelConversationTurn(turnID)}/>}
      {!selectedTarget && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>{activePrimary.length === 1 ? "활성 상태인 등록 대화를 선택해 주세요." : "활성 주 Ghost 대화를 하나로 확인할 수 없습니다. 등록된 대상을 직접 선택해 주세요."}</span></p>}
      {conversationError && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{conversationError}</span></p>}
      {hasOlder && oldestSequence !== null && <button type="button" className="button secondary" onClick={() => void loadOlderConversation()} disabled={conversationLoading || !selectedTarget}>이전 대화 불러오기</button>}
      {conversationLoading && <p className="lifetime-empty"><Clock3 size={16}/>저장된 대화를 불러오는 중입니다.</p>}
      {!conversationLoading && selectedTarget && turns.length === 0 && !conversationError && <p className="lifetime-empty">이 등록 대화에 아직 기록된 메시지가 없습니다.</p>}
      <div ref={transcriptRef} className="lifetime-transcript" aria-label="대화 기록" aria-live="polite" tabIndex={0}
        onScroll={event => {
          const transcript = event.currentTarget;
          transcriptAtBottom.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
        }}>
        {turns.map(turn => {
          const controller = turn.kind === "user" ? turnRuns.get(turn.id) : undefined;
          const canCancel = controller && !["answered", "failed", "cancelled"].includes(controller.state);
          return <article className="lifetime-turn" data-kind={turn.kind} key={turn.id}>
          <header>
            <strong>{turn.kind === "user" ? "나" : turn.origin_report_id ? "Ghost · 작업 보고 (원장 상태 별도 확인)" : turn.kind === "assistant_advisory" ? "Ghost · 참고 의견 (완료 검증 아님)" : "호스트 상태 기록"}</strong>
            <span>{privacyLabels[turn.privacy]} · {new Date(turn.created_at_ms).toLocaleString()}</span>
          </header>
          <p>{turn.text}</p>
          {controller && <div className="lifetime-submit-actions">
            <span>{controller.cancel_requested && canCancel ? "취소 요청됨 · 응답 중지 확인 전" : turnStateLabels[controller.state]}</span>
            {canCancel && <button type="button" className="button secondary" title="이미 맡긴 일은 맡긴 일 화면에서 따로 취소할 수 있습니다."
              aria-label={`이 응답 취소 요청 · 메시지 ${turn.sequence}`}
              disabled={writesDisabled || Boolean(busy) || controller.cancel_requested}
              onClick={() => void cancelConversationTurn(turn.id)}>이 응답 취소 요청</button>}
          </div>}
          {turn.attachments.length > 0 && <details><summary>첨부 자료 {turn.attachments.length}개</summary>
            {turn.attachments.map(artifact => <code key={`${artifact.digest}:${artifact.producing_attempt}`}>{artifact.digest} · {privacyLabels[artifact.privacy]}</code>)}
          </details>}
          <details><summary>기술 정보</summary><code>{turn.id} · {turn.sender_kind}:{turn.sender_ref} · 순서 {turn.sequence}{turn.origin_report_id && ` · 원본 보고 ${turn.origin_report_id}`}</code></details>
        </article>; })}
      </div>
      {selectedTarget && <details><summary>현재 등록된 대화 식별자</summary><code>{selectedTarget.ghost_id} · {selectedTarget.conversation_id}</code></details>}
    </section>}

    {selectedPanel === "ghosts" && <>
    {mode === 'live' && selectedTarget && <InferenceSettings pair={selectedTarget} disabled={writesDisabled || Boolean(busy)}/>}
    <section className="lifetime-outbox" aria-label="문서 저장 제안 검토">
      <div className="lifetime-section-heading"><div><h3>문서 저장 제안</h3><p>이 Ghost 대화가 현재 권한 버전에서 제안한 문서 저장 안건만 표시합니다. 저장 여부는 소유자 검토에서 직접 결정합니다.</p></div></div>
      {selectedTarget !== undefined && documentReviews !== undefined && documentAuthorityEpoch !== undefined && lifetimeDocumentReviews.length === 0
        && <p className="lifetime-empty">이 대화에 기록된 문서 저장 제안이 없습니다.</p>}
      {documentReviews === undefined && selectedTarget !== undefined
        && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>문서 저장 제안 목록을 불러올 수 없습니다. 저장 상태를 추측해 표시하지 않습니다.</span></p>}
      {lifetimeDocumentReviews.map(review => <article className="lifetime-outbox-row" key={review.id}>
        <div>
          <strong>{review.title}</strong>
          <span>{documentReviewStateLabels[review.state] ?? review.state} · {review.lifetime_origin!.turn_id} 문서 제안</span>
          <details><summary>제안 본문</summary><pre className="garden-document-source-readonly"><code>{review.body}</code></pre></details>
        </div>
        {(review.state === "pending" || review.state === "approved") && <button type="button" className="button secondary" disabled={onOpenDocumentReview === undefined}
          onClick={() => onOpenDocumentReview?.(review)}>소유자 검토 열기</button>}
      </article>)}
    </section>

    {mode === 'live' && selectedTarget && <BotRoster key={`${client.workspace_id}:${selectedTargetKey}`} client={client} target={selectedTarget}
      disabled={writesDisabled || Boolean(busy)} onRun={run}
      onSelect={target => {
        setSelectedPairKey(conversationTargetKey(target));
        setPairRefreshRequest(request => request + 1);
        setSelectedPanel("conversation");
      }}
      onCreate={() => {
        setPrompt(current => current || '이걸 봇으로 만들어 줘');
        setSelectedPanel("conversation");
        requestAnimationFrame(() => document.getElementById('lifetime-message')?.focus());
      }}/>
    }

    {memoryAction && selectedTarget && <MemorySourceReview
      profileId={selectedTarget.ghost_id}
      conversationId={selectedTarget.conversation_id}
      action={memoryAction}/>}
    </>}

    {selectedPanel === "conversation" && <form className="lifetime-submit" aria-label="메시지 보내기" onSubmit={event => void submitConversation(event)}>
      {activeTargets.length === 0 && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>메시지를 받을 수 있는 Ghost가 없습니다.</span></p>}
      <label className="lifetime-field"><span className="lifetime-visually-hidden">메시지</span><textarea id="lifetime-message" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="메시지 쓰기" required disabled={Boolean(busy)}/></label>
      <details className="lifetime-compose-options">
        <summary>전송 옵션 <span>{privacyLabels[effectivePrivacy]}{attachments.length > 0 && ` · 첨부 ${attachments.length}`}</span></summary>
        <label className="lifetime-field">대화 대상<select value={selectedTarget ? conversationTargetKey(selectedTarget) : selectedPairKey} onChange={event => setSelectedPairKey(event.target.value)} disabled={Boolean(busy) || writesDisabled && pending.length > 0}>
          <option value="">등록 대화를 선택하세요</option>
          {registry.map(target => <option value={conversationTargetKey(target)} key={conversationTargetKey(target)}>{conversationLabel(target)}{target.mode === "draining" ? " · 마무리 중" : ""}</option>)}
        </select></label>
        <div className="lifetime-form-row">
          <label className="lifetime-field">자료 범위<select value={privacy} onChange={event => setPrivacy(event.target.value as Artifact["privacy"])} disabled={Boolean(busy)}>
            <option value="local_only">이 기기에서만</option><option value="private">비공개</option><option value="public">공개 자료 허용</option>
          </select></label>
          <div className="lifetime-existing-artifacts">
            <strong>기존 자료 첨부</strong>
            {attachmentChoices.length === 0 && <span>이 대화에서 선택할 수 있는 기존 첨부 자료가 없습니다. 새 파일은 여기서 열거나 업로드하지 않습니다.</span>}
            {attachmentChoices.map(artifact => {
              const key = attachmentKey(artifact);
              const checked = attachments.some(item => attachmentKey(item) === key);
              return <label key={key}><input type="checkbox" checked={checked} disabled={Boolean(busy) || (!checked && attachments.length >= 16)}
                onChange={event => {
                  const include = event.currentTarget.checked;
                  updateAttachments(selectedTargetKey, current => {
                    const remaining = (current ?? []).filter(item => {
                      const itemKey = attachmentKey(item);
                      return eligibleAttachments.has(itemKey) && itemKey !== key;
                    });
                    return include && remaining.length < 16 ? [...remaining, artifact] : remaining;
                  });
                }}/>
                <span>{artifact.digest.slice(0, 12)} · {privacyLabels[artifact.privacy]}</span></label>;
            })}
          </div>
        </div>
        <p>대화의 기존 보호 수준은 유지됩니다. UTF-8 {new TextEncoder().encode(prompt).length}/65,536바이트.</p>
      </details>
      <div className="lifetime-submit-actions lifetime-compose-actions">
        {new TextEncoder().encode(prompt).length > 65_536 && <span role="status">메시지 한도 65,536바이트를 넘었습니다.</span>}
        <button type="submit" className="button primary" disabled={writesDisabled || Boolean(busy) || loading || !prompt.trim() || !selectedTarget || selectedTarget.mode !== "active" || new TextEncoder().encode(prompt).length > 65_536 || attachments.length > 16}>
          <Send size={14}/>{busy === "conversation.input" ? "저장 중" : "대화에 보내기"}
        </button>
      </div>
    </form>}

    {selectedPanel === "work" && <section className="lifetime-goals" aria-label="선택한 대화에서 맡긴 일" aria-busy={loading}>
      {loading && <p className="lifetime-empty"><Clock3 size={16}/>저장된 상태를 불러오는 중입니다.</p>}
      {!loading && <div className="lifetime-board">{goalStages.map(stage => {
        const goals = boardGoals.filter(goal => goal.stage === stage.id);
        return <section className="lifetime-lane" data-stage={stage.id} key={stage.id}>
          <h3>{stage.label}<span>{goals.length}</span></h3>
          {goals.length === 0 && <p className="lifetime-lane-empty">없음</p>}
          {goals.map(({ goal, state }) => <button type="button" className="lifetime-goal" data-state={state}
            data-lifetime-goal={goal.id} key={goal.id} aria-haspopup="dialog" onClick={() => setGoalDetailID(goal.id)}>
            <span className="lifetime-goal-title">{goal.prompt}</span>
            <span className="lifetime-state">{goalStateLabels[state] ?? state}</span>
            <ChevronRight size={14} aria-hidden="true"/>
          </button>)}
        </section>;
      })}</div>}
    </section>}
    {goalDetail && detailGoal && snapshot && <Modal title="목표 상세" onClose={closeGoalDetail} drawer>
      <div className="lifetime-goal-detail">
        {feedback}
        <header className="lifetime-goal-heading">
          <div><span className="lifetime-state">{goalStateLabels[goalDetail.state] ?? goalDetail.state}</span>
            <span className="lifetime-revision">판본 {detailGoal.revision}</span>
            <span className="lifetime-privacy">{privacyLabels[detailGoal.privacy]}</span></div>
          <span className="lifetime-owner">담당 {detailGoal.accountable_ghost}</span>
        </header>
        <label className="lifetime-field">목표<textarea value={detailDraft?.text ?? detailGoal.prompt}
          onChange={event => {
            const text = event.currentTarget.value;
            setGoalDrafts(current => new Map(current).set(detailGoal.id, {
              text, revision: current.get(detailGoal.id)?.revision ?? detailGoal.revision,
            }));
          }} readOnly={Boolean(busy)}/></label>
        {staleGoalDraft && <p className="lifetime-sync-warning" role="status">편집을 시작한 뒤 목표가 바뀌었습니다. 최신 목표를 불러온 뒤 다시 수정해 주세요.</p>}
        <div className="lifetime-goal-actions">
          {staleGoalDraft && <button type="button" className="button secondary" onClick={() => clearGoalDraft(detailGoal.id)}>최신 목표 불러오기</button>}
          <button type="button" className="button secondary" disabled={writesDisabled || Boolean(busy) || Boolean(staleGoalDraft)
            || !detailDraft?.text.trim() || detailDraft.text === detailGoal.prompt}
            onClick={() => {
              if (!detailDraft || staleGoalDraft) return;
              void run(`goal.update:${detailGoal.id}`, async () => {
                const response = await client.request({
                  method: "goal.update", goal_id: detailGoal.id, prompt: detailDraft.text, acceptance_spec: detailGoal.acceptance_spec,
                }, detailDraft.revision);
                if (response.status === "success") clearGoalDraft(detailGoal.id);
                return response;
              });
            }}>목표 수정</button>
        </div>
        {goalDetail.workItems.length === 0 && <p className="lifetime-empty">연결된 진행 항목이 없습니다.</p>}
        {goalDetail.workItems.map(work => <WorkItem key={work.id} work={work} snapshot={snapshot} busy={Boolean(busy)} writeDisabled={writesDisabled}
          steerDraft={steerDrafts.get(work.id) ?? ""} inspectSummary={inspectSummaries.get(work.id)}
          onSteerDraft={value => setSteerDrafts(current => new Map(current).set(work.id, value))}
          onInspect={() => void inspectWork(work.id)}
          onSteer={() => void run(`work.steer:${work.id}`, () => client.request({ method: "work.steer", work_id: work.id, prompt: steerDrafts.get(work.id) ?? "" }))}
          onCancel={() => void run(`work.cancel:${work.id}`, () => client.request({ method: "work.cancel", work_id: work.id }))}
        />)}
      </div>
    </Modal>}
  </section>;
}

function WorkItem({ work, snapshot, busy, writeDisabled, steerDraft, inspectSummary, onSteerDraft, onInspect, onSteer, onCancel }: {
  work: Work;
  snapshot: Snapshot;
  busy: boolean;
  writeDisabled: boolean;
  steerDraft: string;
  inspectSummary?: string;
  onSteerDraft(value: string): void;
  onInspect(): void;
  onSteer(): void;
  onCancel(): void;
}) {
  const acceptances = snapshot.acceptances.filter(item => item.work_id === work.id);
  const acceptedDigests = new Set(acceptances.map(item => item.artifact_digest));
  const artifacts = snapshot.artifacts.filter(item => work.execution_id !== null && item.producing_attempt === work.execution_id);
  const canCancel = !terminalWorkStates[work.state] && !pendingCancellations[work.cancellation];
  return <section className="lifetime-work" data-state={work.state} aria-label="진행 항목">
    <header className="lifetime-work-heading">
      <div><strong>{workStateLabels[work.state] ?? work.state}</strong><span>담당 {work.owner} · {work.state === "completed" ? "실행 종료 · 검수 전" : work.state === "accepted" ? "현재 목표 검수 완료" : work.execution_id ? "실행 또는 실행 결과 확인 중" : "실행 배정 대기"}</span></div>
      <button type="button" className="button secondary" onClick={onInspect} disabled={busy}><RefreshCw size={14}/>상태 확인</button>
    </header>
    {work.blocker && <p className="lifetime-blocker"><Clock3 size={14}/><span>대기 이유: {work.blocker}</span></p>}
    <p className="lifetime-cancellation">취소 상태: {cancellationLabels[work.cancellation] ?? work.cancellation}</p>
    {inspectSummary && <p className="lifetime-result-summary">{inspectSummary}</p>}
    {artifacts.length > 0 && <div className="lifetime-results"><h4>도착한 결과물</h4>{artifacts.map(artifact => {
      const accepted = acceptedDigests.has(artifact.digest);
      return <div className="lifetime-artifact" key={`${work.id}:${artifact.digest}`}>
        <div><strong>{accepted ? "검수 기록에 연결됨" : "도착함 · 수용 전"}</strong><span>{privacyLabels[artifact.privacy]} · {artifact.digest.slice(0, 12)}</span><code>{artifact.locator}</code></div>
      </div>;
    })}</div>}
    {acceptances.map(acceptance => <div className="lifetime-checks" key={`${work.id}:${acceptance.artifact_digest}`}>
      <h4>검수 결과</h4>
      {acceptance.checks.map(check => <p className={check.passed ? "lifetime-check-passed" : "lifetime-check-failed"} key={check.id}><Check size={14}/><span>{check.id}: {check.passed ? "통과" : "미통과"} · {check.evidence}</span></p>)}
    </div>)}
    {!terminalWorkStates[work.state] && <div className="lifetime-work-actions">
      <label className="lifetime-field">진행 방향<textarea value={steerDraft} onChange={event => onSteerDraft(event.target.value)} placeholder="다음 단계나 바꿀 점" disabled={busy || writeDisabled}/></label>
      <div><button type="button" className="button secondary" onClick={onSteer} disabled={busy || writeDisabled || !steerDraft.trim()}>방향 전달</button>
        {canCancel && <button type="button" className="button secondary lifetime-cancel" onClick={onCancel} disabled={busy || writeDisabled}>취소 요청</button>}</div>
    </div>}
  </section>;
}
