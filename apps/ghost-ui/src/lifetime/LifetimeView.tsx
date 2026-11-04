import { DetailDialog } from '../components/DetailDialog';
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowUp, Check, ChevronRight, CircleAlert, Clock3, GitBranch, History, Info, LayoutGrid, MessageSquare, Plus, RefreshCw, Settings2, SlidersHorizontal } from "lucide-react";
import type { Artifact, ConversationRun, Envelope, Goal, Response, Snapshot, Work } from "../../../../contracts/lifetime/bindings.ts";
import { isArtifact, isPrivacy } from "./guards";
import { atLeastPrivacy, conversationTargetKey, defaultRegistryConversation, findRegisteredConversation, mergeConversationRuns, mergeConversationTurns, parseConversationPage, parseRegistryResponse } from "./conversation";
import type { ConversationPage, ConversationTurn, RegistryConversation } from "./conversation";
import type { LifetimeClient, LifetimeMode, LifetimeRecoveryCommand } from "./types";
import type { Review, Command } from "../client/types";
import { MemorySourceReview } from "./MemorySourceReview";
import "./lifetime.css";
import { InferenceSettings } from '../pets/InferenceSettings';
import { BotRoster } from './BotRoster';
import { AgentStatus } from '../components/AgentStatus';
import { integrationApprovalTitle, type ApprovalRef } from '../plugins/approvals';
import { AgentPluginSurfaces } from '../plugins/AgentPluginSurfaces';
import type { Snapshot as WorkspaceSnapshot } from '../client/types';
import { Modal } from '../components/Modal';
import { WorkArtifactPreview } from './WorkArtifactPreview';
import { WorkThreadDrawer } from './WorkThreadDrawer';
import { followUpCommand, workThreadTitle, type FollowUpDraft } from './workThread';
import { createAgentStatusReadFence, projectAgentStatus, runAgentStatusOwnerRead } from './agentStatus';
import type { AgentStatusReadToken } from './agentStatus';

type LifetimePanel = "conversation" | "work" | "ghosts";

export interface LifetimeViewProps {
  active?: boolean;
  connected?: boolean;
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
  initialConversationID?: string;
  initialRegisterConversationID?: string;
  initialGoalID?: string;
  initialWorkID?: string;
  workScope?: 'all' | 'conversation';
  initialPanel?: LifetimePanel;
  onPanelChange?: (panel: LifetimePanel) => void;
  onOpenTarget?: (ghostID: string, conversationID: string, preserveWorkRoute?: boolean) => void;
  onDefaultGhostChange?: (ghostID: string | null) => void;
  onTargetChange?: (ghostID: string | null) => void;
  authorizedRegistration?: { ghostID: string; conversationID: string };
  onRegistrationConsumed?: (ghostID: string, conversationID: string) => void;
  onClearWorkLink?: () => void;
  workspaceSnapshot?: WorkspaceSnapshot;
  onOpenApproval?: (ref: ApprovalRef) => void;
  createRequested?: boolean;
  legacyGhostIDs?: string[];
  onOpenHistory?: (ghostID: string) => void;
}

const integrationStatusLabels = {
  pending: "승인 대기", dispatching: "실행 확인 중", sent: "응답 받음",
  failed: "실패 응답", uncertain: "결과 미확정", declined: "거절됨",
};

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
  "conversation.open": "공개 대화 만들기",
  "registry.ensure": "Ghost 대화 연결",
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
export function LifetimeView({ active: routeActive = true, mode, client, connected = true, documentReviews, documentAuthorityEpoch, onOpenDocumentReview, memoryAction, initialGhostID, initialConversationID, initialRegisterConversationID, initialGoalID, initialWorkID, workScope = 'conversation', initialPanel = "conversation", onPanelChange, onOpenTarget, onDefaultGhostChange, onTargetChange, authorizedRegistration, onRegistrationConsumed, onClearWorkLink, createRequested, legacyGhostIDs = [], onOpenHistory, workspaceSnapshot, onOpenApproval }: LifetimeViewProps) {
  const [selectedPanel, setSelectedPanel] = useState<LifetimePanel>(initialPanel);
  useEffect(() => setSelectedPanel(initialPanel), [initialPanel]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<Envelope[]>([]);
  const [recovery, setRecovery] = useState<LifetimeRecoveryCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [notice, setNotice] = useState("");
  const [promptDrafts, setPromptDrafts] = useState(() => new Map<string, string>());
  const [privacy, setPrivacy] = useState<Artifact["privacy"]>("local_only");
  const [attachmentDrafts, setAttachmentDrafts] = useState(() => new Map<string, Artifact[]>());
  const [registry, setRegistry] = useState<RegistryConversation[]>([]);
  const [registryError, setRegistryError] = useState("");
  const [registryReady, setRegistryReady] = useState(false);
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
  const [openThread, setOpenThread] = useState<{ goalID: string; scope: string } | null>(null);
  const [followUpDrafts, setFollowUpDrafts] = useState(() => new Map<string, FollowUpDraft>());
  const [inspectSummaries, setInspectSummaries] = useState<Map<string, string>>(() => new Map());
  const [selectedPairKey, setSelectedPairKey] = useState("");
  const [snapshotObservedAt, setSnapshotObservedAt] = useState(0);
  const [conversationObservedAt, setConversationObservedAt] = useState(0);
  const snapshotReads = useRef(createAgentStatusReadFence());
  const foregroundReads = useRef(new Set<AgentStatusReadToken>());
  const [pairRefreshRequest, setPairRefreshRequest] = useState(0);
  const registryRef = useRef<RegistryConversation[]>([]);
  const registrationLocks = useRef(new Set<string>());
  const automaticRegistrationAttempts = useRef(new Set<string>());
  const openedRegistration = useRef("");
  const currentRouteScope = useRef("");
  currentRouteScope.current = JSON.stringify([client.workspace_id, client.authority_epoch, routeActive, initialGhostID, initialConversationID, initialRegisterConversationID, initialPanel, initialGoalID, initialWorkID]);

  function updatePrompt(key: string, update: (current: string) => string) {
    setPromptDrafts(drafts => {
      const current = drafts.get(key) ?? "";
      const text = update(current);
      if (text === current) return drafts;
      const next = new Map(drafts);
      if (text) next.set(key, text);
      else next.delete(key);
      return next;
    });
  }

  function showPanel(panel: LifetimePanel) {
    setSelectedPanel(panel);
    onPanelChange?.(panel);
  }

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
    registryRef.current = entries;
    setRegistryReady(true);
    setRegistryError("");
    const defaultTarget = defaultRegistryConversation(entries);
    onDefaultGhostChange?.(defaultTarget?.ghost_id ?? null);
    const conversationInputs = commands.filter(command => command.body.method === "conversation.input");
    if (conversationInputs.length === 1) {
      const body = conversationInputs[0]!.body;
      const matchesExplicitTarget = !initialGhostID || body.ghost_id === initialGhostID
        && (!initialConversationID || body.conversation_id === initialConversationID);
      if (matchesExplicitTarget && typeof body.ghost_id === "string" && typeof body.conversation_id === "string") {
        const target = findRegisteredConversation(entries, body.ghost_id, body.conversation_id);
        const key = conversationTargetKey({ ghost_id: body.ghost_id, conversation_id: body.conversation_id });
        if (!target?.secondary || initialConversationID === body.conversation_id) setSelectedPairKey(key);
        const pendingText = body.text;
        if (typeof pendingText === "string") updatePrompt(key, current => current || pendingText);
        const savedAttachments = body.attachments;
        if (Array.isArray(savedAttachments) && savedAttachments.every(isArtifact)) {
          updateAttachments(key, () => savedAttachments);
        }
        if (!target?.secondary && isPrivacy(body.privacy)) setPrivacy(body.privacy);
      }
    } else if (conversationInputs.length === 0 && !selectedPairKey && !initialGhostID && defaultTarget) {
      setSelectedPairKey(conversationTargetKey(defaultTarget));
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
        client.request({ method: "registry.inspect", ...(mode === "live" ? { include_secondary: true } : {}) }),
      ]),
      onSuccess: ([latest, commands, unresolved, registryResponse], read) => acceptLatest(read, latest, commands, unresolved, registryResponse),
      onError: reason => {
        const message = reason instanceof Error ? reason.message : "최신 상태를 불러오지 못했습니다.";
        setRegistryError(message);
        setRegistryReady(false);
        setSyncWarning(message);
      },
      onSettled: () => setLoading(false),
    });
  }

  useEffect(() => {
    if (!routeActive) return;
    snapshotReads.current.activate();
    setLoading(true);
    setRegistryReady(false);
    void runAgentStatusOwnerRead({
      fence: snapshotReads.current, foregroundReads: foregroundReads.current,
      currentScope: () => currentTargetKey.current,
      fetch: () => Promise.all([client.snapshot(), client.pendingCommands(), client.recoveryCommands(),
        client.request({ method: "registry.inspect", ...(mode === "live" ? { include_secondary: true } : {}) })]),
      onSuccess: ([latest, commands, unresolved, registryResponse], read) => {
        const applied = acceptLatest(read, latest, commands, unresolved, registryResponse);
        if (applied) setError("");
        return applied;
      },
      onError: reason => {
        const message = reason instanceof Error ? reason.message : "지속 작업을 불러오지 못했습니다.";
        setError(message);
        setRegistryError(message);
        setRegistryReady(false);
      },
      onSettled: () => setLoading(false),
    });
    return () => { snapshotReads.current.deactivate(); };
  }, [routeActive, client, mode]);

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

  function openRegisteredTarget(target: RegistryConversation, preserveWorkRoute = true): void {
    const key = conversationTargetKey(target);
    setSelectedPairKey(key);
    setSelectedPanel("conversation");
    openedRegistration.current = key;
    if (onOpenTarget) onOpenTarget(target.ghost_id, target.conversation_id, preserveWorkRoute);
    else onPanelChange?.("conversation");
  }

  async function openPublicConversation(): Promise<void> {
    if (!defaultTarget || publicOpenDisabled || registrationLocks.current.has("conversation.open")) return;
    const sourceRoute = currentRouteScope.current;
    const ghostID = defaultTarget.ghost_id;
    const conversationID = crypto.randomUUID();
    registrationLocks.current.add("conversation.open");
    try {
      await run("conversation.open", () => client.request({ method: "conversation.open", ghost_id: ghostID, conversation_id: conversationID }));
      const opened = findRegisteredConversation(registryRef.current, ghostID, conversationID);
      if (opened?.secondary && opened.mode === "active" && currentRouteScope.current === sourceRoute) openRegisteredTarget(opened, false);
    } finally {
      registrationLocks.current.delete("conversation.open");
    }
  }

  async function ensureProfileConversation(profileID: string, conversationID: string): Promise<void> {
    const sourceRoute = currentRouteScope.current;
    const profile = workspaceSnapshot?.profiles.find(item => item.id === profileID);
    if (!profile) { setError("Ghost 목록을 새로 고친 뒤 다시 시도해 주세요."); return; }
    if (!registryReady || loading || refreshing || registryError) { setError("Host의 등록 대화 목록을 먼저 새로 고쳐 주세요."); return; }
    const existing = registryRef.current.filter(item => item.ghost_id === profileID);
    const alreadyActive = existing.find(item => item.mode === "active" && !item.secondary);
    if (alreadyActive) { openRegisteredTarget(alreadyActive, false); return; }
    if (existing.length) { setError("이 Ghost의 등록 대화가 마무리 중입니다. 새 대화를 연결할 수 없습니다."); return; }
    if (!connected || !client.dispatch_enabled || pending.length || recovery.length || busy || registryError) {
      setError("연결과 저장 요청을 확인한 뒤 다시 시도해 주세요.");
      return;
    }
    if (registrationLocks.current.has(profileID)) return;
    registrationLocks.current.add(profileID);
    try {
      await run(`registry.ensure:${profileID}`, () => client.request({
        method: "registry.ensure", ghost_id: profileID, kind: "specialist",
        conversation_id: conversationID, roles: [],
      }));
      const refreshed = findRegisteredConversation(registryRef.current, profileID);
      if (refreshed?.mode === "active" && routeActive && currentRouteScope.current === sourceRoute) openRegisteredTarget(refreshed, false);
      else if (registryRef.current.some(item => item.ghost_id === profileID)) {
        setError("이 Ghost의 기존 등록은 마무리 중입니다. Host 상태를 확인해 주세요.");
      }
    } finally {
      registrationLocks.current.delete(profileID);
    }
  }

  useEffect(() => {
    const authorized = authorizedRegistration;
    if (!routeActive || !authorized || authorized.ghostID !== initialGhostID
      || authorized.conversationID !== initialRegisterConversationID
      || !registryReady || loading || refreshing || registryError
      || pending.length || recovery.length || busy) return;
    const attemptKey = `${authorized.ghostID}:${authorized.conversationID}`;
    if (automaticRegistrationAttempts.current.has(attemptKey)) return;
    const existing = registryRef.current.filter(item => item.ghost_id === authorized.ghostID);
    const active = existing.find(item => item.mode === "active" && !item.secondary);
    if (active) {
      automaticRegistrationAttempts.current.add(attemptKey);
      onRegistrationConsumed?.(authorized.ghostID, authorized.conversationID);
      openRegisteredTarget(active, false);
      return;
    }
    if (existing.length || !workspaceSnapshot?.profiles.some(profile => profile.id === authorized.ghostID)) return;
    automaticRegistrationAttempts.current.add(attemptKey);
    onRegistrationConsumed?.(authorized.ghostID, authorized.conversationID);
    void ensureProfileConversation(authorized.ghostID, authorized.conversationID);
  }, [routeActive, authorizedRegistration, initialGhostID, initialRegisterConversationID, registryReady, loading, refreshing, registryError, pending.length, recovery.length, busy, registry, workspaceSnapshot, connected]);

  useEffect(() => {
    if (!routeActive || !initialGhostID || initialPanel !== 'conversation' || !registryReady) return;
    const active = findRegisteredConversation(registryRef.current, initialGhostID, initialConversationID);
    if (active?.mode !== "active") return;
    const key = conversationTargetKey(active);
    if (openedRegistration.current === key) return;
    openedRegistration.current = key;
    // Read-only recovery from a lost ensure response is safe after inspect confirms it.
    openRegisteredTarget(active);
  }, [routeActive, registryReady, registry, initialGhostID, initialConversationID, initialRegisterConversationID, initialPanel]);

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
  const defaultTarget = defaultRegistryConversation(registry);
  const appliedEntry = useRef('');
  useEffect(() => {
    const entry = JSON.stringify([initialGhostID, initialConversationID, initialPanel, Boolean(createRequested)]);
    if (!registryReady || appliedEntry.current === entry) return;
    const requested = initialGhostID
      ? findRegisteredConversation(registry, initialGhostID, initialConversationID)
      : defaultTarget;
    if (!requested) {
      if (initialGhostID) {
        setSelectedPairKey('');
        if (initialPanel !== 'work' && workspaceSnapshot?.profiles.some(profile => profile.id === initialGhostID)) setSelectedPanel("ghosts");
      }
      appliedEntry.current = entry;
      return;
    }
    const key = conversationTargetKey(requested);
    setSelectedPairKey(key);
    if (createRequested) {
      setGoalDetailID(null);
      setSelectedPanel("conversation");
      updatePrompt(key, current => current || '이걸 봇으로 만들어 줘');
    }
    appliedEntry.current = entry;
  }, [initialGhostID, initialConversationID, createRequested, initialPanel, registry, registryReady, workspaceSnapshot]);
  const explicitTarget = initialGhostID
    ? findRegisteredConversation(registry, initialGhostID, initialConversationID)
    : undefined;
  const selectedTarget = initialGhostID ? explicitTarget
    : selectedPairKey ? registry.find(target => conversationTargetKey(target) === selectedPairKey)
      : defaultTarget;
  const publicConversation = selectedTarget?.secondary === true;
  const selectedTargetKey = selectedTarget ? conversationTargetKey(selectedTarget) : "";
  const threadAuthority = JSON.stringify([client.workspace_id, client.actor_ref, client.authority_epoch]);
  const threadScope = JSON.stringify([threadAuthority, selectedTargetKey, selectedPanel, currentRouteScope.current]);
  const threadID = routeActive && openThread?.scope === threadScope ? openThread.goalID : null;
  useEffect(() => setOpenThread(null), [threadScope, client]);
  function openWorkThread(goalID: string) {
    setError("");
    setNotice("");
    setOpenThread({ goalID, scope: threadScope });
  }
  function updateFollowUp(goalID: string, update: (current: FollowUpDraft | undefined) => FollowUpDraft | undefined) {
    const key = JSON.stringify([threadAuthority, goalID]);
    setFollowUpDrafts(current => {
      const before = current.get(key);
      const after = update(before);
      if (after === before) return current;
      const next = new Map(current);
      if (after?.text) next.set(key, after);
      else next.delete(key);
      return next;
    });
  }
  async function sendFollowUp(goal: Goal, draft: FollowUpDraft) {
    const body = followUpCommand(goal, draft);
    if (!body || writesDisabled) return;
    const response = await run(`goal.update:${goal.id}`, () => client.request(body, draft.revision));
    if (response?.status === "success") updateFollowUp(goal.id, current => current === draft ? undefined : current);
  }
  useEffect(() => { onTargetChange?.(routeActive ? selectedTarget?.ghost_id ?? null : null); }, [routeActive, selectedTarget?.ghost_id, onTargetChange]);
  const prompt = promptDrafts.get(selectedTargetKey) ?? "";
  const currentTargetKey = useRef(selectedTargetKey);
  const previousTargetKey = useRef(selectedTargetKey);
  const historyGhostID = selectedTarget?.ghost_id ?? initialGhostID;
  currentTargetKey.current = selectedTargetKey;
  useLayoutEffect(() => {
    if (previousTargetKey.current !== selectedTargetKey) {
      snapshotReads.current.invalidate();
      setPrivacy("local_only");
      setGoalDetailID(null);
      previousTargetKey.current = selectedTargetKey;
      if (loading) void loadLatest();
    }
  }, [selectedTargetKey]);
  const writesDisabled = !connected || !client.dispatch_enabled || recovery.length > 0 || pending.length > 0
    || Boolean(registryError || syncWarning) || Boolean(conversationError) || Boolean(selectedTarget && loadedConversationKey !== selectedTargetKey);
  const publicOpenDisabled = !routeActive || !defaultTarget || !registryReady || loading || refreshing || Boolean(busy) || writesDisabled;
  const conversationGoals = snapshot?.goals.filter(goal => goal.accountable_ghost === selectedTarget?.ghost_id
    && goal.reply_conversation === selectedTarget?.conversation_id) ?? [];
  const goalRevisions = new Map(conversationGoals.map(goal => [goal.id, goal.revision]));
  const targetExecutions = new Set((snapshot?.work ?? [])
    .filter(work => goalRevisions.get(work.goal_id) === work.goal_revision && work.state !== "stale" && work.execution_id !== null)
    .map(work => work.execution_id!));
  const attachmentChoices = (snapshot?.artifacts ?? [])
    .filter(artifact => targetExecutions.has(artifact.producing_attempt) && (!publicConversation || artifact.privacy === "public"));
  const eligibleAttachments = new Set(attachmentChoices.map(attachmentKey));
  const savedAttachments = attachmentDrafts.get(selectedTargetKey);
  const attachments = savedAttachments?.filter(artifact => eligibleAttachments.has(attachmentKey(artifact))) ?? [];
  const privacyFloor = turns.length > 0 ? conversationPrivacy : "public";
  const effectivePrivacy = atLeastPrivacy(publicConversation ? "public" : privacy, privacyFloor, ...attachments.map(artifact => artifact.privacy));
  const awaitingController = [...turnRuns.values()].some(run => !["answered", "failed", "cancelled"].includes(run.state));
  const awaitingWork = (snapshot?.work ?? []).some(work => goalRevisions.has(work.goal_id) && !terminalWorkStates[work.state]);
  const awaitingAllWork = Boolean(snapshot && snapshot.work.some(work => !terminalWorkStates[work.state]
    && snapshot.goals.some(goal => goal.id === work.goal_id && goal.revision === work.goal_revision)));

  useEffect(() => {
    let mounted = true;
    if (!routeActive || !selectedTarget) {
      setTurns([]);
      setTurnRuns(new Map());
      setHasOlder(false);
      setOldestSequence(null);
      setLoadedConversationKey("");
      setConversationLoading(false);
      setConversationError("");
      return () => { mounted = false; };
    }
    const sameTarget = loadedConversationKey === selectedTargetKey;
    if (!sameTarget) {
      setTurns([]);
      setTurnRuns(new Map());
      setHasOlder(false);
      setOldestSequence(null);
      setLoadedConversationKey("");
    }
    setConversationLoading(true);
    setConversationError("");
    fetchConversationPage(client, selectedTarget).then(page => {
      if (mounted) {
        setTurns(current => sameTarget ? mergeConversationTurns(current, page.turns) : page.turns);
        setTurnRuns(current => mergeConversationRuns(current, page.turn_runs));
        setConversationPrivacy(page.privacy);
        if (!sameTarget || oldestSequence === null) {
          setHasOlder(page.has_older);
          setOldestSequence(page.oldest_sequence);
        }
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
  }, [routeActive, client, selectedTarget?.ghost_id, selectedTarget?.conversation_id, conversationRefresh]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (conversationLoading || !transcript || !transcriptAtBottom.current) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [turns, conversationLoading, selectedPanel]);

  useEffect(() => {
    if (!routeActive || mode !== "live" || !selectedTarget || loadedConversationKey !== selectedTargetKey || loading || selectedPanel === 'work' && workScope === 'all') return;
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
            setTurns(current => mergeConversationTurns(current, page.turns));
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
  }, [routeActive, client, mode, selectedTargetKey, loadedConversationKey, awaitingController, awaitingWork, loading, selectedPanel, workScope]);

  const workBoardRouteScope = currentRouteScope.current;
  useEffect(() => {
    if (!routeActive || mode !== 'live' || selectedPanel !== 'work' || workScope !== 'all' || loading) return;
    let mounted = true;
    let timer = 0;
    const routeScope = workBoardRouteScope;
    async function observeBoard(): Promise<void> {
      let read: AgentStatusReadToken | null = null;
      try {
        const ownerReadPending = [...foregroundReads.current].some(token => snapshotReads.current.isCurrent(token, currentTargetKey.current));
        if (document.visibilityState !== 'hidden' && !ownerReadPending) {
          read = snapshotReads.current.begin(currentTargetKey.current);
          if (!read) return;
          foregroundReads.current.add(read);
          const latest = await client.snapshot();
          if (mounted && routeScope === currentRouteScope.current && snapshotReads.current.isCurrent(read, currentTargetKey.current)) {
            setSnapshot(latest);
            setSnapshotObservedAt(Date.now());
            setSyncWarning('');
          }
        }
      } catch {
        if (mounted && routeScope === currentRouteScope.current && snapshotReads.current.isCurrent(read, currentTargetKey.current)) setSyncWarning('작업판의 최신 상태를 확인하지 못했습니다. 새 실행은 요청하지 않았습니다.');
      } finally {
        if (read) foregroundReads.current.delete(read);
        if (mounted) timer = window.setTimeout(() => void observeBoard(), document.visibilityState === 'hidden' ? 10000 : awaitingAllWork ? 1500 : 5000);
      }
    }
    timer = window.setTimeout(() => void observeBoard(), document.visibilityState === 'hidden' ? 10000 : awaitingAllWork ? 1500 : 5000);
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [routeActive, client, mode, selectedPanel, workScope, loading, awaitingAllWork, selectedTargetKey, workBoardRouteScope]);

  async function loadOlderConversation(): Promise<void> {
    if (!selectedTarget || !hasOlder || oldestSequence === null || conversationLoading) return;
    const targetKey = selectedTargetKey;
    setConversationLoading(true);
    setConversationError("");
    try {
      const page = await fetchConversationPage(client, selectedTarget, oldestSequence);
      if (currentTargetKey.current !== targetKey) return;
      setTurns(current => mergeConversationTurns(current, page.turns));
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
      setError("선택한 Ghost의 활성 대화를 확인할 수 없습니다. 대시보드에서 이 Ghost를 열고 대화를 연결해 주세요.");
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
    if (submissionBlocked) return;
    const response = await run("conversation.input", () => client.request({
      method: "conversation.input",
      ghost_id: selectedTarget.ghost_id,
      conversation_id: selectedTarget.conversation_id,
      text: capturedPrompt,
      privacy: effectivePrivacy,
      attachments: capturedAttachments,
    }));
    if (response?.status === "success") {
      updatePrompt(capturedTargetKey, current => current === capturedPrompt ? "" : current);
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
    if (!work || !snapshot?.goals.some(goal => goal.id === work.goal_id && goal.revision === work.goal_revision)) return;
    await run(`work.inspect:${workID}`, async () => {
      const response = await client.request({ method: "work.inspect", work_id: workID });
      if (response.status !== "error") setInspectSummaries(current => new Map(current).set(workID, response.summary));
      return response;
    });
  }

  async function inspectPendingCommand(envelope: Envelope): Promise<void> {
    const response = await run(`inspect:${envelope.command_id}`, () => client.retry(envelope.command_id));
    if (response?.status !== "success") return;
    if (envelope.body.method === "goal.update") {
      const { goal_id, follow_up } = envelope.body;
      if (typeof goal_id === "string" && typeof follow_up === "string") {
        updateFollowUp(goal_id, current => current?.revision === envelope.expected_revision && current.text.trim() === follow_up ? undefined : current);
      }
      return;
    }
    if (envelope.body.method !== "conversation.input") return;
    const { ghost_id, conversation_id, text } = envelope.body;
    if (typeof ghost_id === "string" && typeof conversation_id === "string") {
      const key = conversationTargetKey({ ghost_id, conversation_id });
      if (typeof text === "string") updatePrompt(key, current => current === text ? "" : current);
      updateAttachments(key, () => undefined);
    }
    setConversationRefresh(current => current + 1);
  }

  const boardSourceGoals = workScope === 'all' ? snapshot?.goals ?? [] : conversationGoals;
  const boardGoals = selectedPanel === "work" && snapshot ? boardSourceGoals.map(goal => {
    const workItems = snapshot.work.filter(work => work.goal_id === goal.id);
    return { goal, workItems, ...boardState(goal, workItems) };
  }) : [];

  const appliedGoalLink = useRef('');
  useEffect(() => {
    if (!routeActive || selectedPanel !== 'work' || !initialGoalID || loading || !snapshot) return;
    const key = `${initialGoalID}:${initialWorkID ?? ''}:${workScope}`;
    if (appliedGoalLink.current === key) return;
    const goal = boardGoals.find(item => item.goal.id === initialGoalID);
    if (!goal) return;
    appliedGoalLink.current = key;
    setGoalDetailID(goal.goal.id);
  }, [routeActive, selectedPanel, initialGoalID, initialWorkID, workScope, loading, snapshot, boardGoals]);

  const goalDetail = boardGoals.find(item => item.goal.id === goalDetailID);
  const detailGoal = goalDetail?.goal;
  const detailDraft = detailGoal && goalDrafts.get(detailGoal.id);
  const staleGoalDraft = detailDraft && detailDraft.revision !== detailGoal?.revision;
  const focusedWorkLink = useRef('');
  useEffect(() => {
    if (routeActive) return;
    setGoalDetailID(null);
    appliedGoalLink.current = '';
    focusedWorkLink.current = '';
  }, [routeActive]);
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
    appliedGoalLink.current = '';
    focusedWorkLink.current = '';
    onClearWorkLink?.();
    requestAnimationFrame(() => {
      if (id) document.querySelector<HTMLButtonElement>(`[data-lifetime-goal="${CSS.escape(id)}"]`)?.focus();
    });
  }

  useEffect(() => {
    if (!routeActive || !initialGoalID || !initialWorkID || goalDetailID !== initialGoalID || !goalDetail?.workItems.some(work => work.id === initialWorkID)) return;
    const key = `${initialGoalID}:${initialWorkID}`;
    if (focusedWorkLink.current === key) return;
    focusedWorkLink.current = key;
    requestAnimationFrame(() => {
      const item = document.querySelector<HTMLElement>(`[data-lifetime-work="${CSS.escape(initialWorkID)}"]`);
      item?.scrollIntoView({ block: 'nearest' });
      item?.focus({ preventScroll: true });
    });
  }, [routeActive, initialGoalID, initialWorkID, goalDetailID, goalDetail]);

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

  const pendingDocumentReviews = lifetimeDocumentReviews.filter(review => review.state === "pending" || review.state === "approved");
  const integrationReviews = (workspaceSnapshot?.integrationApprovals ?? []).filter(review =>
    review.ghost_id === selectedTarget?.ghost_id && review.conversation_id === selectedTarget?.conversation_id);
  const submissionBlocked = writesDisabled || Boolean(busy) || loading || !prompt.trim()
    || selectedTarget?.mode !== "active" || publicConversation && effectivePrivacy !== "public"
    || new TextEncoder().encode(prompt).length > 65_536 || attachments.length > 16;
  const ghostName = (id: string) => workspaceSnapshot?.profiles.find(profile => profile.id === id)?.name ?? id;
  const publicLabel = (target: RegistryConversation) => registry.filter(item => item.ghost_id === target.ghost_id && item.secondary).length > 1
    ? `공개 대화 ${target.conversation_id.slice(0, 8)}` : "공개 대화";
  const chatTitle = selectedTarget
    ? `${workspaceSnapshot?.profiles.find(profile => profile.id === selectedTarget.ghost_id)?.name ?? "Ghost"}${publicConversation ? ` · ${publicLabel(selectedTarget)}` : ""}`
    : "대화";
  const feedback = <>
      {error && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{error}</span></p>}
      {syncWarning && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>{syncWarning}</span></p>}
      {notice && <p className="lifetime-notice" role="status"><Check size={16}/><span>{notice}</span></p>}
  </>;

  const inConversation = selectedPanel === "conversation";
  const displayedTurns = routeActive && loadedConversationKey === selectedTargetKey ? turns : [];
  return <section className="lifetime-panel" data-panel={selectedPanel} aria-labelledby="lifetime-heading">
    <header className={`lifetime-heading${inConversation ? " thread-toolbar" : ""}`}>
      <div>
        <h2 id="lifetime-heading">{selectedPanel === "conversation" ? chatTitle : selectedPanel === "work" ? "맡긴 일" : "Ghost 관리"}</h2>
      </div>
      <div className="lifetime-heading-actions">
        {inConversation && mode === "live" && client.actor_ref === "owner" && defaultTarget && selectedTarget?.ghost_id === defaultTarget.ghost_id &&
          <button type="button" className="button secondary" onClick={() => void openPublicConversation()}
            disabled={publicOpenDisabled} aria-label="새 공개 대화" title="새 공개 대화">
            <Plus size={14}/><span className="thread-toolbar-label">새 공개 대화</span>
          </button>}
        <button type="button" className="button secondary" onClick={() => showPanel(inConversation ? "ghosts" : "conversation")}
          aria-label={inConversation ? "Ghost 관리" : "대화"} title={inConversation ? "Ghost 관리" : "대화"}>
          {inConversation ? <Settings2 size={14}/> : <MessageSquare size={14}/>}
          <span className="thread-toolbar-label">{inConversation ? "Ghost 관리" : "대화"}</span>
        </button>
        {(!onPanelChange || selectedTarget?.kind === "specialist") && selectedPanel !== "work" && <button type="button" className="button secondary" onClick={() => showPanel("work")} aria-label="맡긴 일" title="맡긴 일"><LayoutGrid size={14}/><span className="thread-toolbar-label">맡긴 일</span></button>}
        {!publicConversation && onOpenHistory && historyGhostID && legacyGhostIDs.includes(historyGhostID) && <button type="button" className="button secondary" onClick={() => onOpenHistory(historyGhostID)} aria-label="이전 대화" title="이전 대화"><History size={14}/><span className="thread-toolbar-label">이전 대화</span></button>}
        <button type="button" className={inConversation ? "icon-button" : "button secondary"} onClick={() => void refresh()}
          aria-label={refreshing ? "새로 고치는 중" : "새로 고침"} title="새로 고침" disabled={refreshing || loading}>
          <RefreshCw size={14}/>{!inConversation && (refreshing ? "새로 고치는 중" : "새로 고침")}
        </button>
      </div>
    </header>
    {mode === "fixture" && <p className="lifetime-fixture-note">예시 모드입니다. 요청은 이 브라우저의 예시 기록에만 반영되며 실제 호스트나 작업 실행자에게 전달되지 않습니다.</p>}
    {!goalDetail && !threadID && feedback}
    {!client.dispatch_enabled && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>호스트 복구 모드: 저장된 상태는 읽을 수 있지만 새 변경과 재전송은 사용할 수 없습니다.</span></p>}
    {recovery.length > 0 && <section className="lifetime-outbox" aria-label="이전 연결의 미확정 요청">
      <div className="lifetime-section-heading"><div><h3>이전 요청 확인 필요</h3><p>이전 작업실 또는 권한 버전의 요청은 다시 보내지 않습니다. 확인 전까지 새 변경을 차단합니다.</p></div></div>
      {recovery.map(item => <article className="lifetime-outbox-row" key={item.id}>
        <div>
          <strong>미확정 요청 · {item.authority_epoch === null ? "권한 버전 알 수 없음" : `권한 버전 ${item.authority_epoch}`}</strong>
          <span>{item.issue ? "저장 기록을 해석할 수 없어 자동 확인할 수 없습니다." : "원래 요청 ID와 권한 버전을 보존하고 있습니다."}</span>
          <DetailDialog title="기술 정보"><span>작업실 ID: {item.workspace_id ?? "알 수 없음"}</span><code>{item.command_id ?? "원래 요청 ID 알 수 없음"}</code></DetailDialog>
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
          <strong>{typeof envelope.body.follow_up === "string" && envelope.body.method === "goal.update" ? "후속 지시"
            : typeof envelope.body.method === "string" ? pendingCommandLabels[envelope.body.method] ?? "저장된 요청" : "저장된 요청"}</strong>
          <span>원래 요청 ID와 권한 버전을 보존했습니다.</span>
          {envelope.body.method === "conversation.input" && <p>{String(envelope.body.text ?? "")}</p>}
          {typeof envelope.body.ghost_id === "string" && typeof envelope.body.conversation_id === "string"
            && <DetailDialog title="저장된 대상"><code>{envelope.body.ghost_id} · {envelope.body.conversation_id}</code></DetailDialog>}
        </div>
        <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => void inspectPendingCommand(envelope)}>
          <RefreshCw size={14}/>접수 기록 확인
        </button>
      </article>)}
    </section>}

    {selectedPanel === "ghosts" && snapshot && workspaceSnapshot && registryReady && !registryError && <section className="lifetime-roster" aria-labelledby="ghost-team-heading">
      <h3 id="ghost-team-heading" className="lifetime-roster-label">Ghost 목록</h3>
      <ul className="ghost-team-list">
        {workspaceSnapshot.profiles.map(profile => {
          const entries = registry.filter(target => target.ghost_id === profile.id);
          const target = findRegisteredConversation(entries, profile.id);
          const currentWork = snapshot.work.filter(work => work.owner === profile.id
            && snapshot.goals.some(goal => goal.id === work.goal_id && goal.revision === work.goal_revision));
          const counts = [
            { label: "대기·진행", tone: "neutral", count: currentWork.filter(work => work.state === "queued" || work.state === "blocked" || movingWorkStates.has(work.state)).length },
            { label: "확인 필요", tone: "review", count: currentWork.filter(work => ["completed", "verifying", "unknown", "failed", "rejected"].includes(work.state)).length },
            { label: "검수 완료", tone: "neutral", count: currentWork.filter(work => work.state === "accepted").length },
          ];
          const key = target ? conversationTargetKey(target) : "";
          return <li className="ghost-team-row" key={profile.id}>
            {target?.mode === "active" ? <button className="ghost-team-card" type="button" aria-pressed={key === selectedTargetKey}
              onClick={() => openRegisteredTarget(target, false)}>
              <span className="ghost-team-card-heading"><strong>{profile.name}{target.kind === 'primary' && <span className="ghost-default-badge">기본</span>}</strong></span>
              <span className="ghost-team-counts">{counts.filter(({ count }) => count > 0).map(({ label, tone, count }) =>
                <span key={label} data-tone={tone}>{label} {count}</span>)}</span>
            </button> : <div className="ghost-team-card ghost-team-card--unregistered">
              <span className="ghost-team-card-heading"><strong>{profile.name}</strong><small>{profile.persona}</small></span>
              {target ? <span className="ghost-team-registration-state">등록 대화 마무리 중</span> : <div className="ghost-team-actions">
                <button type="button" className="button primary" disabled={!connected || !client.dispatch_enabled || loading || refreshing || Boolean(busy) || pending.length > 0 || recovery.length > 0}
                  onClick={() => void ensureProfileConversation(profile.id, crypto.randomUUID())}>새 대화 연결</button>
                {profile.conversations.length > 0 && <button type="button" className="button secondary" onClick={() => onOpenHistory?.(profile.id)}>이전 대화 {profile.conversations.length}</button>}
              </div>}
            </div>}
          </li>;
        })}
      </ul>
    </section>}

    {selectedPanel === "conversation" && <section className="lifetime-conversation" aria-label="선택한 Ghost와의 대화">
      {selectedTarget && <AgentStatus key={selectedTargetKey} model={agentStatus} ghostID={selectedTarget.ghost_id}
        observedAt={Math.min(snapshotObservedAt, conversationObservedAt) || undefined} fixture={mode === 'fixture'}
        busy={Boolean(busy)} actionsDisabled={writesDisabled || loading || agentStatus.state === 'unknown' || agentStatus.state === 'stale'}
        onInspectWork={workID => void inspectWork(workID)} onCancelTurn={turnID => void cancelConversationTurn(turnID)}/>}
      {onOpenApproval && (pendingDocumentReviews.length > 0 || integrationReviews.length > 0) && <div className="lifetime-chat-approvals" aria-label="이 대화의 확인할 일">
        {pendingDocumentReviews.map(review => <button type="button" className="button secondary" key={review.id}
          onClick={() => onOpenApproval({ kind: "document", id: review.id })}>{review.title} · {review.state === "pending" ? "검토 대기" : "저장 대기"}</button>)}
        {integrationReviews.slice(0, 5).map(review => <button type="button" className="button secondary" key={review.id}
          onClick={() => onOpenApproval({ kind: "integration", id: review.id })}>{integrationApprovalTitle(review.tool)} · {integrationStatusLabels[review.state]}</button>)}
      </div>}
      {!selectedTarget && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>{initialGhostID ? "이 Ghost에 활성 대화가 없습니다. 대시보드에서 이 Ghost를 열고 새 대화를 연결해 주세요." : "활성 대화를 확인할 수 없습니다. 대시보드에서 Ghost를 선택해 주세요."}</span></p>}
      {conversationError && <p className="lifetime-alert" role="alert"><CircleAlert size={16}/><span>{conversationError}</span></p>}
      {hasOlder && oldestSequence !== null && <button type="button" className="button secondary" onClick={() => void loadOlderConversation()} disabled={conversationLoading || !selectedTarget}>이전 대화 불러오기</button>}
      {conversationLoading && <p className="lifetime-empty"><Clock3 size={16}/>저장된 대화를 불러오는 중입니다.</p>}
      {!conversationLoading && selectedTarget && turns.length === 0 && !conversationError && <p className="lifetime-empty thread-empty">이 대화에 아직 메시지가 없습니다.</p>}
      <div ref={transcriptRef} className="lifetime-transcript thread-messages" role="log" aria-label="대화 기록" aria-live="polite" tabIndex={0}
        onScroll={event => {
          const transcript = event.currentTarget;
          transcriptAtBottom.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
        }}>
        {displayedTurns.map(turn => {
          const controller = turn.kind === "user" ? turnRuns.get(turn.id) : undefined;
          const canCancel = controller && !["answered", "failed", "cancelled"].includes(controller.state);
          const eventLabel = turn.origin_report_id ? "작업 보고" : turn.kind === "assistant_advisory" ? "참고 의견" : "호스트 상태 기록";
          const recordedAt = new Date(turn.created_at_ms).toLocaleString();
          return <article className="lifetime-turn thread-turn" data-kind={turn.kind} key={turn.id}
            aria-label={turn.kind === "user" ? "나" : eventLabel}>
          {(turn.kind === "host_fact" || turn.origin_report_id) && <strong className="thread-event-label">
            {eventLabel}{turn.origin_report_id && " · 검수 상태 별도"}
          </strong>}
          <p className="thread-body">{turn.text}</p>
          {Boolean(turn.work_thread_ids?.length) && <div className="lifetime-thread-links">
            {turn.work_thread_ids?.map((id, index) => {
              const goal = conversationGoals.find(item => item.id === id);
              const title = goal ? workThreadTitle(goal.prompt) : turn.work_thread_ids!.length > 1 ? `작업 스레드 ${index + 1}` : "작업 스레드";
              const state = goal && boardState(goal, snapshot?.work.filter(work => work.goal_id === id) ?? []).state;
              return <button type="button" className="lifetime-thread-link" key={id} aria-haspopup="dialog"
                onClick={() => openWorkThread(id)} aria-label={goal ? `작업 스레드 열기: ${title}${state ? ` · ${goalStateLabels[state] ?? state}` : ""}` : `${title} 열기`} title={title}>
                <GitBranch size={14} aria-hidden="true"/><span>{title}</span>
                {state && <small>{goalStateLabels[state] ?? state}</small>}
                <ChevronRight size={14} aria-hidden="true"/>
              </button>;
            })}
          </div>}
          {controller && <div className="lifetime-submit-actions thread-turn-actions">
            <span>{controller.cancel_requested && canCancel ? "취소 요청됨 · 응답 중지 확인 전" : turnStateLabels[controller.state]}</span>
            {canCancel && <button type="button" className="button secondary" title="이미 맡긴 일은 맡긴 일 화면에서 따로 취소할 수 있습니다."
              aria-label={`이 응답 취소 요청 · 메시지 ${turn.sequence}`}
              disabled={writesDisabled || Boolean(busy) || controller.cancel_requested}
              onClick={() => void cancelConversationTurn(turn.id)}>이 응답 취소 요청</button>}
          </div>}
          {turn.attachments.length > 0 && <div className="thread-attachments">
            <strong>첨부 자료 {turn.attachments.length}개</strong>
            {turn.attachments.map(artifact => <code key={`${artifact.digest}:${artifact.producing_attempt}`}>{artifact.digest} · {privacyLabels[artifact.privacy]}</code>)}
          </div>}
          <footer className="thread-turn-meta">
            <span>{privacyLabels[turn.privacy]}</span>
            <span className="thread-turn-time">· {recordedAt}</span>
            <DetailDialog title="메시지 정보" className="thread-meta-action"
              label={<><Info size={14} aria-hidden="true"/><span className="sr-only">메시지 정보</span></>}>
              {turn.kind !== "user" && <strong>{eventLabel}</strong>}
              <p>{privacyLabels[turn.privacy]} · {recordedAt}</p>
              {(turn.origin_report_id || turn.kind === "assistant_advisory") && <p>작업의 완료와 검수 상태는 맡긴 일에서 확인할 수 있습니다.</p>}
              <code>{turn.id} · {turn.sender_kind}:{turn.sender_ref} · 순서 {turn.sequence}{turn.origin_report_id && ` · 원본 보고 ${turn.origin_report_id}`}</code>
            </DetailDialog>
          </footer>
        </article>; })}
      </div>
    </section>}

    {selectedPanel === "ghosts" && <>
    {selectedTarget && <DetailDialog title="현재 등록된 대화 식별자"><code>{selectedTarget.ghost_id} · {selectedTarget.conversation_id}</code></DetailDialog>}
    {workspaceSnapshot && selectedTarget && onOpenApproval && <AgentPluginSurfaces
      snapshot={workspaceSnapshot} ghostId={selectedTarget.ghost_id} workspaceKey={workspaceSnapshot.workspace_id}
      onOpenApproval={onOpenApproval}/>}
    {mode === 'live' && selectedTarget && <InferenceSettings pair={selectedTarget} primary={selectedTarget.kind === "primary"} publicOnly={publicConversation} connected={connected} disabled={writesDisabled || Boolean(busy)}/>}
    {(!workspaceSnapshot || !onOpenApproval) && <section className="lifetime-outbox" aria-label="문서 저장 제안 검토">
      <div className="lifetime-section-heading"><div><h3>문서 저장 요청</h3></div></div>
      {selectedTarget !== undefined && documentReviews !== undefined && documentAuthorityEpoch !== undefined && lifetimeDocumentReviews.length === 0
        && <p className="lifetime-empty">이 대화에 기록된 문서 저장 제안이 없습니다.</p>}
      {documentReviews === undefined && selectedTarget !== undefined
        && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>문서 저장 요청을 불러오지 못했습니다.</span></p>}
      {lifetimeDocumentReviews.map(review => <article className="lifetime-outbox-row" key={review.id}>
        <div>
          <strong>{review.title}</strong>
          <span>{documentReviewStateLabels[review.state] ?? "상태 확인 필요"}</span>
          <DetailDialog title="제안 본문"><pre className="garden-document-source-readonly"><code>{review.body}</code></pre></DetailDialog>
        </div>
        {(review.state === "pending" || review.state === "approved") && <button type="button" className="button secondary" disabled={onOpenDocumentReview === undefined}
          onClick={() => onOpenDocumentReview?.(review)}>내용 보기</button>}
      </article>)}
    </section>}

    {mode === 'live' && selectedTarget && <BotRoster key={`${client.workspace_id}:${selectedTargetKey}`} client={client} target={selectedTarget}
      disabled={writesDisabled || Boolean(busy)} onRun={run}
      onSelect={target => {
        const registered = registry.find(item => item.ghost_id === target.ghost_id && item.conversation_id === target.conversation_id);
        if (registered) openRegisteredTarget(registered, false);
        setPairRefreshRequest(request => request + 1);
      }}
      onCreate={() => {
        updatePrompt(selectedTargetKey, current => current || '이걸 봇으로 만들어 줘');
        showPanel("conversation");
        requestAnimationFrame(() => document.getElementById('lifetime-message')?.focus());
      }}/>
    }

    {memoryAction && selectedTarget && <MemorySourceReview
      profileId={selectedTarget.ghost_id}
      conversationId={selectedTarget.conversation_id}
      action={memoryAction}/>}
    </>}

    {selectedPanel === "conversation" && <form className="lifetime-submit thread-composer" aria-label="메시지 보내기" onSubmit={event => void submitConversation(event)}>
      {activeTargets.length === 0 && <p className="lifetime-sync-warning" role="status"><CircleAlert size={16}/><span>메시지를 받을 수 있는 Ghost가 없습니다.</span></p>}
      <label className="lifetime-field"><span className="lifetime-visually-hidden">메시지</span><textarea id="lifetime-message" value={prompt} onChange={event => {
        const text = event.currentTarget.value;
        updatePrompt(selectedTargetKey, () => text);
      }} onKeyDown={event => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          if (!submissionBlocked) event.currentTarget.form?.requestSubmit();
        }
      }} rows={2} placeholder="메시지 쓰기" required disabled={Boolean(busy)}/></label>
      {new TextEncoder().encode(prompt).length > 65_536 && <p className="lifetime-compose-limit" role="status">메시지 한도 65,536바이트를 넘었습니다.</p>}
      <DetailDialog title="전송 옵션" label={<><SlidersHorizontal size={14} aria-hidden="true"/>전송 옵션 · {privacyLabels[effectivePrivacy]}{attachments.length > 0 && ` · 첨부 ${attachments.length}`}</>} className="lifetime-compose-options">
        <label className="lifetime-field">대화 대상<select aria-label="대화 대상" value={selectedTarget ? conversationTargetKey(selectedTarget) : selectedPairKey} onChange={event => {
          const target = registry.find(item => conversationTargetKey(item) === event.target.value);
          if (target) openRegisteredTarget(target, false);
        }} disabled={Boolean(busy) || writesDisabled && pending.length > 0}>
          <option value="">등록 대화를 선택하세요</option>
          {registry.map(target => <option value={conversationTargetKey(target)} key={conversationTargetKey(target)}>
            {workspaceSnapshot?.profiles.find(profile => profile.id === target.ghost_id)?.name ?? 'Ghost'}{target.secondary ? ` · ${publicLabel(target)}` : target.kind === 'primary' ? ' · 기본' : ''}{target.mode === "draining" ? " · 마무리 중" : ""}
          </option>)}
        </select></label>
        <div className="lifetime-form-row">
          {!publicConversation && <label className="lifetime-field">자료 범위<select aria-label="자료 범위" value={privacy} onChange={event => setPrivacy(event.target.value as Artifact["privacy"])} disabled={Boolean(busy)}>
            <option value="local_only">이 기기에서만</option><option value="private">비공개</option><option value="public">공개 자료 허용</option>
          </select></label>}
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
        <p>{!publicConversation && "대화의 기존 보호 수준은 유지됩니다. "}UTF-8 {new TextEncoder().encode(prompt).length}/65,536바이트.</p>
      </DetailDialog>
      <div className="lifetime-submit-actions lifetime-compose-actions">
        <button type="submit" className="send-button" disabled={submissionBlocked}
          aria-label={busy === "conversation.input" ? "저장 중" : "대화에 보내기"}>
          {busy === "conversation.input" ? <span className="button-loading"/> : <ArrowUp size={18}/>}
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
    {goalDetail && detailGoal && snapshot && !threadID && <Modal title="목표 상세" onClose={closeGoalDetail} drawer>
      <div className="lifetime-goal-detail">
        {feedback}
        <header className="lifetime-goal-heading">
          <div><span className="lifetime-state">{goalStateLabels[goalDetail.state] ?? goalDetail.state}</span>
            <span className="lifetime-revision">판본 {detailGoal.revision}</span>
            <span className="lifetime-privacy">{privacyLabels[detailGoal.privacy]}</span></div>
          <div className="lifetime-goal-owner-actions"><span className="lifetime-owner">담당 {workspaceSnapshot?.profiles.find(profile => profile.id === detailGoal.accountable_ghost)?.name ?? detailGoal.accountable_ghost}</span>
            <button type="button" className="button secondary" aria-haspopup="dialog" onClick={() => openWorkThread(detailGoal.id)}><GitBranch size={14}/>작업 스레드</button>
            {(() => {
              const target = registry.find(item => item.ghost_id === detailGoal.accountable_ghost && item.conversation_id === detailGoal.reply_conversation && item.mode === 'active');
              return target && <button type="button" className="button secondary" onClick={() => openRegisteredTarget(target, false)}>담당 Ghost와 대화</button>;
            })()}
          </div>
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
        {goalDetail.workItems.map(work => <WorkItem key={work.id} client={client} connected={connected} work={work} snapshot={snapshot} busy={Boolean(busy)} writeDisabled={writesDisabled}
          ownerName={workspaceSnapshot?.profiles.find(profile => profile.id === work.owner)?.name ?? work.owner} inspectSummary={inspectSummaries.get(work.id)}
          onInspect={() => void inspectWork(work.id)}
          onCancel={() => void run(`work.cancel:${work.id}`, () => client.request({ method: "work.cancel", work_id: work.id }))}
        />)}
      </div>
    </Modal>}
    {threadID && <WorkThreadDrawer key={JSON.stringify([threadScope, threadID])} client={client} goalID={threadID}
      target={inConversation ? selectedTarget : undefined} goals={snapshot?.goals ?? []} work={snapshot?.work ?? []} ghostName={ghostName}
      goalStatus={(goal, work) => { const state = boardState(goal, work).state; return goalStateLabels[state] ?? state; }}
      workStatus={state => workStateLabels[state] ?? state} connected={connected} busy={Boolean(busy)} writeDisabled={writesDisabled}
      feedback={feedback} draft={followUpDrafts.get(JSON.stringify([threadAuthority, threadID]))}
      onDraft={draft => updateFollowUp(threadID, () => draft)} onSend={sendFollowUp} onClose={() => setOpenThread(null)}/>}
  </section>;
}

function WorkItem({ client, connected, work, snapshot, busy, writeDisabled, ownerName, inspectSummary, onInspect, onCancel }: {
  client: LifetimeClient;
  connected: boolean;
  work: Work;
  snapshot: Snapshot;
  busy: boolean;
  writeDisabled: boolean;
  ownerName: string;
  inspectSummary?: string;
  onInspect(): void;
  onCancel(): void;
}) {
  const acceptances = snapshot.acceptances.filter(item => item.work_id === work.id);
  const acceptedDigests = new Set(acceptances.map(item => item.artifact_digest));
  const artifacts = snapshot.artifacts.filter(item => work.execution_id !== null && item.producing_attempt === work.execution_id);
  const canCancel = !terminalWorkStates[work.state] && !pendingCancellations[work.cancellation];
  return <section className="lifetime-work" data-lifetime-work={work.id} data-state={work.state} aria-label="진행 항목" tabIndex={-1}>
    <header className="lifetime-work-heading">
      <div><strong>{workStateLabels[work.state] ?? work.state}</strong><span>담당 {ownerName} · {work.state === "completed" ? "실행 종료 · 검수 전" : work.state === "accepted" ? "현재 목표 검수 완료" : work.execution_id ? "실행 또는 실행 결과 확인 중" : "실행 배정 대기"}</span></div>
      <button type="button" className="button secondary" onClick={onInspect} disabled={busy}><RefreshCw size={14}/>상태 확인</button>
    </header>
    {work.blocker && <p className="lifetime-blocker"><Clock3 size={14}/><span>대기 이유: {work.blocker}</span></p>}
    <p className="lifetime-cancellation">취소 상태: {cancellationLabels[work.cancellation] ?? work.cancellation}</p>
    {inspectSummary && <p className="lifetime-result-summary">{inspectSummary}</p>}
    {artifacts.length > 0 && <div className="lifetime-results"><h4>도착한 결과물</h4>{artifacts.map(artifact => {
      const accepted = acceptedDigests.has(artifact.digest);
      return <div className="lifetime-artifact" key={`${work.id}:${artifact.digest}`}>
        <div><strong>{accepted ? "검수 기록에 연결됨" : "도착함 · 수용 전"}</strong><span>{privacyLabels[artifact.privacy]} · {artifact.digest.slice(0, 12)}</span><code>{artifact.locator}</code></div>
        <WorkArtifactPreview client={client} work={work} artifact={artifact} disabled={!connected}/>
      </div>;
    })}</div>}
    {acceptances.map(acceptance => <div className="lifetime-checks" key={`${work.id}:${acceptance.artifact_digest}`}>
      <h4>검수 결과</h4>
      {acceptance.checks.map(check => <p className={check.passed ? "lifetime-check-passed" : "lifetime-check-failed"} key={check.id}><Check size={14}/><span>{check.id}: {check.passed ? "통과" : "미통과"} · {check.evidence}</span></p>)}
    </div>)}
    {!terminalWorkStates[work.state] && canCancel && <div className="lifetime-work-actions">
      <p>새 지시는 담당 Ghost 대화에서 보낼 수 있습니다.</p>
      <button type="button" className="button secondary lifetime-cancel" onClick={onCancel} disabled={busy || writeDisabled}>취소 요청</button>
    </div>}
  </section>;
}
