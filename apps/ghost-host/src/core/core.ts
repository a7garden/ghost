import { GHOST_TOOLS, type ArtifactRef, type Conversation, type Ghost, type Notification } from "@ghost/contract";
import type { Ledger } from "../ledger/ledger.ts";
import { Decisions } from "./decisions.ts";
import { Effects } from "./effects.ts";
import { invalid } from "./errors.ts";
import { newId } from "./ids.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import type { ArtifactStore, Engine, EngineEvents, SandboxControl, Secrets } from "./ports.ts";
import { Schedules } from "./schedules.ts";
import { Works } from "./works.ts";

export interface CoreDeps {
  ledger: Ledger;
  artifacts: ArtifactStore;
  /** Sandbox control; `stageInputs` copies a settled child's artifacts into its parent's workspace; `release` frees a settled Work's container. */
  sandbox: SandboxControl & Partial<Pick<SandboxEnvFactory, "stageInputs" | "release">>;
  secrets: Secrets;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * The host's rules. Every change is a synchronous ledger transaction followed by
 * idempotent engine calls; `reconcile` can always re-derive those calls from the
 * ledger, which is what makes restarts safe.
 */
export class Core implements EngineEvents {
  readonly ledger: Ledger;
  readonly artifacts: ArtifactStore;
  readonly sandbox: SandboxControl & Partial<Pick<SandboxEnvFactory, "stageInputs" | "release">>;
  readonly secrets: Secrets;
  readonly works: Works;
  readonly effects: Effects;
  readonly decisions: Decisions;
  readonly schedules: Schedules;
  readonly log: (message: string, detail?: unknown) => void;
  private engineRef: Engine | null = null;
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(deps: CoreDeps) {
    this.ledger = deps.ledger;
    this.artifacts = deps.artifacts;
    this.sandbox = deps.sandbox;
    this.secrets = deps.secrets;
    this.log = deps.log ?? ((message, detail) => console.error(`[core] ${message}`, detail ?? ""));
    this.works = new Works(this);
    this.effects = new Effects(this);
    this.decisions = new Decisions(this);
    this.schedules = new Schedules(this);
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
    const previous = this.lanes.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => {},
      () => {},
    );
    this.lanes.set(key, settled);
    void settled.finally(() => {
      if (this.lanes.get(key) === settled) this.lanes.delete(key);
    });
    return result;
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
    for (const ghost of this.ledger.ghosts()) if (ghost.state !== "retired") await this.openConversation(ghost.directConversationId);
    await this.decisions.recover();
    for (const work of this.ledger.worksInState("queued", "running", "waiting", "verifying")) this.works.kick(work.id);
    this.works.recover();
    this.engine.resume();
    this.schedules.start();
  }

  stop() {
    this.schedules.stop();
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

  /** Create a Ghost with its main direct conversation. New Ghosts default to the full selectable tool set. */
  createGhost(input: Pick<Ghost, "name" | "persona"> & Partial<Pick<Ghost, "model" | "look" | "isDefault" | "tools">>): Ghost {
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
      tools: input.tools ?? [...GHOST_TOOLS],
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

  /** Submit an owner message; rejects when the engine refuses it (no model, no credential). */
  sendMessage(conversationId: string, text: string, requestId: string, attachments: ArtifactRef[] = []): Promise<void> {
    const conversation = this.ledger.conversation(conversationId);
    if (conversation.kind !== "direct") throw invalid("owner messages go to direct conversations; edit a Work to steer it");
    return this.run(`conversation:${conversationId}`, () =>
      this.engine.submit(conversationId, { text, origin: "owner", requestId: `owner:${requestId}`, attachments }),
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
