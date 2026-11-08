import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Acceptance,
  Avatar,
  Conversation,
  Decision,
  Device,
  DeviceGrant,
  Effect,
  Ghost,
  LedgerEvent,
  LedgerEventData,
  ModelRef,
  Notification,
  Provider,
  Schedule,
  Settings,
  Space,
  Work,
  ArtifactRef,
  Verdict,
} from "@ghost/contract";
import { MIGRATIONS } from "./schema.ts";

type Row = Record<string, SQLQueryBindings>;
type Listener = (event: LedgerEvent) => void;

const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));
const parseJson = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const parseNullable = <T>(value: unknown): T | null => (value === null || value === undefined ? null : parseJson<T>(value));
const bool = (value: unknown) => value === 1 || value === true;

/** Days of change events kept for reconnecting clients. */
const EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Internal collaboration records; clients observe the associated Work change event. */
export interface WorkQuestion {
  id: string;
  workId: string;
  parentWorkId: string;
  question: string;
  answer: string | null;
  state: "pending" | "answered" | "cancelled";
  createdAt: number;
  answeredAt: number | null;
  submittedAt: number | null;
  answerSubmittedAt: number | null;
}

export type ReviseLesson = Pick<Verdict, "source" | "reasons" | "evidence" | "scope" | "at">;

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFound";
  }
}

/**
 * The host's single source of truth. Every method is synchronous; a write never awaits,
 * so the process is the one serialized writer. Mutations made inside `tx` emit their
 * change events after the transaction commits.
 */
export class Ledger {
  readonly db: Database;
  private readonly listeners = new Set<Listener>();
  private pending: LedgerEventData[] | null = null;
  private depth = 0;
  private committedTasks: (() => void)[] | null = null;
  private rolledBackTasks: (() => void)[] | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const { user_version: version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (version > MIGRATIONS.length) throw new Error(`ledger schema ${version} is newer than this host (${MIGRATIONS.length})`);
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[index]!);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      })();
    }
  }

  /** Run synchronous `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return this.synchronous(fn());
    this.pending = [];
    this.committedTasks = [];
    this.rolledBackTasks = [];
    this.depth++;
    let events: LedgerEvent[] = [];
    let committed = false;
    try {
      const result = this.db.transaction(() => {
        const value = this.synchronous(fn());
        events = this.flush();
        return value;
      })();
      committed = true;
      return result;
    } finally {
      const tasks = committed ? this.committedTasks : this.rolledBackTasks;
      this.depth--;
      this.pending = null;
      this.committedTasks = null;
      this.rolledBackTasks = null;
      for (const task of tasks ?? []) task();
      if (committed) for (const event of events) for (const listener of this.listeners) listener(event);
    }
  }

  private synchronous<T>(value: T): T {
    if (value !== null && typeof value === "object" && "then" in value) throw new Error("Ledger.tx cannot return a Promise");
    return value;
  }

  /** Defer engine work until the outer commit; a rollback must also settle its caller. */
  afterCommit(task: () => void, rollback?: () => void) {
    if (this.depth === 0) {
      task();
      return;
    }
    this.committedTasks!.push(task);
    if (rollback) this.rolledBackTasks!.push(rollback);
  }

  private flush(): LedgerEvent[] {
    const at = Date.now();
    const insert = this.db.query("INSERT INTO events (at, data) VALUES (?, ?) RETURNING seq");
    return (this.pending ?? []).map((data) => {
      const { seq } = insert.get(at, JSON.stringify(data)) as { seq: number };
      return { seq, at, data };
    });
  }

  /** Record a change event; only valid inside `tx`. */
  emit(data: LedgerEventData) {
    if (!this.pending) throw new Error("ledger.emit outside a transaction");
    this.pending.push(data);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  seq(): number {
    const row = this.db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return row.seq;
  }

  /** Events after `seq`, or null when they are no longer retained. */
  eventsAfter(seq: number, limit = 1000): LedgerEvent[] | null {
    const oldest = this.db.query("SELECT MIN(seq) AS seq FROM events").get() as { seq: number | null };
    if (oldest.seq !== null && seq < oldest.seq - 1) return null;
    return (this.db.query("SELECT seq, at, data FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as Row[]).map(
      (row) => ({ seq: Number(row.seq), at: Number(row.at), data: parseJson<LedgerEventData>(row.data) }),
    );
  }

  pruneEvents(now = Date.now()) {
    const keep = this.db.query("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
    this.db.query("DELETE FROM events WHERE at < ? AND seq < ?").run(now - EVENT_RETENTION_MS, keep.seq ?? 0);
  }

  /** Request receipts and read notifications are kept for 30 days. */
  pruneHistory(now = Date.now()) {
    const cutoff = now - RECEIPT_RETENTION_MS;
    this.db.query("DELETE FROM requests WHERE created_at < ? AND state = 'done'").run(cutoff);
    this.db.query("DELETE FROM notifications WHERE created_at < ? AND read_at IS NOT NULL").run(cutoff);
  }

  // Ghosts

  ghost(id: string): Ghost {
    const row = this.db.query("SELECT * FROM ghosts WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`ghost ${id}`);
    return toGhost(row);
  }

  ghosts(): Ghost[] {
    return (this.db.query("SELECT * FROM ghosts ORDER BY is_default DESC, created_at").all() as Row[]).map(toGhost);
  }

  defaultGhost(): Ghost | null {
    const row = this.db.query("SELECT * FROM ghosts WHERE is_default = 1").get() as Row | null;
    return row ? toGhost(row) : null;
  }

  putGhost(ghost: Ghost) {
    if (ghost.isDefault) this.db.query("UPDATE ghosts SET is_default = 0 WHERE is_default = 1 AND id <> ?").run(ghost.id);
    this.db
      .query(
        `INSERT INTO ghosts (id, name, persona, look, model, is_default, state, tools, fallbacks, skills, deleted_at, direct_conversation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, persona = excluded.persona, look = excluded.look,
           model = excluded.model, is_default = excluded.is_default, state = excluded.state, tools = excluded.tools,
           fallbacks = excluded.fallbacks, skills = excluded.skills, deleted_at = excluded.deleted_at,
           direct_conversation_id = excluded.direct_conversation_id, updated_at = excluded.updated_at`,
      )
      .run(
        ghost.id, ghost.name, ghost.persona, json(ghost.look), json(ghost.model), ghost.isDefault ? 1 : 0, ghost.state, json(ghost.tools),
        json(ghost.fallbacks), json(ghost.skills), ghost.deletedAt, ghost.directConversationId, ghost.createdAt, ghost.updatedAt,
      );
    this.emit({ type: "ghost", ghost });
  }

  // Conversations

  conversation(id: string): Conversation {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`conversation ${id}`);
    return toConversation(row);
  }

  findConversation(id: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as Row | null;
    return row ? toConversation(row) : null;
  }

  conversations(filter: { kind?: Conversation["kind"]; ghostId?: string } = {}): Conversation[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.kind) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.ghostId) {
      clauses.push("ghost_id = ?");
      params.push(filter.ghostId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.query(`SELECT * FROM conversations ${where} ORDER BY last_activity_at DESC`).all(...params) as Row[]).map(toConversation);
  }

  /** Engine-internal mapping from a host conversation to its Pi conversation. */
  piConversationId(id: string): string | null {
    const row = this.db.query("SELECT pi_conversation_id FROM conversations WHERE id = ?").get(id) as Row | null;
    return row?.pi_conversation_id ? String(row.pi_conversation_id) : null;
  }

  conversationByPiId(piId: string): Conversation | null {
    const row = this.db.query("SELECT * FROM conversations WHERE pi_conversation_id = ?").get(piId) as Row | null;
    return row ? toConversation(row) : null;
  }

  setPiConversationId(id: string, piId: string) {
    this.db.query("UPDATE conversations SET pi_conversation_id = ? WHERE id = ?").run(piId, id);
  }

  putConversation(conversation: Conversation) {
    this.db
      .query(
        `INSERT INTO conversations (id, ghost_id, kind, work_id, title, model, busy, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, model = excluded.model,
           busy = excluded.busy, last_activity_at = excluded.last_activity_at`,
      )
      .run(
        conversation.id,
        conversation.ghostId,
        conversation.kind,
        conversation.workId,
        conversation.title,
        json(conversation.model),
        conversation.busy ? 1 : 0,
        conversation.createdAt,
        conversation.lastActivityAt,
      );
    this.emit({ type: "conversation", conversation });
  }

  // Works

  work(id: string): Work {
    const row = this.db.query("SELECT * FROM works WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`work ${id}`);
    return toWork(row);
  }

  /** Settled Work whose report or parent notification may not have been delivered. */
  unreportedWorks(): Work[] {
    return (this.db.query("SELECT * FROM works WHERE state IN ('done','failed','cancelled') AND reported_at IS NULL ORDER BY updated_at").all() as Row[]).map(toWork);
  }

  markReported(workId: string, at: number | null) {
    this.db.query("UPDATE works SET reported_at = ? WHERE id = ?").run(at, workId);
  }

  findWork(id: string): Work | null {
    const row = this.db.query("SELECT * FROM works WHERE id = ?").get(id) as Row | null;
    return row ? toWork(row) : null;
  }

  workByConversation(conversationId: string): Work | null {
    const row = this.db.query("SELECT * FROM works WHERE conversation_id = ?").get(conversationId) as Row | null;
    return row ? toWork(row) : null;
  }

  children(workId: string): Work[] {
    return (this.db.query("SELECT * FROM works WHERE parent_id = ? ORDER BY created_at").all(workId) as Row[]).map(toWork);
  }

  worksInState(...states: Work["state"][]): Work[] {
    const marks = states.map(() => "?").join(",");
    return (this.db.query(`SELECT * FROM works WHERE state IN (${marks}) ORDER BY created_at`).all(...states) as Row[]).map(toWork);
  }

  /** Live Work plus the `recent` most recently settled. */
  worksForState(recent = 200): Work[] {
    return (
      this.db
        .query(
          `SELECT * FROM works WHERE state NOT IN ('done','failed','cancelled')
           UNION ALL
           SELECT * FROM (SELECT * FROM works WHERE state IN ('done','failed','cancelled') ORDER BY updated_at DESC LIMIT ?)`,
        )
        .all(recent) as Row[]
    ).map(toWork);
  }

  /** Times the work conversation went idle without completing at the current revision. Internal; not in the contract. */
  idleNudges(workId: string): number {
    const row = this.db.query("SELECT idle_nudges FROM works WHERE id = ?").get(workId) as Row | null;
    return row ? Number(row.idle_nudges) : 0;
  }

  setIdleNudges(workId: string, count: number) {
    this.db.query("UPDATE works SET idle_nudges = ? WHERE id = ?").run(count, workId);
  }

  putWork(work: Work) {
    this.db
      .query(
        `INSERT INTO works (id, parent_id, root_id, ghost_id, origin_conversation_id, conversation_id, title, brief, acceptance, state,
           revision, revisions_used, deadline_at, result, verdict, reason, created_at, started_at, ended_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET conversation_id = excluded.conversation_id, title = excluded.title, brief = excluded.brief,
           acceptance = excluded.acceptance, state = excluded.state, revision = excluded.revision, revisions_used = excluded.revisions_used,
           deadline_at = excluded.deadline_at, result = excluded.result, verdict = excluded.verdict, reason = excluded.reason,
           started_at = excluded.started_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
      )
      .run(
        work.id,
        work.parentId,
        work.rootId,
        work.ghostId,
        work.originConversationId,
        work.conversationId,
        work.title,
        work.brief,
        json(work.acceptance),
        work.state,
        work.revision,
        work.revisionsUsed,
        work.deadlineAt,
        json(work.result),
        json(work.verdict),
        work.reason,
        work.createdAt,
        work.startedAt,
        work.endedAt,
        work.updatedAt,
      );
    this.emit({ type: "work", work });
  }

  reviseHistory(workId: string): ReviseLesson[] {
    const row = this.db.query("SELECT revise_history FROM works WHERE id = ?").get(workId) as Row | null;
    if (!row) throw new NotFound(`work ${workId}`);
    return parseJson<ReviseLesson[]>(row.revise_history);
  }

  appendReviseHistory(workId: string, verdict: Verdict) {
    const history = this.reviseHistory(workId);
    history.push({
      source: verdict.source, reasons: verdict.reasons.slice(0, 8192), at: verdict.at,
      ...(verdict.evidence === undefined ? {} : { evidence: verdict.evidence.slice(0, 8192) }),
      ...(verdict.scope === undefined ? {} : { scope: verdict.scope.slice(0, 2048) }),
    });
    // Resumed roots may accumulate revisions over many attempts. Keep the newest lessons,
    // with a strict serialized cap even when text requires JSON escaping.
    while (history.length > 1 && JSON.stringify(history).length > 131072) history.shift();
    this.db.query("UPDATE works SET revise_history = ? WHERE id = ?").run(JSON.stringify(history), workId);
    this.emit({ type: "work", work: this.work(workId) });
  }

  findWorkQuestion(id: string): WorkQuestion | null {
    const row = this.db.query("SELECT * FROM work_questions WHERE id = ?").get(id) as Row | null;
    return row ? {
      id: String(row.id), workId: String(row.work_id), parentWorkId: String(row.parent_work_id),
      question: String(row.question), answer: row.answer === null ? null : String(row.answer),
      state: String(row.state) as WorkQuestion["state"], createdAt: Number(row.created_at),
      answeredAt: row.answered_at === null ? null : Number(row.answered_at),
      submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
      answerSubmittedAt: row.answer_submitted_at === null ? null : Number(row.answer_submitted_at),
    } : null;
  }

  workQuestions(workId: string, asParent = false): WorkQuestion[] {
    return (this.db.query(`SELECT id FROM work_questions WHERE ${asParent ? "parent_work_id" : "work_id"} = ? ORDER BY created_at, id`).all(workId) as Row[])
      .map((row) => this.findWorkQuestion(String(row.id))!);
  }

  workQuestionsAwaitingSubmission(): WorkQuestion[] {
    return (this.db.query(`SELECT id FROM work_questions
      WHERE (state = 'pending' AND submitted_at IS NULL) OR (state = 'answered' AND answer_submitted_at IS NULL)
      ORDER BY created_at, id`).all() as Row[]).map((row) => this.findWorkQuestion(String(row.id))!);
  }

  putWorkQuestion(question: WorkQuestion) {
    this.db.query(`INSERT INTO work_questions
      (id, work_id, parent_work_id, question, answer, state, created_at, answered_at, submitted_at, answer_submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET answer = excluded.answer, state = excluded.state, answered_at = excluded.answered_at,
        submitted_at = excluded.submitted_at, answer_submitted_at = excluded.answer_submitted_at`)
      .run(question.id, question.workId, question.parentWorkId, question.question, question.answer, question.state,
        question.createdAt, question.answeredAt, question.submittedAt, question.answerSubmittedAt);
    this.emit({ type: "work", work: this.work(question.workId) });
  }

  cancelWorkQuestions(workId: string) {
    for (const question of this.workQuestions(workId)) {
      if (question.state === "pending") this.putWorkQuestion({ ...question, state: "cancelled" });
    }
  }

  // Decisions

  decision(id: string): Decision {
    const row = this.db.query("SELECT * FROM decisions WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`decision ${id}`);
    return toDecision(row);
  }

  /** Resolved decisions whose follow-up (answer delivery, effect, document write) may not have run. */
  decisionsAwaitingFollowUp(): Decision[] {
    return (this.db.query("SELECT * FROM decisions WHERE state <> 'pending' AND followed_up_at IS NULL ORDER BY resolved_at").all() as Row[]).map(toDecision);
  }

  markFollowedUp(decisionId: string, at: number) {
    this.db.query("UPDATE decisions SET followed_up_at = ? WHERE id = ?").run(at, decisionId);
  }

  findDecision(id: string): Decision | null {
    const row = this.db.query("SELECT * FROM decisions WHERE id = ?").get(id) as Row | null;
    return row ? toDecision(row) : null;
  }

  decisionsForState(recent = 100): Decision[] {
    return (
      this.db
        .query(
          `SELECT * FROM decisions WHERE state = 'pending'
           UNION ALL
           SELECT * FROM (SELECT * FROM decisions WHERE state <> 'pending' ORDER BY resolved_at DESC LIMIT ?)`,
        )
        .all(recent) as Row[]
    ).map(toDecision);
  }

  decisionsForWork(workId: string): Decision[] {
    return (this.db.query("SELECT * FROM decisions WHERE work_id = ? ORDER BY created_at").all(workId) as Row[]).map(toDecision);
  }

  pendingDecisions(filter: { workId?: string; effectId?: string; conversationId?: string } = {}): Decision[] {
    const clauses = ["state = 'pending'"];
    const params: SQLQueryBindings[] = [];
    for (const [column, value] of [
      ["work_id", filter.workId],
      ["effect_id", filter.effectId],
      ["conversation_id", filter.conversationId],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    return (this.db.query(`SELECT * FROM decisions WHERE ${clauses.join(" AND ")} ORDER BY created_at`).all(...params) as Row[]).map(toDecision);
  }

  putDecision(decision: Decision) {
    this.db
      .query(
        `INSERT INTO decisions (id, kind, ghost_id, conversation_id, work_id, effect_id, title, detail, options, proposal, state, answer, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, answer = excluded.answer, resolved_at = excluded.resolved_at`,
      )
      .run(
        decision.id,
        decision.kind,
        decision.ghostId,
        decision.conversationId,
        decision.workId,
        decision.effectId,
        decision.title,
        decision.detail,
        json(decision.options),
        json(decision.proposal),
        decision.state,
        decision.answer,
        decision.createdAt,
        decision.resolvedAt,
      );
    this.emit({ type: "decision", decision });
  }

  // Effects

  effect(id: string): Effect {
    const row = this.db.query("SELECT * FROM effects WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`effect ${id}`);
    return toEffect(row);
  }

  effectByCall(conversationId: string, callId: string): Effect | null {
    const row = this.db.query("SELECT * FROM effects WHERE conversation_id = ? AND call_id = ?").get(conversationId, callId) as Row | null;
    return row ? toEffect(row) : null;
  }

  effectsForWork(workId: string): Effect[] {
    return (this.db.query("SELECT * FROM effects WHERE work_id = ? ORDER BY created_at").all(workId) as Row[]).map(toEffect);
  }

  effectsInState(state: Effect["state"]): Effect[] {
    return (this.db.query("SELECT * FROM effects WHERE state = ?").all(state) as Row[]).map(toEffect);
  }

  putEffect(effect: Effect) {
    this.db
      .query(
        `INSERT INTO effects (id, work_id, conversation_id, call_id, tool, summary, input_digest, state, result, created_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, result = excluded.result, summary = excluded.summary, ended_at = excluded.ended_at`,
      )
      .run(
        effect.id,
        effect.workId,
        effect.conversationId,
        effect.callId,
        effect.tool,
        effect.summary,
        effect.inputDigest,
        effect.state,
        effect.result,
        effect.createdAt,
        effect.endedAt,
      );
    this.emit({ type: "effect", effect });
  }

  // Artifacts (metadata; bytes live in the artifact store)

  addArtifact(workId: string | null, ref: ArtifactRef) {
    this.db
      .query("INSERT OR IGNORE INTO artifacts (digest, work_id, name, media_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ref.digest, workId, ref.name, ref.mediaType, ref.size, Date.now());
  }

  artifactsForWork(workId: string): ArtifactRef[] {
    return (this.db.query("SELECT digest, name, media_type, size FROM artifacts WHERE work_id = ? ORDER BY created_at").all(workId) as Row[]).map(
      (row) => ({ digest: String(row.digest), name: String(row.name), mediaType: String(row.media_type), size: Number(row.size) }),
    );
  }

  artifactWorkIds(digest: string): (string | null)[] {
    return (this.db.query("SELECT DISTINCT work_id FROM artifacts WHERE digest = ?").all(digest) as Row[]).map((row) =>
      row.work_id === null ? null : String(row.work_id),
    );
  }

  /** Recorded artifact rows for a digest across Works, including work-less rows (avatar images). */
  artifactsForDigest(digest: string): (ArtifactRef & { workId: string | null })[] {
    return (this.db.query("SELECT work_id, name, media_type, size FROM artifacts WHERE digest = ? ORDER BY created_at").all(digest) as Row[]).map(
      (row) => ({
        digest,
        workId: row.work_id === null ? null : String(row.work_id),
        name: String(row.name),
        mediaType: String(row.media_type),
        size: Number(row.size),
      }),
    );
  }

  // Schedules

  schedule(id: string): Schedule {
    const row = this.db.query("SELECT * FROM schedules WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`schedule ${id}`);
    return toSchedule(row);
  }

  findSchedule(id: string): Schedule | null {
    const row = this.db.query("SELECT * FROM schedules WHERE id = ?").get(id) as Row | null;
    return row ? toSchedule(row) : null;
  }

  schedules(): Schedule[] {
    return (this.db.query("SELECT * FROM schedules WHERE state <> 'done' ORDER BY next_at").all() as Row[]).map(toSchedule);
  }

  dueSchedules(now: number): Schedule[] {
    return (this.db.query("SELECT * FROM schedules WHERE state = 'active' AND next_at <= ? ORDER BY next_at").all(now) as Row[]).map(toSchedule);
  }

  nextScheduleAt(): number | null {
    const row = this.db.query("SELECT MIN(next_at) AS at FROM schedules WHERE state = 'active'").get() as { at: number | null };
    return row.at;
  }

  putSchedule(schedule: Schedule) {
    this.db
      .query(
        `INSERT INTO schedules (id, ghost_id, conversation_id, prompt, spec, next_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET prompt = excluded.prompt, spec = excluded.spec, next_at = excluded.next_at, state = excluded.state`,
      )
      .run(schedule.id, schedule.ghostId, schedule.conversationId, schedule.prompt, json(schedule.spec), schedule.nextAt, schedule.state, schedule.createdAt);
    this.emit({ type: "schedule", schedule });
  }

  deleteSchedule(id: string) {
    this.db.query("DELETE FROM schedules WHERE id = ?").run(id);
    this.emit({ type: "schedule.removed", id });
  }

  // Notifications

  notificationsForState(limit = 100): Notification[] {
    return (
      this.db
        .query(
          `SELECT * FROM notifications WHERE read_at IS NULL
           UNION
           SELECT * FROM (SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?)
           ORDER BY created_at DESC`,
        )
        .all(limit) as Row[]
    ).map(toNotification);
  }

  notification(id: string): Notification {
    const row = this.db.query("SELECT * FROM notifications WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`notification ${id}`);
    return toNotification(row);
  }

  unpushedNotifications(): Notification[] {
    return (this.db.query("SELECT * FROM notifications WHERE pushed_at IS NULL ORDER BY created_at").all() as Row[]).map(toNotification);
  }

  markPushed(id: string, at: number) {
    this.db.query("UPDATE notifications SET pushed_at = ? WHERE id = ?").run(at, id);
  }

  putNotification(notification: Notification) {
    this.db
      .query(
        `INSERT INTO notifications (id, kind, ghost_id, conversation_id, work_id, decision_id, title, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run(
        notification.id,
        notification.kind,
        notification.ghostId,
        notification.conversationId,
        notification.workId,
        notification.decisionId,
        notification.title,
        notification.body,
        notification.createdAt,
        notification.readAt,
      );
    this.emit({ type: "notification", notification });
  }

  // Devices and pairing

  devices(): Device[] {
    return (this.db.query("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at").all() as Row[]).map(toDevice);
  }

  device(id: string): Device {
    const row = this.db.query("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) as Row | null;
    if (!row) throw new NotFound(`device ${id}`);
    return toDevice(row);
  }

  deviceByTokenHash(tokenHash: string): Device | null {
    const row = this.db.query("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) as Row | null;
    return row ? toDevice(row) : null;
  }

  pushTargets(): { deviceId: string; token: string; environment: "sandbox" | "production"; grants: DeviceGrant[] }[] {
    return (this.db.query("SELECT id, push_token, push_environment, grants FROM devices WHERE revoked_at IS NULL AND push_token IS NOT NULL").all() as Row[]).map(
      (row) => ({
        deviceId: String(row.id),
        token: String(row.push_token),
        environment: row.push_environment === "production" ? "production" : "sandbox",
        grants: parseJson<DeviceGrant[]>(row.grants),
      }),
    );
  }

  insertDevice(device: Device, tokenHash: string) {
    this.db
      .query("INSERT INTO devices (id, name, token_hash, grants, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(device.id, device.name, tokenHash, json(device.grants), device.createdAt);
    this.emit({ type: "device", device });
  }

  updateDevice(device: Device) {
    this.db.query("UPDATE devices SET name = ?, grants = ?, last_seen_at = ? WHERE id = ?").run(device.name, json(device.grants), device.lastSeenAt, device.id);
    this.emit({ type: "device", device });
  }

  touchDevice(id: string, at: number) {
    this.db.query("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  setPushToken(id: string, token: string | null, environment: "sandbox" | "production" | null) {
    this.db.query("UPDATE devices SET push_token = ?, push_environment = ? WHERE id = ?").run(token, environment, id);
    this.emit({ type: "device", device: this.device(id) });
  }

  revokeDevice(id: string, at: number) {
    this.db.query("UPDATE devices SET revoked_at = ?, push_token = NULL WHERE id = ?").run(at, id);
    this.emit({ type: "device.removed", id });
  }

  insertPairing(codeHash: string, name: string, grants: DeviceGrant[], expiresAt: number) {
    this.db.query("INSERT INTO pairings (code_hash, name, grants, expires_at) VALUES (?, ?, ?, ?)").run(codeHash, name, json(grants), expiresAt);
  }

  /** Atomically claim an unexpired pairing; returns its offer or null. */
  claimPairing(codeHash: string, deviceId: string, now: number): { name: string; grants: DeviceGrant[] } | null {
    const row = this.db
      .query("UPDATE pairings SET device_id = ? WHERE code_hash = ? AND device_id IS NULL AND expires_at > ? RETURNING name, grants")
      .get(deviceId, codeHash, now) as Row | null;
    return row ? { name: String(row.name), grants: parseJson<DeviceGrant[]>(row.grants) } : null;
  }

  prunePairings(now: number) {
    this.db.query("DELETE FROM pairings WHERE expires_at <= ?").run(now);
  }

  /** Drop one Ghost from every unclaimed pairing offer, so a later claim cannot grant it. */
  scrubPairingGrants(ghostId: string) {
    const rows = this.db.query("SELECT code_hash, grants FROM pairings WHERE device_id IS NULL").all() as Row[];
    for (const row of rows) {
      const grants = parseJson<DeviceGrant[]>(row.grants);
      const kept = grants.filter((grant) => grant.ghostId !== ghostId);
      if (kept.length !== grants.length) this.db.query("UPDATE pairings SET grants = ? WHERE code_hash = ?").run(json(kept), String(row.code_hash));
    }
  }

  // Spaces

  spaces(): Space[] {
    return (this.db.query("SELECT * FROM spaces ORDER BY created_at").all() as Row[]).map(toSpace);
  }

  space(id: string): Space {
    const row = this.db.query("SELECT * FROM spaces WHERE id = ?").get(id) as Row | null;
    if (!row) throw new NotFound(`space ${id}`);
    return toSpace(row);
  }

  putSpace(space: Space) {
    this.db
      .query(
        `INSERT INTO spaces (id, name, path, grants, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, grants = excluded.grants`,
      )
      .run(space.id, space.name, space.path, json(space.grants), space.createdAt);
    this.emit({ type: "space", space });
  }

  deleteSpace(id: string) {
    this.db.query("DELETE FROM spaces WHERE id = ?").run(id);
    this.emit({ type: "space.removed", id });
  }

  // Avatars

  avatars(): Avatar[] {
    return (this.db.query("SELECT * FROM avatars ORDER BY created_at").all() as Row[]).map(toAvatar);
  }

  putAvatar(avatar: Avatar) {
    this.db
      .query("INSERT INTO avatars (id, name, description, image_digest, design, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(avatar.id, avatar.name, avatar.description, avatar.imageDigest, json(avatar.design), avatar.createdAt);
    this.emit({ type: "avatar", avatar });
  }

  deleteAvatar(id: string) {
    this.db.query("DELETE FROM avatars WHERE id = ?").run(id);
    this.emit({ type: "avatar.removed", id });
  }

  // Settings and providers

  settings(): Settings {
    return {
      defaultModel: this.setting<ModelRef | null>("defaultModel", null),
      reviewModel: this.setting<ModelRef | null>("reviewModel", null),
      providers: this.providers(),
    };
  }

  setting<T>(key: string, fallback: T): T {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as Row | null;
    return row ? parseJson<T>(row.value) : fallback;
  }

  putSetting(key: string, value: unknown) {
    this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  providers(): Provider[] {
    return (this.db.query("SELECT * FROM providers ORDER BY id").all() as Row[]).map((row) => ({
      id: String(row.id),
      kind: String(row.kind) as Provider["kind"],
      name: String(row.name),
      baseUrl: row.base_url === null ? null : String(row.base_url),
      models: parseJson<Provider["models"]>(row.models),
      hasCredential: false,
    }));
  }

  putProvider(provider: Omit<Provider, "hasCredential">) {
    this.db
      .query(
        `INSERT INTO providers (id, kind, name, base_url, models) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, base_url = excluded.base_url,
           models = excluded.models`,
      )
      .run(provider.id, provider.kind, provider.name, provider.baseUrl, json(provider.models));
  }

  deleteProvider(id: string) {
    this.db.query("DELETE FROM providers WHERE id = ?").run(id);
  }

  // Request receipts

  request(id: string): { principal: string; digest: string; state: "pending" | "done"; outcome: Record<string, unknown> } | null {
    const row = this.db.query("SELECT principal, digest, state, outcome FROM requests WHERE id = ?").get(id) as Row | null;
    return row ? { principal: String(row.principal), digest: String(row.digest), state: String(row.state) as "pending" | "done", outcome: parseJson(row.outcome) } : null;
  }

  /** Reserve an async command's identity before I/O, including failed or interrupted attempts. */
  claimRequest(id: string, principal: string, digest: string, outcome: Record<string, unknown> = {}) {
    this.db.query("INSERT INTO requests (id, principal, digest, outcome, created_at, state) VALUES (?, ?, ?, ?, ?, 'pending')").run(id, principal, digest, JSON.stringify(outcome), Date.now());
  }

  putRequest(id: string, principal: string, digest: string, outcome: Record<string, unknown>) {
    this.db.query(`INSERT INTO requests (id, principal, digest, outcome, created_at, state) VALUES (?, ?, ?, ?, ?, 'done')
      ON CONFLICT (id) DO UPDATE SET outcome = excluded.outcome, state = 'done'
      WHERE requests.principal = excluded.principal AND requests.digest = excluded.digest`)
      .run(id, principal, digest, JSON.stringify(outcome), Date.now());
  }
}

function toGhost(row: Row): Ghost {
  return {
    id: String(row.id),
    name: String(row.name),
    persona: String(row.persona),
    look: parseJson(row.look),
    model: parseNullable(row.model),
    isDefault: bool(row.is_default),
    state: String(row.state) as Ghost["state"],
    tools: parseJson(row.tools),
    fallbacks: parseJson(row.fallbacks),
    skills: parseJson(row.skills),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    directConversationId: String(row.direct_conversation_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toConversation(row: Row): Conversation {
  return {
    id: String(row.id),
    ghostId: String(row.ghost_id),
    kind: String(row.kind) as Conversation["kind"],
    workId: row.work_id === null ? null : String(row.work_id),
    title: String(row.title),
    model: parseNullable(row.model),
    busy: bool(row.busy),
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at),
  };
}

function toWork(row: Row): Work {
  return {
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    rootId: String(row.root_id),
    ghostId: String(row.ghost_id),
    originConversationId: String(row.origin_conversation_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    title: String(row.title),
    brief: String(row.brief),
    acceptance: parseJson<Acceptance>(row.acceptance),
    state: String(row.state) as Work["state"],
    revision: Number(row.revision),
    revisionsUsed: Number(row.revisions_used),
    deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
    result: parseNullable(row.result),
    verdict: parseNullable(row.verdict),
    reason: row.reason === null ? null : String(row.reason),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    updatedAt: Number(row.updated_at),
  };
}

function toDecision(row: Row): Decision {
  return {
    id: String(row.id),
    kind: String(row.kind) as Decision["kind"],
    ghostId: String(row.ghost_id),
    conversationId: String(row.conversation_id),
    workId: row.work_id === null ? null : String(row.work_id),
    effectId: row.effect_id === null ? null : String(row.effect_id),
    title: String(row.title),
    detail: String(row.detail),
    options: parseJson(row.options),
    proposal: parseNullable(row.proposal),
    state: String(row.state) as Decision["state"],
    answer: row.answer === null ? null : String(row.answer),
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  };
}

function toEffect(row: Row): Effect {
  return {
    id: String(row.id),
    workId: row.work_id === null ? null : String(row.work_id),
    conversationId: String(row.conversation_id),
    callId: String(row.call_id),
    tool: String(row.tool),
    summary: String(row.summary),
    inputDigest: String(row.input_digest),
    state: String(row.state) as Effect["state"],
    result: row.result === null ? null : String(row.result),
    createdAt: Number(row.created_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
  };
}

function toSchedule(row: Row): Schedule {
  return {
    id: String(row.id),
    ghostId: String(row.ghost_id),
    conversationId: String(row.conversation_id),
    prompt: String(row.prompt),
    spec: parseJson(row.spec),
    nextAt: row.next_at === null ? null : Number(row.next_at),
    state: String(row.state) as Schedule["state"],
    createdAt: Number(row.created_at),
  };
}

function toNotification(row: Row): Notification {
  return {
    id: String(row.id),
    kind: String(row.kind) as Notification["kind"],
    ghostId: row.ghost_id === null ? null : String(row.ghost_id),
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    workId: row.work_id === null ? null : String(row.work_id),
    decisionId: row.decision_id === null ? null : String(row.decision_id),
    title: String(row.title),
    body: String(row.body),
    createdAt: Number(row.created_at),
    readAt: row.read_at === null ? null : Number(row.read_at),
  };
}

function toDevice(row: Row): Device {
  return {
    id: String(row.id),
    name: String(row.name),
    grants: parseJson(row.grants),
    pushEnabled: row.push_token !== null,
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
  };
}

function toSpace(row: Row): Space {
  return { id: String(row.id), name: String(row.name), path: String(row.path), grants: parseJson(row.grants), createdAt: Number(row.created_at) };
}

function toAvatar(row: Row): Avatar {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    imageDigest: String(row.image_digest),
    design: parseNullable(row.design),
    createdAt: Number(row.created_at),
  };
}
