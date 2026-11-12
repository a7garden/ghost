import { reviewOf, type Decision, type LedgerEvent, type Work, type MetricsFilter, type MetricsView, type PolicyEvaluation } from "@ghost/contract";
import type { Ledger } from "../ledger/ledger.ts";

export interface MetricUsage {
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number;
  cost?: { total?: number };
}
interface UsageIndex { tokens: number; tokensKnown: boolean; cost: number; costKnown: boolean }
interface WorkObservation { hold: Work["hold"]; since: number; quotaWaitMs: number; repeatGuardHits: number; verdict: Work["verdict"]; ownerOverturned: number }
interface ObservationIndex { after: number; complete: boolean; works: Record<string, WorkObservation> }
const trackers = new WeakSet<Ledger>();

/** Immutable Pi entry identities make live publications and catch-up idempotent. */
export function recordMetricUsage(ledger: Ledger, conversationId: string, entryId: number | string, usage: MetricUsage | null | undefined): void {
  ledger.tx(() => {
    const key = `metrics:usage:${conversationId}`;
    const marker = `metrics:entry:${conversationId}:${entryId}`;
    if (ledger.setting(marker, false)) return;
    const index = ledger.setting<UsageIndex>(key, { tokens: 0, tokensKnown: true, cost: 0, costKnown: true });
    ledger.putSetting(marker, true);
    const tokens = usage?.totalTokens ?? (usage ? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : null);
    if (tokens !== null && Number.isFinite(tokens) && tokens >= 0) index.tokens += tokens;
    else index.tokensKnown = false;
    const cost = usage?.cost?.total;
    if (cost === undefined || !Number.isFinite(cost) || cost < 0) index.costKnown = false;
    else index.cost += cost;
    ledger.putSetting(key, index);
  });
}

function observe(index: ObservationIndex, event: LedgerEvent): void {
  if (event.data.type !== "work") return;
  const work = event.data.work;
  const old = index.works[work.id];
  const next: WorkObservation = old ?? { hold: null, since: event.at, quotaWaitMs: 0, repeatGuardHits: 0, verdict: null, ownerOverturned: 0 };
  if (next.hold === "quota") next.quotaWaitMs += Math.max(0, event.at - next.since);
  if (work.hold === "repeat" && next.hold !== "repeat") next.repeatGuardHits++;
  if (work.verdict?.source === "owner" && next.verdict && next.verdict.source !== "owner" && next.verdict.outcome !== work.verdict.outcome) next.ownerOverturned++;
  next.hold = work.hold; next.since = event.at; if (work.verdict) next.verdict = work.verdict;
  index.works[work.id] = next;
}

/** Install once at Host startup; the persisted cursor avoids a history scan per read. */
export function installMetricTracking(ledger: Ledger): void {
  if (trackers.has(ledger)) return;
  trackers.add(ledger);
  const index = ledger.setting<ObservationIndex>("metrics:observations", { after: 0, complete: true, works: {} });
  for (;;) {
    let page = ledger.eventsAfter(index.after);
    if (page === null) {
      index.complete = false;
      const oldest = ledger.db.query("SELECT MIN(seq) AS seq FROM events").get() as { seq: number | null };
      index.after = Math.max(0, (oldest.seq ?? 1) - 1);
      page = ledger.eventsAfter(index.after) ?? [];
    }
    for (const event of page) { observe(index, event); index.after = event.seq; }
    if (page.length < 1000) break;
  }
  ledger.tx(() => ledger.putSetting("metrics:observations", index));
  ledger.subscribe((event) => {
    if (event.seq <= index.after) return;
    observe(index, event); index.after = event.seq;
    ledger.tx(() => ledger.putSetting("metrics:observations", index));
  });
}

function decisionRules(decision: Decision): string[] {
  const policy = decision.proposal?.policy as { evaluation?: { ruleIds?: unknown; decidedBy?: unknown } } | undefined;
  const ids = policy?.evaluation?.decidedBy ?? policy?.evaluation?.ruleIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export function readMetrics(ledger: Ledger, filter: MetricsFilter = {}, now = Date.now()): MetricsView {
  installMetricTracking(ledger);
  const all = ledger.worksInState("queued", "running", "waiting", "verifying", "blocked", "done", "failed", "cancelled");
  const matches = (work: Work) => (filter.scopeId === undefined || work.scopeId === filter.scopeId) && (!filter.ghostId || work.ghostId === filter.ghostId) && (!filter.slot || work.slot === filter.slot);
  let works = all.filter(matches);
  const allDecisions = ledger.db.query("SELECT id FROM decisions ORDER BY created_at").all() as { id: string }[];
  const decisions = allDecisions.map(({ id }) => ledger.decision(id));
  const effects = (["pending", "done", "denied", "unknown"] as const).flatMap((state) => ledger.effectsInState(state)).map((effect) => {
    const policy = ledger.setting<{ scopeId: string | null; ghostId: string; evaluation: PolicyEvaluation } | null>(`policy:effect:${effect.id}`, null);
    return { effect, policy, ruleIds: policy?.evaluation.decidedBy ?? [] };
  });
  if (filter.ruleId) {
    const ids = new Set([...decisions.filter((decision) => decisionRules(decision).includes(filter.ruleId!)).map((decision) => decision.workId), ...effects.filter((entry) => entry.ruleIds.includes(filter.ruleId!)).map((entry) => entry.effect.workId)]);
    works = works.filter((work) => ids.has(work.id));
  }
  const ids = new Set(works.map((work) => work.id));
  const selected = decisions.filter((decision) => {
    if (filter.ruleId && !decisionRules(decision).includes(filter.ruleId)) return false;
    if (decision.workId) return ids.has(decision.workId);
    if (filter.slot) return false;
    const policy = decision.proposal?.policy as { scopeId?: string | null } | undefined;
    if (filter.scopeId !== undefined && (policy?.scopeId ?? null) !== filter.scopeId) return false;
    return !filter.ghostId || decision.ghostId === filter.ghostId;
  });
  const completed = works.filter((work) => work.state === "done");
  const rejected = works.filter((work) => work.state === "failed");
  const settled = completed.length + rejected.length;
  let tokens = 0, cost = 0, usageComplete = true, tokensComplete = true;
  for (const work of completed) {
    const conversations = ledger.conversations().filter((conversation) => conversation.workId === work.id);
    if (!conversations.length) { usageComplete = false; tokensComplete = false; }
    for (const conversation of conversations) {
      const usage = ledger.setting<UsageIndex | null>(`metrics:usage:${conversation.id}`, null);
      if (!usage || !usage.costKnown) usageComplete = false;
      if (!usage || !usage.tokensKnown) tokensComplete = false;
      if (usage) { tokens += usage.tokens; cost += usage.cost; }
    }
  }
  const observation = ledger.setting<ObservationIndex>("metrics:observations", { after: 0, complete: false, works: {} });
  let quotaWaitMs = 0, repeatGuardHits = 0, ownerOverturnedVerdicts = 0;
  for (const work of works) {
    const item = observation.works[work.id];
    if (!item) continue;
    quotaWaitMs += item.quotaWaitMs + (item.hold === "quota" ? Math.max(0, now - item.since) : 0);
    repeatGuardHits += item.repeatGuardHits; ownerOverturnedVerdicts += item.ownerOverturned;
  }
  const decisionOverturns = new Map<string, number>();
  for (const decision of selected) {
    if (decision.kind !== "accept_result" || !decision.workId) continue;
    const review = reviewOf(decision.proposal);
    if (!review || review.resolvedBy !== undefined) continue;
    if (review.recommend === "approve" && decision.state === "denied") decisionOverturns.set(decision.workId, (decisionOverturns.get(decision.workId) ?? 0) + 1);
  }
  for (const [workId, count] of decisionOverturns) ownerOverturnedVerdicts += Math.max(0, count - (observation.works[workId]?.ownerOverturned ?? 0));
  const rules: Record<string, { approved: number; denied: number }> = {};
  for (const decision of selected) for (const id of decisionRules(decision)) {
    if (filter.ruleId && id !== filter.ruleId) continue;
    const counts = rules[id] ??= { approved: 0, denied: 0 };
    if (decision.state === "approved") counts.approved++;
    if (decision.state === "denied") counts.denied++;
  }
  const decisionEffects = new Set(selected.filter((decision) => decision.state === "approved" || decision.state === "denied").map((decision) => decision.effectId));
  for (const { effect, policy, ruleIds } of effects) {
    if (!policy || decisionEffects.has(effect.id) || (filter.ruleId && !ruleIds.includes(filter.ruleId))) continue;
    if (effect.workId ? !ids.has(effect.workId) : filter.slot || (filter.scopeId !== undefined && policy.scopeId !== filter.scopeId) || (filter.ghostId && policy.ghostId !== filter.ghostId)) continue;
    const approved = policy.evaluation.decision === "allow" && effect.state === "done";
    const denied = policy.evaluation.decision === "deny" && effect.state === "denied";
    if (!approved && !denied) continue;
    for (const id of ruleIds) {
      if (filter.ruleId && id !== filter.ruleId) continue;
      const counts = rules[id] ??= { approved: 0, denied: 0 };
      if (approved) counts.approved++;
      if (denied) counts.denied++;
    }
  }
  return { filter, works: works.length, completed: completed.length, rejected: rejected.length,
    completionRate: settled ? completed.length / settled : null, rejectionRate: settled ? rejected.length / settled : null,
    elapsedMsPerAcceptedWork: completed.length ? completed.reduce((sum, work) => sum + Math.max(0, (work.endedAt ?? now) - (work.startedAt ?? work.createdAt)), 0) / completed.length : null,
    tokensPerAcceptedWork: completed.length && tokensComplete ? tokens / completed.length : null,
    costPerAcceptedWork: completed.length && usageComplete ? cost / completed.length : null,
    ownerOverturnedVerdicts, quotaWaitMs, repeatGuardHits, observationHistoryComplete: observation.complete, usageComplete, rules };
}
