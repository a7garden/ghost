import { DetailDialog } from '../components/DetailDialog';
import { GhostProfile } from '../components/GhostProfile';
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Clock3, GitBranch, Info, RefreshCw, SlidersHorizontal } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Banner,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  EmptyState,
  GComposer,
  GConversation,
  GConversationMessage,
  SelectField,
  Textarea,
} from '@garden/ui';
import type { Artifact, ConversationRun, Envelope, Goal, Response, Snapshot, Work } from "../../../../contracts/lifetime/bindings.ts";
import { isArtifact, isPrivacy } from "./guards";
import { atLeastPrivacy, conversationTargetKey, defaultRegistryConversation, findRegisteredConversation, mergeConversationRuns, mergeConversationTurns, parseConversationPage, parseRegistryResponse } from "./conversation";
import type { ConversationPage, ConversationTurn, RegistryConversation } from "./conversation";
import type { LifetimeClient, LifetimeMode, LifetimeRecoveryCommand } from "./types";
import type { Review, Command } from "../client/types";
import { MemorySourceReview } from "./MemorySourceReview";
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
import { ghostDisplayName, profileSummary } from '../features/profileSummary';

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
  onOpenHistory?: (ghostID: string) => void;
  /** Dashboard text for the requested Ghost's conversation; sent once through the normal composer path. */
  handoff?: { id: string; text: string };
  onHandoffConsumed?: (id: string) => void;
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
export function LifetimeView({ active: routeActive = true, mode, client, connected = true, documentReviews, documentAuthorityEpoch, onOpenDocumentReview, memoryAction, initialGhostID, initialConversationID, initialRegisterConversationID, initialGoalID, initialWorkID, workScope = 'conversation', initialPanel = "conversation", onPanelChange, onOpenTarget, onDefaultGhostChange, onTargetChange, authorizedRegistration, onRegistrationConsumed, onClearWorkLink, createRequested, onOpenHistory, workspaceSnapshot, onOpenApproval, handoff, onHandoffConsumed }: LifetimeViewProps) {
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
  const [warning, setWarning] = useState("");
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

  // There is no manual refresh: a failed read is retried when the window is used again.
  useEffect(() => {
    if (!routeActive || refreshing || !(error || registryError || conversationError || syncWarning)) return;
    const retry = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [routeActive, refreshing, error, registryError, conversationError, syncWarning]);

  async function run(key: string, operation: () => Promise<Response>): Promise<Response | null> {
    if (busy) return null;
    setBusy(key);
    setError("");
    setSyncWarning("");
    setNotice("");
    setWarning("");
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
      // Host summaries are internal English diagnostics: errors stay visible,
      // warnings get plain wording, and success shows in the updated view.
      if (response.status === "error") setError(response.summary || "요청을 처리하지 못했습니다.");
      else if (response.status === "warning") setWarning("요청 결과를 확정하지 못했습니다.");
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
    setWarning("");
    try {
      const result = await client.reconcile(recoveryId);
      if (result.status === "confirmed_success") setNotice("이전 요청이 처리된 것을 확인했습니다.");
      else if (result.status === "confirmed_no_effect") setNotice("이전 요청은 적용되지 않았습니다. 필요하면 다시 보내 주세요.");
      else if (result.status === "not_found") setWarning("Host에 이 요청 기록이 없어 결과를 확정할 수 없습니다.");
      else setWarning("이전 요청의 결과를 아직 확정할 수 없습니다.");
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
    setWarning("");
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

  async function submitConversation(): Promise<void> {
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
    target: selectedTarget, snapshot, runs: turnRuns.values(), turns,
    availability: loading || conversationLoading || Boolean(selectedTarget && loadedConversationKey !== selectedTargetKey) ? "loading"
      : !client.dispatch_enabled || Boolean(registryError || conversationError || syncWarning) ? "unavailable" : "current",
  });

  const pendingDocumentReviews = lifetimeDocumentReviews.filter(review => review.state === "pending" || review.state === "approved");
  const integrationReviews = (workspaceSnapshot?.integrationApprovals ?? []).filter(review =>
    review.ghost_id === selectedTarget?.ghost_id && review.conversation_id === selectedTarget?.conversation_id);
  const submissionBlocked = writesDisabled || Boolean(busy) || loading || !prompt.trim()
    || selectedTarget?.mode !== "active" || publicConversation && effectivePrivacy !== "public"
    || new TextEncoder().encode(prompt).length > 65_536 || attachments.length > 16;
  // Seed the dashboard text into the requested target's draft, then send it
  // once the composer would accept it. An existing draft is kept and the text
  // appended without sending, so nothing the owner typed is sent unseen.
  const seededHandoff = useRef("");
  const handoffSend = useRef<{ key: string; text: string } | null>(null);
  useEffect(() => {
    if (!routeActive || !handoff || seededHandoff.current === handoff.id || initialPanel !== "conversation") return;
    if (!selectedTarget || initialGhostID && selectedTarget.ghost_id !== initialGhostID) return;
    seededHandoff.current = handoff.id;
    const existing = promptDrafts.get(selectedTargetKey) ?? "";
    updatePrompt(selectedTargetKey, () => existing.trim() ? `${existing}\n\n${handoff.text}` : handoff.text);
    handoffSend.current = existing.trim() ? null : { key: selectedTargetKey, text: handoff.text };
    onHandoffConsumed?.(handoff.id);
  }, [routeActive, handoff, initialPanel, initialGhostID, selectedTarget, selectedTargetKey, promptDrafts, onHandoffConsumed]);
  useEffect(() => {
    const queued = handoffSend.current;
    if (!routeActive || !queued || queued.key !== selectedTargetKey) return;
    // An empty draft means the seed has not rendered yet; any other edit cancels the send.
    if (prompt !== queued.text) { if (prompt) handoffSend.current = null; return; }
    if (submissionBlocked) return;
    handoffSend.current = null;
    void submitConversation();
  });
  const ghostName = (id: string) => ghostDisplayName(workspaceSnapshot?.profiles.find(profile => profile.id === id)?.name ?? id);
  const publicLabel = (target: RegistryConversation) => registry.filter(item => item.ghost_id === target.ghost_id && item.secondary).length > 1
    ? `공개 대화 ${target.conversation_id.slice(0, 8)}` : "공개 대화";
  const selectedProfile = selectedTarget ? workspaceSnapshot?.profiles.find(profile => profile.id === selectedTarget.ghost_id) : undefined;
  const activityProps = {
    model: agentStatus, observedAt: Math.min(snapshotObservedAt, conversationObservedAt) || undefined, fixture: mode === 'fixture',
    busy: Boolean(busy), actionsDisabled: writesDisabled || loading || agentStatus.state === 'unknown' || agentStatus.state === 'stale',
    onInspectWork: (workID: string) => void inspectWork(workID), onCancelTurn: (turnID: string) => void cancelConversationTurn(turnID),
  };
  const chatTitle = selectedTarget
    ? `${ghostName(selectedTarget.ghost_id)}${publicConversation ? ` · ${publicLabel(selectedTarget)}` : ""}`
    : "대화";
  const feedback = <>
      {error && <Alert variant="destructive"><CircleAlert aria-hidden="true"/><AlertTitle>{error}</AlertTitle></Alert>}
      {syncWarning && <Alert role="status" variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>{syncWarning}</AlertTitle></Alert>}
      {warning && <Alert role="status" variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>{warning}</AlertTitle></Alert>}
      {notice && <Alert role="status" variant="success"><Check aria-hidden="true"/><AlertTitle>{notice}</AlertTitle></Alert>}
  </>;

  const inConversation = selectedPanel === "conversation";
  const displayedTurns = routeActive && loadedConversationKey === selectedTargetKey ? turns : [];
  const promptBytes = new TextEncoder().encode(prompt).length;
  const requestLabel = (body: Envelope["body"] | undefined) => body?.method === "goal.update" && typeof body.follow_up === "string" ? "후속 지시"
    : typeof body?.method === "string" ? pendingCommandLabels[body.method] ?? "요청" : "요청";
  // Unconfirmed writes fence new changes; one compact notice lists them with their check action.
  const notices = <>
    {mode === "fixture" && <Banner variant="info">예시 모드입니다. 요청은 이 브라우저의 예시 기록에만 반영되며 실제 호스트나 작업 실행자에게 전달되지 않습니다.</Banner>}
    {!goalDetail && !threadID && feedback}
    {!client.dispatch_enabled && <Alert role="status" variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>Host 복구 모드입니다. 기록은 볼 수 있지만 새 요청은 보낼 수 없습니다.</AlertTitle></Alert>}
    {pending.length + recovery.length > 0 && <Alert role="status" variant="warning" aria-label="결과를 확인하지 못한 요청">
      <CircleAlert aria-hidden="true"/>
      <AlertTitle>보낸 요청의 결과를 확인하면 새 요청을 보낼 수 있습니다.</AlertTitle>
      <AlertDescription className="w-full gap-0">
        <ul className="m-0 grid w-full list-none p-0">
          {pending.map(envelope => {
            const text = envelope.body.method === "conversation.input" ? String(envelope.body.text ?? "") : "";
            return <li key={envelope.command_id} className="flex min-w-0 items-center gap-3 border-t border-line py-1.5 first:border-t-0">
              <span className="min-w-0 flex-1 truncate"><span className="text-ink">{requestLabel(envelope.body)}</span>{text && ` · ${text}`}</span>
              <Button type="button" variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => void inspectPendingCommand(envelope)}>결과 확인</Button>
            </li>;
          })}
          {recovery.map(item => <li key={item.id} className="flex min-w-0 items-center gap-3 border-t border-line py-1.5 first:border-t-0">
            <span className="min-w-0 flex-1 truncate"><span className="text-ink">{item.issue ? "읽을 수 없는 이전 요청" : requestLabel(item.envelope?.body)}</span> · 이전 연결</span>
            <Button type="button" variant="secondary" size="sm" disabled={Boolean(busy) || !item.envelope || !item.command_id} onClick={() => void reconcile(item.id)}>결과 확인</Button>
          </li>)}
        </ul>
      </AlertDescription>
    </Alert>}
  </>;
  return <section data-panel={selectedPanel} aria-labelledby="lifetime-heading" className={inConversation
    ? "flex min-h-0 w-full min-w-0 flex-1 flex-col"
    : "mx-auto grid w-full min-w-0 max-w-[1120px] gap-4"}>
    {/* The title bar names the page; the heading stays for screen readers except in Ghost management. */}
    {inConversation ? <h2 id="lifetime-heading" className="sr-only">{chatTitle}</h2> : <>
      <h2 id="lifetime-heading" className={selectedPanel === "ghosts" ? "m-0 text-headingSm font-semibold text-ink" : "sr-only"}>
        {selectedPanel === "work" ? workScope === "all" ? "모든 일" : "맡긴 일" : "Ghost 관리"}
      </h2>
      {notices}
    </>}

    {selectedPanel === "ghosts" && snapshot && workspaceSnapshot && registryReady && !registryError && <section aria-labelledby="ghost-team-heading" className="grid min-w-0 gap-2.5">
      <h3 id="ghost-team-heading" className="m-0 text-body font-semibold text-ink">Ghost 목록</h3>
      <ul className="grid list-none gap-2.5 p-0 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
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
          return <li className="min-w-0" key={profile.id}>
            {target?.mode === "active" ? <Button type="button" variant="outline" aria-pressed={key === selectedTargetKey}
              onClick={() => openRegisteredTarget(target, false)}
              className={`h-auto w-full flex-col items-start justify-start gap-2.5 rounded-card px-3 py-2.5 text-left whitespace-normal ${key === selectedTargetKey ? "border-line-strong bg-inset" : ""}`}>
              <span className="flex w-full min-w-0 items-center justify-between gap-2">
                <strong className="min-w-0 truncate text-ui font-semibold text-ink">{ghostDisplayName(profile.name)}</strong>
                {target.kind === 'primary' && <Badge>기본</Badge>}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {counts.filter(({ count }) => count > 0).map(({ label, tone, count }) =>
                  <Badge key={label} variant={tone === "review" ? "warning" : "outline"}>{label} {count}</Badge>)}
              </span>
            </Button> : <div className="grid w-full gap-2.5 rounded-card border border-dashed border-line bg-surface px-3 py-2.5">
              <span className="flex w-full min-w-0 items-center justify-between gap-2">
                <strong className="min-w-0 truncate text-ui font-semibold text-ink">{ghostDisplayName(profile.name)}</strong>
                <small className="shrink-0 truncate text-caption text-ink-2">{profile.persona}</small>
              </span>
              {target ? <span className="text-caption text-ink-2">등록 대화 마무리 중</span> : <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={!connected || !client.dispatch_enabled || loading || refreshing || Boolean(busy) || pending.length > 0 || recovery.length > 0}
                  onClick={() => void ensureProfileConversation(profile.id, crypto.randomUUID())}>새 대화 연결</Button>
                {profile.conversations.length > 0 && <Button type="button" variant="secondary" onClick={() => onOpenHistory?.(profile.id)}>이전 대화 {profile.conversations.length}</Button>}
              </div>}
            </div>}
          </li>;
        })}
      </ul>
    </section>}

    {selectedPanel === "conversation" && <GConversation
      label="선택한 Ghost와의 대화"
      transcriptLabel="대화 기록"
      jumpToLatestLabel="최신 메시지로 이동"
      scrollKey={displayedTurns.length}
      className="ghost-chat min-h-0 flex-1"
      header={selectedTarget ? <GhostProfile key={selectedTargetKey} ghostID={selectedTarget.ghost_id} name={ghostName(selectedTarget.ghost_id)}
        summary={selectedProfile ? profileSummary(selectedProfile.persona) : undefined}
        note={publicConversation ? publicLabel(selectedTarget) : undefined}
        activity={activityProps}
        onOpenWork={() => showPanel("work")}
        historyCount={selectedProfile?.conversations.length}
        onOpenHistory={onOpenHistory ? () => onOpenHistory(selectedTarget.ghost_id) : undefined}
        onManage={() => showPanel("ghosts")}/> : undefined}
      composer={<div className="grid gap-2">
        {selectedTarget && <AgentStatus key={selectedTargetKey} {...activityProps}/>}
        {onOpenApproval && (pendingDocumentReviews.length > 0 || integrationReviews.length > 0) && <div className="flex flex-wrap justify-center gap-2" aria-label="이 대화의 확인할 일">
          {pendingDocumentReviews.map(review => <Button type="button" variant="secondary" size="sm" key={review.id}
            onClick={() => onOpenApproval({ kind: "document", id: review.id })}>{review.title} · {review.state === "pending" ? "검토 대기" : "저장 대기"}</Button>)}
          {integrationReviews.slice(0, 5).map(review => <Button type="button" variant="secondary" size="sm" key={review.id}
            onClick={() => onOpenApproval({ kind: "integration", id: review.id })}>{integrationApprovalTitle(review.tool)} · {integrationStatusLabels[review.state]}</Button>)}
        </div>}
        {!selectedTarget && !loading && <Alert role="status" variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>{initialGhostID ? "이 Ghost에 연결된 대화가 없습니다. 홈에서 이 Ghost를 열고 새 대화를 연결해 주세요." : "열 수 있는 대화가 없습니다. 홈에서 Ghost를 선택해 주세요."}</AlertTitle></Alert>}
        {conversationError && <Alert variant="destructive"><CircleAlert aria-hidden="true"/><AlertTitle>{conversationError}</AlertTitle></Alert>}
        {notices}<GComposer variant="conversation" inputId="lifetime-message" value={prompt}
        onValueChange={text => updatePrompt(selectedTargetKey, () => text)}
        onSubmit={() => void submitConversation()}
        label="메시지" placeholder="메시지 쓰기"
        submitLabel={busy === "conversation.input" ? "저장 중" : "대화에 보내기"}
        disabled={Boolean(busy)} pending={busy === "conversation.input"}
        footer={<DetailDialog title="전송 옵션" label={<><SlidersHorizontal size={15} aria-hidden="true"/><span className="sr-only">전송 옵션 · {privacyLabels[effectivePrivacy]}</span>{attachments.length > 0 && <span>첨부 {attachments.length}</span>}</>}>
          <SelectField label="대화 대상" value={selectedTarget ? conversationTargetKey(selectedTarget) : selectedPairKey || "lifetime:none"}
            onValueChange={value => {
              const target = registry.find(item => conversationTargetKey(item) === value);
              if (target) openRegisteredTarget(target, false);
            }}
            disabled={Boolean(busy) || writesDisabled && pending.length > 0}
            options={[
              { value: "lifetime:none", label: "등록 대화를 선택하세요" },
              ...registry.map(target => ({ value: conversationTargetKey(target), label: `${ghostName(target.ghost_id)}${target.secondary ? ` · ${publicLabel(target)}` : target.kind === 'primary' ? ' · 기본' : ''}${target.mode === "draining" ? " · 마무리 중" : ""}` })),
            ]}/>
          {!publicConversation && <SelectField label="자료 범위" value={privacy} onValueChange={value => setPrivacy(value as Artifact["privacy"])} disabled={Boolean(busy)}
            options={[{ value: "local_only", label: "이 기기에서만" }, { value: "private", label: "비공개" }, { value: "public", label: "공개 자료 허용" }]}/>}
          <div className="grid gap-1.5">
            <strong className="text-ui font-medium text-ink">기존 자료 첨부</strong>
            {attachmentChoices.length === 0 && <span className="text-caption text-ink-2">이 대화에서 선택할 수 있는 기존 첨부 자료가 없습니다. 새 파일은 여기서 열거나 업로드하지 않습니다.</span>}
            {attachmentChoices.map(artifact => {
              const key = attachmentKey(artifact);
              const checked = attachments.some(item => attachmentKey(item) === key);
              return <label key={key} className="flex items-center gap-2 text-caption text-ink">
                <Checkbox checked={checked} disabled={Boolean(busy) || (!checked && attachments.length >= 16)}
                  onCheckedChange={include => {
                    updateAttachments(selectedTargetKey, current => {
                      const remaining = (current ?? []).filter(item => {
                        const itemKey = attachmentKey(item);
                        return eligibleAttachments.has(itemKey) && itemKey !== key;
                      });
                      return include === true && remaining.length < 16 ? [...remaining, artifact] : remaining;
                    });
                  }}/>
                <span>{artifact.digest.slice(0, 12)} · {privacyLabels[artifact.privacy]}</span>
              </label>;
            })}
          </div>
          <p className="m-0 text-caption text-ink-2">{!publicConversation && "대화의 기존 보호 수준은 유지됩니다. "}UTF-8 {promptBytes}/65,536바이트.</p>
        </DetailDialog>}/></div>}
      footer={activeTargets.length === 0 || promptBytes > 65_536 ? <div className="grid justify-items-center gap-1">
        {activeTargets.length === 0 && <p className="m-0" role="status">메시지를 받을 수 있는 Ghost가 없습니다.</p>}
        {promptBytes > 65_536 && <p className="m-0" role="status">메시지 한도 65,536바이트를 넘었습니다.</p>}
      </div> : undefined}>
      {hasOlder && oldestSequence !== null && <Button type="button" variant="secondary" onClick={() => void loadOlderConversation()} disabled={conversationLoading || !selectedTarget}>이전 대화 불러오기</Button>}
      {conversationLoading && <p className="m-0 flex items-center gap-2 text-ui text-ink-2"><Clock3 size={16}/>저장된 대화를 불러오는 중입니다.</p>}
      {!conversationLoading && selectedTarget && turns.length === 0 && !conversationError && <EmptyState title="이 대화에 아직 메시지가 없습니다."/>}
      {displayedTurns.map(turn => {
        const controller = turn.kind === "user" ? turnRuns.get(turn.id) : undefined;
        const canCancel = controller && !["answered", "failed", "cancelled"].includes(controller.state);
        const eventLabel = turn.origin_report_id ? "작업 보고" : turn.kind === "assistant_advisory" ? "참고 의견" : "호스트 상태 기록";
        const created = new Date(turn.created_at_ms);
        const recordedAt = created.toLocaleString();
        const shortTime = created.toDateString() === new Date().toDateString()
          ? created.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : created.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        const runState = controller && controller.state !== "answered"
          ? controller.cancel_requested && canCancel ? "취소 요청됨" : turnStateLabels[controller.state]
          : "";
        return <GConversationMessage key={turn.id}
          role={turn.kind === "user" ? "user" : "assistant"}
          label={turn.kind === "user" ? "나" : eventLabel}
          actions={<div className="flex items-center gap-1.5 text-caption text-ink-2">
            {runState && <span className={controller?.state === "failed" || controller?.state === "effect_unknown" ? "text-orange" : undefined}>{runState}</span>}
            {runState && <span aria-hidden="true">·</span>}
            <time dateTime={created.toISOString()} title={recordedAt} className="[font-variant-numeric:tabular-nums]">{shortTime}</time>
            {canCancel && !controller.cancel_requested && <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5 text-caption"
              aria-label={`응답 취소 · 메시지 ${turn.sequence}`}
              disabled={writesDisabled || Boolean(busy)}
              onClick={() => void cancelConversationTurn(turn.id)}>취소</Button>}
            <DetailDialog title="메시지 정보" className="[&>button]:size-6 [&>button]:p-0"
              label={<><Info size={13} aria-hidden="true"/><span className="sr-only">메시지 정보</span></>}>
              {turn.kind !== "user" && <strong>{eventLabel}</strong>}
              <p>{privacyLabels[turn.privacy]} · {recordedAt}</p>
              {(turn.origin_report_id || turn.kind === "assistant_advisory") && <p>작업의 완료와 검수 상태는 맡긴 일에서 확인할 수 있습니다.</p>}
              <code>{turn.id} · {turn.sender_kind}:{turn.sender_ref} · 순서 {turn.sequence}{turn.origin_report_id && ` · 원본 보고 ${turn.origin_report_id}`}</code>
            </DetailDialog>
          </div>}>
          {(turn.kind === "host_fact" || turn.origin_report_id) && <p className="m-0 font-semibold text-caption text-ink-2">
            {eventLabel}{turn.origin_report_id && " · 검수 상태 별도"}
          </p>}
          <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{turn.text}</p>
          {Boolean(turn.work_thread_ids?.length) && <div className="mt-2 grid gap-1.5">
            {turn.work_thread_ids?.map((id, index) => {
              const goal = conversationGoals.find(item => item.id === id);
              const title = goal ? workThreadTitle(goal.prompt) : turn.work_thread_ids!.length > 1 ? `일 ${index + 1}` : "일";
              const workItems = snapshot?.work.filter(work => work.goal_id === id) ?? [];
              const board = goal && boardState(goal, workItems);
              const owners = [...new Set(workItems.map(work => ghostName(work.owner)))].join(", ");
              return <Button type="button" variant="ghost" key={id} aria-haspopup="dialog" onClick={() => openWorkThread(id)}
                aria-label={`일 열기: ${title}${board ? ` · ${goalStateLabels[board.state] ?? board.state}` : ""}`}
                className="h-auto w-full justify-start gap-3 rounded-card border border-line px-3 py-2.5 text-left whitespace-normal">
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${board?.stage === "active" ? "bg-green" : board?.stage === "review" ? "bg-orange" : "bg-ink-2"}`}/>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <strong className="truncate text-body font-medium text-ink">{title}</strong>
                  {owners && <small className="truncate text-caption text-ink-2">{owners}</small>}
                </span>
                {board && <Badge variant={board.stage === "active" ? "success" : board.stage === "review" ? "warning" : "outline"}>{goalStateLabels[board.state] ?? board.state}</Badge>}
              </Button>;
            })}
          </div>}
          {turn.attachments.length > 0 && <div className="mt-2 grid gap-1 text-caption">
            <strong className="font-medium text-ink-2">첨부 자료 {turn.attachments.length}개</strong>
            {turn.attachments.map(artifact => <code key={`${artifact.digest}:${artifact.producing_attempt}`} className="block font-mono text-ink-2 [overflow-wrap:anywhere]">{artifact.digest} · {privacyLabels[artifact.privacy]}</code>)}
          </div>}
        </GConversationMessage>;
      })}
    </GConversation>}

    {selectedPanel === "ghosts" && <>
    {selectedTarget && <DetailDialog title="현재 등록된 대화 식별자"><code>{selectedTarget.ghost_id} · {selectedTarget.conversation_id}</code></DetailDialog>}
    {workspaceSnapshot && selectedTarget && onOpenApproval && <AgentPluginSurfaces
      snapshot={workspaceSnapshot} ghostId={selectedTarget.ghost_id} workspaceKey={workspaceSnapshot.workspace_id}
      onOpenApproval={onOpenApproval}/>}
    {mode === 'live' && selectedTarget && <InferenceSettings pair={selectedTarget} primary={selectedTarget.kind === "primary"} publicOnly={publicConversation} connected={connected} disabled={writesDisabled || Boolean(busy)}/>}
    {(!workspaceSnapshot || !onOpenApproval) && <section aria-label="문서 저장 제안 검토" className="min-w-0">
      <Card className="gap-0">
        <CardHeader className="border-b border-line py-0 pb-3 pt-4"><h3 className="m-0 text-body font-semibold text-ink">문서 저장 요청</h3></CardHeader>
        <CardContent className="grid gap-2 pt-3">
          {selectedTarget !== undefined && documentReviews !== undefined && documentAuthorityEpoch !== undefined && lifetimeDocumentReviews.length === 0
            && <EmptyState title="이 대화에 기록된 문서 저장 제안이 없습니다."/>}
          {documentReviews === undefined && selectedTarget !== undefined
            && <Alert role="status" variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>문서 저장 요청을 불러오지 못했습니다.</AlertTitle></Alert>}
          {lifetimeDocumentReviews.map(review => <article key={review.id} className="grid gap-3 rounded-card border border-line bg-inset p-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid min-w-0 gap-0.5">
              <strong className="text-ui font-medium text-ink [overflow-wrap:anywhere]">{review.title}</strong>
              <span className="text-caption text-ink-2">{documentReviewStateLabels[review.state] ?? "상태 확인 필요"}</span>
              <div><DetailDialog title="제안 본문"><pre className="garden-document-source-readonly"><code>{review.body}</code></pre></DetailDialog></div>
            </div>
            {(review.state === "pending" || review.state === "approved") && <Button type="button" variant="secondary" disabled={onOpenDocumentReview === undefined}
              onClick={() => onOpenDocumentReview?.(review)}>내용 보기</Button>}
          </article>)}
        </CardContent>
      </Card>
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

    {selectedPanel === "work" && <section aria-label="선택한 대화에서 맡긴 일" aria-busy={loading} className="grid min-w-0 gap-3.5">
      {loading && <p role="status" className="m-0 flex items-center gap-2 py-3.5 text-ui text-ink-2"><Clock3 size={16}/>저장된 상태를 불러오는 중입니다.</p>}
      {!loading && boardGoals.length === 0 && <EmptyState title="맡은 일이 없습니다."/>}
      {!loading && boardGoals.length > 0 && <div className="grid min-w-0 gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">{goalStages.map(stage => {
        const goals = boardGoals.filter(goal => goal.stage === stage.id);
        return <section data-stage={stage.id} key={stage.id} className="grid min-w-0 content-start gap-2 rounded-card border border-line bg-surface p-3">
          <h3 className="m-0 flex items-center justify-between text-ui font-semibold text-ink">{stage.label}<span className="text-caption font-normal text-ink-2">{goals.length}</span></h3>
          {goals.length === 0 && <p className="m-0 text-caption text-ink-2">없음</p>}
          {goals.map(({ goal, state }) => <Button type="button" variant="ghost" data-state={state}
            data-lifetime-goal={goal.id} key={goal.id} aria-haspopup="dialog" onClick={() => setGoalDetailID(goal.id)}
            className="h-auto w-full flex-col items-start gap-1.5 rounded-card border border-line px-3 py-2.5 text-left whitespace-normal">
            <span className="w-full min-w-0 text-left text-ui font-medium [overflow-wrap:anywhere]">{goal.prompt}</span>
            <span className="flex w-full items-center justify-between gap-2">
              <Badge variant="outline">{goalStateLabels[state] ?? state}</Badge>
              <ChevronRight size={14} aria-hidden="true"/>
            </span>
          </Button>)}
        </section>;
      })}</div>}
    </section>}
    {goalDetail && detailGoal && snapshot && !threadID && <Modal title="목표 상세" onClose={closeGoalDetail} drawer>
      <div className="grid min-w-0 gap-3.5">
        {feedback}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{goalStateLabels[goalDetail.state] ?? goalDetail.state}</Badge>
            <Badge variant="outline">판본 {detailGoal.revision}</Badge>
            <Badge variant="outline">{privacyLabels[detailGoal.privacy]}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-caption text-ink-2 [overflow-wrap:anywhere]">담당 {workspaceSnapshot?.profiles.find(profile => profile.id === detailGoal.accountable_ghost)?.name ?? detailGoal.accountable_ghost}</span>
            <Button type="button" variant="secondary" aria-haspopup="dialog" onClick={() => openWorkThread(detailGoal.id)}><GitBranch size={14}/>작업 스레드</Button>
            {(() => {
              const target = registry.find(item => item.ghost_id === detailGoal.accountable_ghost && item.conversation_id === detailGoal.reply_conversation && item.mode === 'active');
              return target && <Button type="button" variant="secondary" onClick={() => openRegisteredTarget(target, false)}>담당 Ghost와 대화</Button>;
            })()}
          </div>
        </header>
        <label className="grid gap-1.5 text-caption text-ink-2">목표<Textarea value={detailDraft?.text ?? detailGoal.prompt}
          onChange={event => {
            const text = event.currentTarget.value;
            setGoalDrafts(current => new Map(current).set(detailGoal.id, {
              text, revision: current.get(detailGoal.id)?.revision ?? detailGoal.revision,
            }));
          }} readOnly={Boolean(busy)}/></label>
        {staleGoalDraft && <Alert role="status" variant="warning"><CircleAlert aria-hidden="true"/><AlertTitle>편집을 시작한 뒤 목표가 바뀌었습니다. 최신 목표를 불러온 뒤 다시 수정해 주세요.</AlertTitle></Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          {staleGoalDraft && <Button type="button" variant="secondary" onClick={() => clearGoalDraft(detailGoal.id)}>최신 목표 불러오기</Button>}
          <Button type="button" variant="secondary" disabled={writesDisabled || Boolean(busy) || Boolean(staleGoalDraft)
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
            }}>목표 수정</Button>
        </div>
        {goalDetail.workItems.length === 0 && <p className="m-0 text-ui text-ink-2">연결된 진행 항목이 없습니다.</p>}
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
  return <section data-lifetime-work={work.id} data-state={work.state} aria-label="진행 항목" tabIndex={-1}
    className="grid min-w-0 gap-3 rounded-card border border-line bg-inset p-4">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="grid min-w-0 gap-0.5">
        <Badge variant="outline" className="w-fit">{workStateLabels[work.state] ?? work.state}</Badge>
        <span className="text-caption text-ink-2">담당 {ownerName} · {work.state === "completed" ? "실행 종료 · 검수 전" : work.state === "accepted" ? "현재 목표 검수 완료" : work.execution_id ? "실행 또는 실행 결과 확인 중" : "실행 배정 대기"}</span>
      </div>
      <Button type="button" variant="secondary" onClick={onInspect} disabled={busy}><RefreshCw size={14}/>상태 확인</Button>
    </header>
    {work.blocker && <p className="m-0 flex items-start gap-1.5 text-caption text-orange [overflow-wrap:anywhere]"><Clock3 size={14} className="mt-0.5 shrink-0"/>대기 이유: {work.blocker}</p>}
    <p className="m-0 text-caption text-ink-2 [overflow-wrap:anywhere]">취소 상태: {cancellationLabels[work.cancellation] ?? work.cancellation}</p>
    {inspectSummary && <p className="m-0 rounded-control bg-surface p-2.5 text-ui [overflow-wrap:anywhere]">{inspectSummary}</p>}
    {artifacts.length > 0 && <div className="grid gap-2"><h4 className="m-0 text-caption font-semibold text-ink">도착한 결과물</h4>{artifacts.map(artifact => {
      const accepted = acceptedDigests.has(artifact.digest);
      return <div className="grid gap-2 rounded-control bg-surface p-3 md:grid-cols-[minmax(0,1fr)_auto]" key={`${work.id}:${artifact.digest}`}>
        <div className="grid min-w-0 gap-0.5">
          <strong className="text-caption font-medium text-ink">{accepted ? "검수 기록에 연결됨" : "도착함 · 수용 전"}</strong>
          <span className="text-caption text-ink-2">{privacyLabels[artifact.privacy]} · {artifact.digest.slice(0, 12)}</span>
          <code className="block font-mono text-caption text-ink-2 [overflow-wrap:anywhere]">{artifact.locator}</code>
        </div>
        <WorkArtifactPreview client={client} work={work} artifact={artifact} disabled={!connected}/>
      </div>;
    })}</div>}
    {acceptances.map(acceptance => <div className="grid gap-2" key={`${work.id}:${acceptance.artifact_digest}`}>
      <h4 className="m-0 text-caption font-semibold text-ink">검수 결과</h4>
      {acceptance.checks.map(check => <p className={`m-0 flex items-start gap-1.5 text-caption [overflow-wrap:anywhere] ${check.passed ? "text-green" : "text-red"}`} key={check.id}><Check size={14} className="mt-0.5 shrink-0"/><span>{check.id}: {check.passed ? "통과" : "미통과"} · {check.evidence}</span></p>)}
    </div>)}
    {!terminalWorkStates[work.state] && canCancel && <div className="grid gap-2">
      <p className="m-0 text-caption text-ink-2">새 지시는 담당 Ghost 대화에서 보낼 수 있습니다.</p>
      <div className="flex justify-end">
        <Button type="button" variant="ghost" className="text-red" onClick={onCancel} disabled={busy || writeDisabled}>취소 요청</Button>
      </div>
    </div>}
  </section>;
}
