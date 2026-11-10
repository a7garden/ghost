import { DEFAULT_GHOST_TOOLS, type ArtifactRef, type Conversation, type Ghost, type Notification } from "@ghost/contract";
import type { Ledger } from "../ledger/ledger.ts";
import { Decisions } from "./decisions.ts";
import { Effects } from "./effects.ts";
import { conflict, invalid } from "./errors.ts";
import { newId } from "./ids.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import type { ArtifactStore, Engine, EngineEvents, SandboxControl, Secrets } from "./ports.ts";
import { Schedules } from "./schedules.ts";
import { isTerminal, Works } from "./works.ts";
import { ProviderCatalog } from "../integrations/provider-catalog.ts";
import { CodexCatalog } from "../integrations/codex-catalog.ts";
import { Activities } from "./activities.ts";
import type { ActivitySourcePort } from "../integrations/activity-sources.ts";
import { Autonomy, type AutonomyDeps } from "./autonomy.ts";
import { DutyClock } from "./duty.ts";
import type { SourceStore } from "../stores/sources.ts";

export interface CoreDeps {
  ledger: Ledger;
  artifacts: ArtifactStore;
  /** Sandbox control; `stageInputs` copies a settled child's artifacts into its parent's workspace; `release` frees a settled Work's container. */
  sandbox: SandboxControl & Partial<Pick<SandboxEnvFactory, "stageInputs" | "release" | "workspacePath">>;
  secrets: Secrets;
  catalog?: ProviderCatalog;
  codexCachePath?: string;
  activitySources?: ActivitySourcePort;
  log?: (message: string, detail?: unknown) => void;
  /** Git readers for the self-directed drive; tests substitute them. */
  autonomy?: AutonomyDeps;
  /** Snapshots of pages read for Ghosts, so citations can be checked; null leaves citation checks failing closed. */
  sources?: SourceStore | null;
}

/**
 * The host's rules. Every change is a synchronous ledger transaction followed by
 * idempotent engine calls; `reconcile` can always re-derive those calls from the
 * ledger, which is what makes restarts safe.
 */
export class Core implements EngineEvents {
  readonly ledger: Ledger;
  readonly artifacts: ArtifactStore;
  readonly sandbox: SandboxControl & Partial<Pick<SandboxEnvFactory, "stageInputs" | "release" | "workspacePath">>;
  readonly secrets: Secrets;
  readonly catalog: ProviderCatalog;
  readonly codexCatalog: CodexCatalog;
  readonly works: Works;
  readonly effects: Effects;
  readonly decisions: Decisions;
  readonly schedules: Schedules;
  readonly activities: Activities;
  readonly autonomy: Autonomy;
  /** 출근 · 퇴근. 퇴근 중에는 Ghost 가 스스로 새 일을 시작하지 않는다. */
  readonly duty: DutyClock;
  readonly activitySources: ActivitySourcePort | null;
  readonly sources: SourceStore | null;
  readonly log: (message: string, detail?: unknown) => void;
  private engineRef: Engine | null = null;
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly unsubscribeLedgerEvents: () => void;

  constructor(deps: CoreDeps) {
    this.ledger = deps.ledger;
    this.artifacts = deps.artifacts;
    this.sandbox = deps.sandbox;
    this.secrets = deps.secrets;
    this.catalog = deps.catalog ?? new ProviderCatalog();
    this.codexCatalog = new CodexCatalog({
      catalog: this.catalog,
      secrets: this.secrets,
      providers: () => this.ledger.settings().providers,
      cachePath: deps.codexCachePath,
    });
    this.log = deps.log ?? ((message, detail) => console.error(`[core] ${message}`, detail ?? ""));
    this.works = new Works(this);
    this.effects = new Effects(this);
    this.decisions = new Decisions(this);
    this.schedules = new Schedules(this);
    this.activitySources = deps.activitySources ?? null;
    this.sources = deps.sources ?? null;
    this.activities = new Activities(this, this.activitySources);
    this.autonomy = new Autonomy(this, deps.autonomy);
    this.duty = new DutyClock(this);
    // 출근하면 퇴근 중에 때가 된 예약 · 활동 규칙 · 자율 깨우기를 바로 돌린다. 퇴근하면 예약 타이머를 다시 맞춘다.
    this.duty.onChange((onDuty) => {
      this.schedules.refresh();
      if (onDuty) void this.autonomy.tick().catch((error) => this.log("autonomy tick after duty change failed", error));
    });
    const grants = new Map(this.ledger.ghosts().map((ghost) => [ghost.id, ghost]));
    this.unsubscribeLedgerEvents = this.ledger.subscribe((event) => {
      if (event.data.type === "work") {
        const work = event.data.work;
        if (work.execution?.kind === "host" && isTerminal(work) && this.sandbox.release) {
          // Start cancellation now, not behind a Work lane that may itself be awaiting PC I/O.
          const released = this.sandbox.release(work);
          void this.lane(`execution:${work.id}`, () => released);
        }
        return;
      }
      if (event.data.type !== "ghost") return;
      const ghost = event.data.ghost;
      const previous = grants.get(ghost.id);
      grants.set(ghost.id, ghost);
      if (previous) {
        const revokedPC = previous.hostExecution && !ghost.hostExecution;
        const removedTools = previous.tools.filter((tool) => !ghost.tools.includes(tool));
        for (const work of this.ledger.worksInState("queued", "running", "waiting", "verifying", "blocked")) {
          if (work.ghostId !== ghost.id) continue;
          const revokedTool = removedTools.some((tool) => !work.toolScope || work.toolScope.includes(tool));
          const revokedExecution = revokedPC && work.execution?.kind === "host";
          if (revokedExecution || revokedTool || ghost.deletedAt !== null) {
            this.works.cancel(work.id, revokedExecution ? "owner revoked direct PC execution" : "owner revoked Work tool authority");
          }
        }
      }
      // Keep delegation rosters true after every Ghost write, including creates and retirement.
      this.refreshRosters();
    });
  }

  get engine(): Engine {
    if (!this.engineRef) throw new Error("engine not attached");
    return this.engineRef;
  }

  attach(engine: Engine) {
    this.engineRef = engine;
  }

  /**
   * Run async follow-up work for one key at a time, in order, and return its outcome to
   * the caller. The lane itself survives a failure.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.ledger.afterCommit(() => {
      const previous = this.lanes.get(key) ?? Promise.resolve();
      const result = previous.then(task);
      const settled = result.then(
        () => {},
        () => {},
      );
      this.lanes.set(key, settled);
      void result.then(resolve, reject);
      void settled.finally(() => {
        if (this.lanes.get(key) === settled) this.lanes.delete(key);
      });
    }, () => reject(new Error("ledger transaction rolled back before engine work")));
    return promise;
  }

  /** Fire-and-forget `run`: failures are logged and the next reconcile pass retries from ledger state. */
  lane(key: string, task: () => Promise<void>): Promise<void> {
    return this.run(key, task).catch((error) => this.log(`lane ${key} failed`, error));
  }

  /** Wait until every queued lane task has finished. For tests and shutdown. */
  async idle() {
    while (this.lanes.size > 0) await Promise.all([...this.lanes.values()]);
  }

  /**
   * Startup: settle interrupted effects, finish interrupted decision follow-ups and reports,
   * then re-derive engine actions for every live object.
   */
  async start() {
    this.effects.recoverInterrupted();
    this.effects.returnSelfCheckable();
    for (const ghost of this.ledger.ghosts()) if (ghost.state !== "retired") await this.openConversation(ghost.directConversationId);
    await this.decisions.recover();
    for (const work of this.ledger.worksInState("queued", "running", "waiting", "verifying")) this.works.kick(work.id);
    this.works.recover();
    this.engine.resume();
    this.schedules.start();
    this.decisions.start();
    this.duty.start();
  }

  stop() {
    this.unsubscribeLedgerEvents();
    this.duty.stop();
    this.schedules.stop();
    this.activities.stop();
    this.decisions.stop();
  }

  // Engine events

  activity(conversationId: string, busy: boolean, at: number) {
    const conversation = this.ledger.findConversation(conversationId);
    if (!conversation) return;
    this.ledger.tx(() => this.ledger.putConversation({ ...conversation, busy, lastActivityAt: at }));
    if (busy) return;
    if (conversation.kind === "work" && conversation.workId) this.works.onIdle(conversation.workId);
    if (conversation.kind === "review" && conversation.workId) this.works.onReviewIdle(conversation.workId);
  }

  // Ghosts and conversations

  /** Create a Ghost with its main direct conversation. New Ghosts default to every selectable tool except host tools. */
  createGhost(input: Pick<Ghost, "name" | "persona"> & Partial<Pick<Ghost, "model" | "look" | "isDefault" | "tools" | "fallbacks" | "skills" | "hostExecution">>): Ghost {
    const now = Date.now();
    const id = newId();
    const conversationId = newId();
    const ghost: Ghost = {
      id,
      name: input.name,
      persona: input.persona,
      look: input.look ?? { avatarId: null },
      model: input.model ?? null,
      isDefault: input.isDefault ?? this.ledger.defaultGhost() === null,
      state: "active",
      tools: input.tools ?? [...DEFAULT_GHOST_TOOLS],
      fallbacks: input.fallbacks ?? [],
      skills: input.skills ?? [],
      hostExecution: input.hostExecution ?? false,
      deletedAt: null,
      directConversationId: conversationId,
      createdAt: now,
      updatedAt: now,
    };
    this.ledger.tx(() => {
      this.ledger.putGhost(ghost);
      this.ledger.putConversation(this.newConversation(id, "direct", null, ghost.name, conversationId, now));
    });
    void this.lane(`conversation:${conversationId}`, () => this.openConversation(conversationId));
    return ghost;
  }

  createDirectConversation(ghostId: string, title: string | undefined): Conversation {
    const ghost = this.ledger.ghost(ghostId);
    const conversation = this.newConversation(ghost.id, "direct", null, title ?? ghost.name, newId(), Date.now());
    this.ledger.tx(() => this.ledger.putConversation(conversation));
    void this.lane(`conversation:${conversation.id}`, () => this.openConversation(conversation.id));
    return conversation;
  }

  newConversation(ghostId: string, kind: Conversation["kind"], workId: string | null, title: string, id = newId(), now = Date.now()): Conversation {
    return { id, ghostId, kind, workId, title, model: null, busy: false, createdAt: now, lastActivityAt: now };
  }

  /** (Re)apply a conversation's agent from current ledger rows. */
  async openConversation(conversationId: string) {
    const conversation = this.ledger.conversation(conversationId);
    const ghost = this.ledger.ghost(conversation.ghostId);
    const work = conversation.workId ? this.ledger.work(conversation.workId) : null;
    await this.engine.open({ conversation, ghost, work });
  }

  /** Re-open every live conversation of a Ghost after its persona, model or grants changed. */
  refreshGhost(ghostId: string) {
    for (const conversation of this.ledger.conversations({ ghostId })) {
      if (conversation.kind !== "direct" && conversation.workId) {
        const work = this.ledger.work(conversation.workId);
        if (["done", "failed", "cancelled"].includes(work.state)) continue;
      }
      void this.lane(`conversation:${conversation.id}`, () => this.openConversation(conversation.id));
    }
  }

  /**
   * Re-open the idle live work conversations of Ghosts that hold `delegate`, so the delegation roster in
   * their instructions reflects the Ghost that just changed. A running conversation is left alone: re-opening
   * mid-run would reset a fallback model and the prompt cache, and its next turn reconfigures anyway.
   */
  private refreshRosters() {
    const holds = new Map<string, boolean>();
    for (const work of this.ledger.worksInState("queued", "running", "waiting", "verifying")) {
      if (!work.conversationId) continue;
      let delegates = holds.get(work.ghostId);
      if (delegates === undefined) holds.set(work.ghostId, (delegates = this.ledger.ghost(work.ghostId).tools.includes("delegate")));
      if (!delegates) continue;
      const conversation = this.ledger.findConversation(work.conversationId);
      if (!conversation || conversation.busy) continue;
      void this.lane(`conversation:${conversation.id}`, () => this.openConversation(conversation.id));
    }
  }

  /** Submit an owner message; rejects when the engine refuses it (no model, no credential). */
  sendMessage(conversationId: string, text: string, requestId: string, attachments: ArtifactRef[] = [], spaceIds: string[] = []): Promise<void> {
    const conversation = this.ledger.conversation(conversationId);
    if (conversation.kind !== "direct") throw invalid("owner messages go to direct conversations; edit a Work to steer it");
    const ghost = this.ledger.ghost(conversation.ghostId);
    if (ghost.deletedAt !== null) throw conflict(`${ghost.name} was deleted`);
    return this.run(`conversation:${conversationId}`, () =>
      this.engine.submit(conversationId, { text, origin: "owner", requestId: `owner:${requestId}`, attachments, spaceIds }),
    );
  }

  // Notifications

  /** Insert a notification once; `id` is deterministic so repeats are ignored. */
  notify(notification: Omit<Notification, "createdAt" | "readAt">) {
    try {
      this.ledger.notification(notification.id);
      return;
    } catch {
      this.ledger.putNotification({ ...notification, createdAt: Date.now(), readAt: null });
    }
  }
}
