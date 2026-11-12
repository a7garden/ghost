import type { Conversation, MessageOrigin, Work } from "@ghost/contract";
import type { Core } from "./core.ts";
import type { Submission } from "./ports.ts";
import { CommandError } from "./errors.ts";

/** Quota probe cadence when the provider's message carries no resume time: 1, 2, 4, … minutes, capped. */
const PROBE_BASE_MS = 60_000;
const PROBE_MAX_MS = 30 * 60_000;
/** How long the release of one deferred conversation may take before the probe is armed again. */
const RELEASE_GRACE_MS = 60_000;
/** One provider's quota state, kept in `settings` (`quota.providers`) so it survives a restart. */
interface QuotaEntry {
  /** What the provider said, shortened; distinguishes a usage limit from a per-minute rate limit. */
  reason: string;
  /** When the provider should be tried again: its reset time when it gave one, else a probe backoff time. */
  resumeAt: number;
  /** Quota hits without a success in between; grows the probe backoff. */
  failures: number;
  /** The conversation whose release is currently probing this provider; null when none. */
  probingBy: string | null;
}

/** What a conversation is waiting for: the turn that died on quota, plus admissions held since. */
interface DeferredRecord {
  conversationId: string;
  /** Resumes already prepared for this conversation; part of every resume request id. */
  attempts: number;
  /** The Pi entry of the error that last stopped the turn, so one run end is classified once. */
  entryId: number;
  origin: MessageOrigin;
  priority: number;
  providers: string[];
  /** Submissions to admit in order: the resume prompt first, then everything held meanwhile. */
  queue: Submission[];
  /** The request id currently released into the engine; its run end advances the queue. */
  releasing: string | null;
  updatedAt: number;
}

/** Owner messages first, then live Work and its review, then decision follow-ups, then self-directed wakes. */
export function admissionPriority(kind: Conversation["kind"], origin: MessageOrigin): number {
  if (origin === "owner") return 0;
  if (kind === "work" || kind === "review" || origin === "work") return 1;
  if (origin === "decision" || origin === "child_result" || origin === "verdict" || origin === "report") return 2;
  return 3;
}

/**
 * Provider quota as the Host sees it (docs/ghost-execution.md R1): a usage limit is a condition to wait out,
 * not a Ghost stopping and not a Work failing. Turns that die on quota are resumed at the provider's reset
 * time (or a growing probe), and admissions are held in priority order while a conversation's whole model
 * chain is exhausted. Everything lives in `settings`, so both survive a restart without a migration.
 */
export class Quota {
  private readonly key = "quota";
  private entries: Record<string, QuotaEntry> = {};
  private records: DeferredRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(private readonly core: Core) {}

  /** Startup: reload the wait, drop probes a restart cut off, and arm the resume timer. */
  start(now = Date.now()) {
    this.stopped = false;
    const stored = this.core.ledger.setting<{ entries?: Record<string, QuotaEntry>; records?: DeferredRecord[] } | null>(this.key, null);
    this.entries = stored?.entries ?? {};
    this.records = (stored?.records ?? []).filter((record) => {
      const conversation = this.core.ledger.findConversation(record.conversationId);
      if (!conversation) return false;
      record.releasing = null;
      record.queue = record.queue.slice(0, 200).map((submission) => ({ ...submission, text: submission.text.slice(0, 65536) }));
      return true;
    });
    for (const [provider, entry] of Object.entries(this.entries)) {
      const busy = entry.probingBy !== null && this.core.ledger.findConversation(entry.probingBy)?.busy === true;
      if (!busy) entry.probingBy = null;
    }
    // A quota hold without a waiting record is over: the restart lost the run end that would have cleared it.
    for (const work of this.core.ledger.worksInState("running")) {
      if (work.hold === "quota" && !this.records.some((record) => record.conversationId === work.conversationId)) this.core.works.holdForQuota(work.id, false);
    }
    this.persist();
    this.arm(now);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }

  /** Whether the provider's quota blocks admitting to it right now. */
  blocked(provider: string, now = Date.now()): boolean {
    const entry = this.entries[provider];
    if (!entry) return false;
    if (entry.probingBy !== null) return true;
    if (entry.resumeAt > now) return true;
    // Past its resume time, the provider only serves the conversation that has been waiting on it.
    return this.records.some((record) => record.providers.includes(provider));
  }

  /**
   * Whether a submission may be admitted. False while every model of the conversation's chain is blocked,
   * or while an earlier deferral of this conversation is still working through its queue; the caller then
   * holds the submission. `requestId` is set for a release the queue itself asked for.
   */
  admitting(conversationId: string, providers: string[], requestId: string | undefined, now = Date.now()): boolean {
    const record = this.records.find((item) => item.conversationId === conversationId);
    if (record) return record.releasing === requestId && requestId !== undefined;
    return !providers.some((provider) => this.blocked(provider, now));
  }

  /** Whether this request id is the one a deferred conversation is currently being released with. */
  releasing(conversationId: string, requestId: string): boolean {
    const record = this.records.find((item) => item.conversationId === conversationId);
    return record?.releasing === requestId;
  }

  /** Hold a submission the chain could not serve. It is admitted, in order, once the quota recovers. */
  hold(conversationId: string, submission: Submission, providers: string[], kind: Conversation["kind"], now = Date.now()): void {
    const conversation = this.core.ledger.findConversation(conversationId);
    if (!conversation) return;
    let record = this.records.find((item) => item.conversationId === conversationId);
    if (!record) {
      record = { conversationId, attempts: 0, entryId: 0, origin: submission.origin, priority: admissionPriority(kind, submission.origin), providers, queue: [], releasing: null, updatedAt: now };
      this.records.push(record);
    }
    record.priority = Math.min(record.priority, admissionPriority(kind, submission.origin));
    record.providers = [...new Set([...record.providers, ...providers])];
    if (!record.queue.some((item) => item.requestId === submission.requestId)) record.queue.push({ ...submission, text: submission.text.slice(0, 65536) });
    record.updatedAt = now;
    this.core.works.holdForQuotaOfWork(conversationId, true);
    this.persist();
  }

  /**
   * One run ended. `hit` records the provider quota the turn died on (the resume prompt is queued);
   * without one, the provider the answer came from is proven back and the queue advances.
   */
  turnEnded(conversationId: string, end: { entryId: number; origin: MessageOrigin; providers: string[]; serving: string | null; hit: { provider: string; reason: string; resumeAt: number | null } | null }, now = Date.now()): void {
    const record = this.records.find((item) => item.conversationId === conversationId);
    for (const entry of Object.values(this.entries)) {
      if (entry.probingBy === conversationId) entry.probingBy = null;
    }
    let dirty = false;
    if (end.hit) {
      const provider = end.hit.provider;
      const prior = this.entries[provider];
      const failures = (prior?.failures ?? 0) + 1;
      const resumeAt = end.hit.resumeAt ?? Math.min(PROBE_MAX_MS, PROBE_BASE_MS * 2 ** Math.min(10, failures - 1)) + now;
      this.entries[provider] = { reason: end.hit.reason, resumeAt, failures, probingBy: null };
    } else if (end.serving !== null && this.entries[end.serving]) {
      // A completed turn on the provider is the only proof the quota is back.
      delete this.entries[end.serving];
      dirty = true;
    }
    if (end.hit) {
      if (record) {
        // One run end is classified once: a restart re-observing the same error entry changes nothing.
        if (record.entryId === end.entryId) return;
        record.queue = record.queue.filter((item) => item.requestId !== record.releasing);
        record.attempts += 1;
        record.entryId = end.entryId;
        record.origin = end.origin;
        record.providers = [...new Set([...record.providers, ...end.providers])];
      } else {
        this.records.push({
          conversationId,
          attempts: 1,
          entryId: end.entryId,
          origin: end.origin,
          priority: admissionPriority(this.core.ledger.findConversation(conversationId)?.kind ?? "direct", end.origin),
          providers: end.providers,
          queue: [],
          releasing: null,
          updatedAt: now,
        });
      }
      const current = this.records.find((item) => item.conversationId === conversationId)!;
      current.queue.unshift(resumeSubmission(current));
      current.releasing = null;
      current.updatedAt = now;
      this.core.works.holdForQuotaOfWork(conversationId, true);
      this.persist();
      this.arm(now);
      return;
    }
    if (!record) {
      if (dirty) this.persist();
      return;
    }
    record.queue = record.queue.filter((item) => item.requestId !== record.releasing);
    record.releasing = null;
    record.updatedAt = now;
    // A held input for a Work that settled meanwhile is stale: its report already reached the origin.
    const conversation = this.core.ledger.findConversation(conversationId);
    const work = conversation?.workId ? this.core.ledger.work(conversation.workId) : null;
    if (conversation?.kind === "work" && (!work || !(work.state === "running" || work.state === "waiting"))) {
      record.queue = [];
    }
    if (record.queue.length > 0) {
      this.release(record, now);
      return;
    }
    this.records = this.records.filter((item) => item.conversationId !== conversationId);
    this.core.works.holdForQuotaOfWork(conversationId, false);
    this.persist();
    // Capacity the finished wait released goes straight to the next record in line.
    this.tick(now);
  }

  /** Release due waits: the highest-priority record per provider probes it with its next queued input. */
  tick(now = Date.now()): void {
    const order = [...this.records].sort((a, b) => a.priority - b.priority || a.updatedAt - b.updatedAt);
    const probing = new Set(Object.values(this.entries).filter((entry) => entry.probingBy !== null).map((entry) => entry.probingBy!));
    for (const record of order) {
      if (probing.has(record.conversationId)) continue;
      const blocked = record.providers.some((provider) => {
        const entry = this.entries[provider];
        return entry !== undefined && (entry.probingBy !== null || entry.resumeAt > now);
      });
      if (!blocked) this.release(record, now);
    }
    this.arm(now);
  }

  /** The wait as the owner reads it: one line per provider. */
  waiting(now = Date.now()): { provider: string; reason: string; resumeAt: number; conversations: number }[] {
    return Object.entries(this.entries)
      .filter(([, entry]) => entry.probingBy !== null || entry.resumeAt > now)
      .map(([provider, entry]) => ({ provider, reason: entry.reason, resumeAt: entry.resumeAt, conversations: this.records.filter((record) => record.providers.includes(provider)).length }));
  }

  private release(record: DeferredRecord, now: number): void {
    const submission = record.queue[0];
    if (!submission) return;
    const provider = record.providers.find((candidate) => this.entries[candidate] !== undefined);
    if (provider !== undefined) this.entries[provider]!.probingBy = record.conversationId;
    record.releasing = submission.requestId;
    record.updatedAt = now;
    this.persist();
    const conversationId = record.conversationId;
    void this.core.lane(`quota:${conversationId}`, async () => {
      try {
        await this.core.engine.submit(conversationId, submission);
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        // The engine refused the release (no model, no credential): probe again later, in order.
        this.core.log(`quota release of ${conversationId} was refused`, error.message);
        const current = this.records.find((item) => item.conversationId === conversationId);
        if (!current) return;
        current.releasing = null;
        for (const entry of Object.values(this.entries)) if (entry.probingBy === conversationId) entry.probingBy = null;
        current.updatedAt = Date.now() + RELEASE_GRACE_MS;
        this.persist();
      }
    });
  }

  private arm(now: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer ?? undefined);
    const next = Object.values(this.entries)
      .filter((entry) => entry.probingBy === null)
      .reduce((at: number | null, entry) => (at === null || entry.resumeAt < at ? entry.resumeAt : at), null);
    const due = this.records.length > 0 && this.records.some((record) => record.queue.length > 0);
    const when = next ?? (due ? now + RELEASE_GRACE_MS : null);
    if (when === null) {
      this.timer = null;
      return;
    }
    this.timer = setTimeout(() => this.tick(), Math.max(50, Math.min(when - now, RELEASE_GRACE_MS)));
  }

  private persist(): void {
    this.core.ledger.tx(() => this.core.ledger.putSetting(this.key, { entries: this.entries, records: this.records }));
  }
}

/** The input that continues a quota-ended turn, under a request id unique to this resume. */
function resumeSubmission(record: DeferredRecord): Submission {
  return {
    text:
      "The model provider's usage limit paused this turn; the quota has recovered, so continue exactly where you stopped." +
      " Re-check what you had already done before repeating any step, then finish the turn.",
    origin: record.origin,
    requestId: `quota-resume:${record.conversationId}:${record.attempts}`,
  };
}

/**
 * R8: the same tool refusing the same way in one conversation. Three refusals get an explanation of the
 * constraint; six stop the Work and tell its origin. Counts live for the process; a restart simply replays
 * whatever the model tries next.
 */
export class Repeats {
  private readonly counts = new Map<string, { key: string; count: number }>();

  /** Record one errored call and return how often this error class has now repeated. */
  record(conversationId: string, tool: string, message: string): number {
    const key = `${tool}:${normalize(message)}`;
    const prior = this.counts.get(conversationId);
    if (!prior || prior.key !== key) {
      this.counts.set(conversationId, { key, count: 1 });
      return 1;
    }
    prior.count += 1;
    return prior.count;
  }

  /** The conversation moved on: a new error class starts from one again. */
  reset(conversationId: string): void {
    this.counts.delete(conversationId);
  }
}

/** The error class a refusal counts under: its tool and the normalized prefix of its message. */
function normalize(message: string): string {
  return message.replaceAll(/\s+/g, " ").trim().slice(0, 160).toLowerCase();
}

/** Working time a Work has spent, including the span its clock is running now. */
export function budgetSpent(work: Work, now = Date.now()): number {
  return work.budgetUsedMs + (work.budgetSince === null ? 0 : Math.max(0, now - work.budgetSince));
}
