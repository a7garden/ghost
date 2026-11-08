import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AttachedReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models, MutableModels } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  createRegistry,
  configure as configureAgent,
  defineExtension,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
  UserEntry,
  type Conversation as PiConversation,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type HarnessSettings,
  type EntryRecord,
  type Extension,
  type Registry,
  type LiveState,
  type SubmissionRecord,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GHOST_TOOLS, type Conversation as HostConversation, type Ghost, type Live, type LiveEvent, type Message, type ModelRef, type Settings, type Work } from "@ghost/contract";
import type { Core } from "../core/core.ts";
import { CommandError } from "../core/errors.ts";
import type { ConversationSetup, Engine, Submission, TranscriptPage } from "../core/ports.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import type { ToolSet } from "../tools/types.ts";
import { liveFrom, renderUserContent, sameLive, toMessage, type UserMeta } from "./messages.ts";
import { applyProviders, buildModels } from "./models.ts";
import { OriginsDoc, type OriginRecord } from "./origins.ts";
import { FallbackDoc, fallbackModels, fallbackReason } from "./fallback.ts";

const ctx = BACKGROUND_CONTEXT;
const SELECTABLE_TOOLS = new Set<string>(GHOST_TOOLS);

/** One host conversation and everything the engine tracks about it. */
interface ConversationState {
  hostId: string;
  piId: ConversationId;
  pi: PiConversation;
  /** Whether the agent of this conversation was configured. */
  configured: boolean;
  /** The last run state the engine reported to core. */
  busy: boolean;
  /** True from a submission until its run is seen running, so the view is not dropped in between. */
  expectRun: boolean;
  /** Owner cancellation suppresses fallback until a new input is admitted. */
  aborted: boolean;
  live: Live;
  listeners: Set<(event: LiveEvent) => void>;
  view?: AttachedReplicatedState<ConversationView>;
  stopView?: () => void;
  /** Serializes the mapping of committed entries into messages. */
  dispatch: Promise<void>;
  /** Origins of the inputs this process submitted, by request id. */
  origins: Map<string, OriginRecord>;
  /** The load of the origins document, so every caller waits for the same read. */
  originsPromise?: Promise<void>;
  /** Request ids already looked up in Pi's submissions. */
  probed: Set<string>;
  /** Origin of a message, by the entry that carries it. */
  originByEntry: Map<EntryId, OriginRecord>;
}

export interface EngineDeps {
  core: Core;
  /** Pi's SQLite file. */
  storagePath: string;
  tools: ToolSet;
  sandbox: SandboxEnvFactory;
  /** The model catalog; tests inject their own. */
  models?: Models;
  log: (message: string, detail?: unknown) => void;
  /** Optional harness policy override; production uses Pi's bounded retries. */
  harnessSettings?: HarnessSettings;
}

/** The entry a submission placed, when it has one. */
function placedEntry(record: SubmissionRecord): EntryId | undefined {
  if (!("entry" in record)) return undefined;
  const entry = record.entry;
  return typeof entry === "number" ? entry : undefined;
}

/**
 * Pi Durable, seen from core: one harness over one storage, one agent per
 * conversation, and the transcript the owner reads.
 */
class HostEngine implements Engine {
  private readonly core: Core;
  private readonly tools: ToolSet;
  private readonly log: (message: string, detail?: unknown) => void;
  private readonly harness: Harness;
  private readonly fallbackExtension: Extension;
  /** The catalog the harness uses; rebuilt in place when the settings change. */
  private readonly ownedModels: MutableModels | null;
  private readonly states = new Map<string, ConversationState>();
  private readonly byPiId = new Map<number, ConversationState>();
  /** Listeners that arrived before the conversation was opened. */
  private readonly pendingListeners = new Map<string, Set<(event: LiveEvent) => void>>();
  private readonly unsubscribeLedger: () => void;
  private readonly unsubscribeCommits: () => void;

  constructor(deps: EngineDeps, harness: Harness, ownedModels: MutableModels | null, registry: Registry) {
    this.core = deps.core;
    this.tools = deps.tools;
    this.log = deps.log;
    this.harness = harness;
    this.ownedModels = ownedModels;
    this.fallbackExtension = defineExtension({
      name: "ghost.model-fallback",
      hooks: [hook(GenerationTask, {
        // Reset before Pi admits a queued next turn, not after its request is prepared.
        onYield: async (_answer, api): Promise<undefined> => {
          const state = this.byPiId.get(api.conversationId);
          const conversation = state && this.core.ledger.findConversation(state.hostId);
          if (!state || !conversation) return;
          const ghost = this.core.ledger.ghost(conversation.ghostId);
          const work = conversation.workId ? this.core.ledger.work(conversation.workId) : null;
          const primary = this.resolveModel(this.core.ledger.settings(), conversation, ghost, work);
          await state.pi.configure({
            model: primary ? { provider: primary.provider, modelId: primary.model } : null,
            thinkingLevel: primary?.thinking ?? "off",
          }, ctx);
        },
      })],
    });
    registry.install(this.fallbackExtension);
    this.unsubscribeLedger = this.core.ledger.subscribe((event) => {
      if (event.data.type === "settings") this.rebuildModels();
    });
    try {
      this.unsubscribeCommits = this.harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (change.type === "submission") {
            const state = this.byPiId.get(change.value.conversationId);
            if (state) this.enqueue(state, () => this.noteSubmission(change.value));
            continue;
          }
          if (change.type !== "entry") continue;
          const state = this.byPiId.get(change.value.conversationId);
          if (state) this.enqueue(state, () => this.publishEntry(state, change.value));
        }
      });
    } catch (error) {
      this.unsubscribeLedger();
      throw error;
    }
  }

  // Opening

  async open(setup: ConversationSetup): Promise<void> {
    const state = await this.ensureState(setup.conversation.id);
    await this.configure(state, setup);
    // Every opened conversation is observed, so a run that is already under way is
    // reported to core and its end settles the Work.
    await this.attachView(state);
  }

  /** Apply the conversation's agent: model, thinking level, instructions and tools. */
  private async configure(state: ConversationState, setup: ConversationSetup, servingModel?: ModelRef): Promise<void> {
    const { conversation, ghost, work } = setup;
    const model = servingModel ?? this.resolveModel(this.core.ledger.settings(), conversation, ghost, work);
    const kindInstructions = this.tools.instructionsFor(conversation, ghost, work);
    const extensions = [...this.tools.extensionsFor(conversation, ghost, work), this.fallbackExtension];
    // Pi resolves extension names from its registry; filtering copied extensions would not filter the model's tools.
    const grantedTools: ToolRegistration[] = [];
    for (const extension of extensions) {
      for (const tool of extension.tools ?? []) {
        if (!SELECTABLE_TOOLS.has(tool.name) || ghost.tools.some((name) => name === tool.name)) grantedTools.push(tool);
      }
    }
    await state.pi.configure(
      {
        model: model ? { provider: model.provider, modelId: model.model } : null,
        thinkingLevel: model?.thinking ?? "off",
        extensions,
        tools: grantedTools,
        instructions: kindInstructions ? `${ghost.persona}\n\n${kindInstructions}`.trim() : ghost.persona,
      },
      ctx,
    );
    state.configured = true;
  }

  /** The conversation's model: its own, the reviewer's, the Ghost's, then the default. */
  private resolveModel(settings: Settings, conversation: HostConversation, ghost: Ghost, work: Work | null): ModelRef | null {
    let model = conversation.model;
    if (!model && conversation.kind === "review") {
      const reviewer = work?.acceptance.reviewer ?? null;
      // A named reviewer Ghost judges with its own model; only an unnamed review takes the review model.
      if (reviewer?.kind === "model") model = reviewer.model;
      else if (reviewer === null) model = settings.reviewModel;
    }
    return model ?? ghost.model ?? settings.defaultModel;
  }

  /** Fallback applies when the model came from a Ghost (or the default), never from an explicit choice. */
  private allowsFallback(settings: Settings, conversation: HostConversation, work: Work | null): boolean {
    if (conversation.model !== null) return false;
    if (conversation.kind !== "review") return true;
    const reviewer = work?.acceptance.reviewer ?? null;
    // A named reviewer Ghost judges with its own model; an unnamed review uses the review model when one is set.
    return reviewer?.kind === "ghost" || (reviewer === null && settings.reviewModel === null);
  }

  private available(model: ModelRef, settings: Settings): boolean {
    const provider = settings.providers.find((item) => item.id === model.provider);
    return !!provider && this.core.secrets.has(provider.id) &&
      this.core.catalog.modelsFor(provider, this.core.secrets.credential(provider.id)?.type).some((item) => item.id === model.model);
  }

  // Submitting

  async submit(conversationId: string, submission: Submission): Promise<void> {
    const conversation = this.core.ledger.findConversation(conversationId);
    if (!conversation) throw new CommandError("not_found", `conversation ${conversationId} does not exist`);
    const ghost = this.core.ledger.ghost(conversation.ghostId);
    const work = conversation.workId ? this.core.ledger.work(conversation.workId) : null;
    const settings = this.core.ledger.settings();
    const model = this.resolveModel(settings, conversation, ghost, work);
    if (!model) throw new CommandError("unavailable", "no model is configured for this conversation");
    const provider = settings.providers.find((item) => item.id === model.provider);
    if (!provider) throw new CommandError("unavailable", `provider ${model.provider} is not configured`);
    if (!this.core.catalog.modelsFor(provider, this.core.secrets.credential(provider.id)?.type).some((info) => info.id === model.model)) {
      throw new CommandError("unavailable", `provider ${provider.id} has no model ${model.model}`);
    }
    const state = await this.ensureState(conversationId);
    // A duplicate admission must not reset an in-flight fallback or start another run.
    const existing = await state.pi.commit((tx) => tx.submissionByRequest(state.piId, submission.requestId), ctx);
    if (existing) return;
    state.aborted = false;
    let serving = model;
    if (!this.core.secrets.has(provider.id)) {
      const next = this.allowsFallback(settings, conversation, work)
        ? fallbackModels(ghost, model).find((candidate) => this.available(candidate, settings))
        : undefined;
      if (!next) throw new CommandError("unavailable", `provider ${provider.id} has no credential`);
      this.logFallback(state, model, next, `provider ${provider.id} has no credential`);
      serving = next;
    }
    // A new turn always starts at the primary, not the previous turn's serving model.
    if (!state.busy || !state.configured) await this.configure(state, { conversation, ghost, work }, serving);
    const meta: OriginRecord = { origin: submission.origin, attachments: submission.attachments ?? [] };
    const content = await renderUserContent(submission.text, meta.attachments, submission.origin === "owner" ? this.core.artifacts : undefined);
    await this.recordOrigin(state, submission.requestId, meta);
    // The run starts a commit after the admission; the view stays attached until that
    // run settles, so core hears busy and idle with or without a watcher.
    state.expectRun = true;
    await this.attachView(state);
    const submitted = await state.pi.submit(
      {
        type: "input",
        content,
        requestId: submission.requestId,
        whenBusy: submission.steer ? "steer" : "followUp",
      },
      ctx,
    );
    // A repeated request id returns the old submission; if it has already settled, no run follows.
    const record = await submitted.status(ctx);
    if (record.status === "done" || record.status === "unanswered") state.expectRun = false;
  }

  async abort(conversationId: string): Promise<void> {
    const state = this.states.get(conversationId);
    if (!state) return;
    state.aborted = true;
    state.expectRun = false;
    // Pi may leave the last retryable error as the tail when aborted in backoff.
    // Persist its suppression before stopping, so recovery cannot continue it.
    try {
      await state.pi.commit(async (tx) => {
        const tail = (await tx.scanEntries({ conversationId: state.piId }, 1)).items[0];
        const fallback = await tx.doc(FallbackDoc, state.piId);
        fallback.lastError = Math.max(fallback.lastError, tail?.id ?? 0);
      }, ctx);
    } finally {
      await state.pi.abort(ctx);
    }
  }

  // Reading

  async page(conversationId: string, before: string | null, limit: number): Promise<TranscriptPage> {
    const state = await this.stateFor(conversationId);
    if (!state) return { messages: [], before: null, live: null };
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : 50;
    const cursor = before === null ? Number.NaN : Number(before);
    let upper = Number.isFinite(cursor) ? ((cursor - 1) as EntryId) : undefined;
    const messages: Message[] = [];
    /** The oldest entry the page looked at; the next page starts below it. */
    let oldest: EntryId | undefined;
    let more = false;
    // Entries that carry no message, such as the positional system entries, do not
    // take a place in the page: the scan continues until the page is full.
    while (messages.length < size) {
      const scan = await state.pi.entries(upper === undefined ? {} : { maxEntryId: upper }, size + 1, undefined, ctx);
      if (scan.items.length === 0) break;
      let full = false;
      for (const entry of scan.items) {
        oldest = entry.id;
        const message = await this.toMessage(state, entry);
        if (!message) continue;
        messages.push(message);
        if (messages.length === size) {
          full = true;
          break;
        }
      }
      if (full) break;
      if (scan.items.length < size + 1) break;
      upper = ((oldest as number) - 1) as EntryId;
    }
    if (oldest !== undefined) {
      const older = await state.pi.entries({ maxEntryId: ((oldest as number) - 1) as EntryId }, 1, undefined, ctx);
      more = older.items.length > 0;
    }
    messages.reverse();
    return {
      messages,
      before: more && oldest !== undefined ? String(oldest) : null,
      live: liveFrom(await this.liveState(state), conversationId),
    };
  }

  watch(conversationId: string, listener: (event: LiveEvent) => void): () => void {
    const state = this.states.get(conversationId);
    if (state) {
      state.listeners.add(listener);
      void this.attachView(state).catch((error) => this.log("engine: a conversation could not be watched", error));
      return () => {
        state.listeners.delete(listener);
        this.detachView(state);
      };
    }
    const pending = this.pendingListeners.get(conversationId) ?? new Set<(event: LiveEvent) => void>();
    pending.add(listener);
    this.pendingListeners.set(conversationId, pending);
    return () => {
      pending.delete(listener);
      if (pending.size === 0) this.pendingListeners.delete(conversationId);
    };
  }

  status(): { ready: boolean; detail: string } {
    const settings = this.core.ledger.settings();
    const model = settings.defaultModel;
    if (!model) return { ready: false, detail: "no default model is configured" };
    const provider = settings.providers.find((item) => item.id === model.provider);
    if (!provider) return { ready: false, detail: `provider ${model.provider} is not configured` };
    if (this.core.secrets.has(provider.id)) {
      if (!this.available(model, settings)) return { ready: false, detail: `provider ${provider.id} has no model ${model.model}` };
      return { ready: true, detail: `provider ${provider.id} is ready` };
    }
    return { ready: false, detail: `provider ${provider.id} has no credential` };
  }

  // History and recovery

  async appendHistory(conversationId: string, messages: { role: "user" | "assistant"; text: string; at: number }[]): Promise<void> {
    const state = await this.ensureState(conversationId);
    await state.pi.commit(async (tx) => {
      for (const message of messages) {
        if (message.role === "user") {
          await tx.appendEntry(UserEntry, state.piId, {
            model: [{ role: "user", content: message.text, timestamp: message.at }],
          });
        } else {
          await tx.appendEntry(AssistantEntry, state.piId, {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: message.text }],
                api: "openai-completions",
                provider: "imported",
                model: "imported",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: message.at,
              },
            ],
          });
        }
      }
    }, ctx);
  }

  resume(): void {
    this.harness.resume();
    void this.resumeLiveRuns();
  }

  /** Report the runs that were interrupted by a restart, and settle what is over. */
  private async resumeLiveRuns(): Promise<void> {
    try {
      const hosts = new Set<string>();
      for (const conversation of this.core.ledger.conversations()) if (conversation.busy) hosts.add(conversation.id);
      const inspection = await this.harness.inspect(ctx);
      for (const task of inspection.tasks) {
        const host = this.core.ledger.conversationByPiId(String(task.record.conversationId));
        if (host) hosts.add(host.id);
      }
      for (const submission of inspection.submissions) {
        const host = this.core.ledger.conversationByPiId(String(submission.conversationId));
        if (host) hosts.add(host.id);
      }
      for (const hostId of hosts) {
        const state = await this.stateFor(hostId);
        if (!state) continue;
        const running = liveFrom(await this.liveState(state), hostId).running;
        state.expectRun = running;
        await this.attachView(state);
        if (running) this.setBusy(state, true); // The idle observer first checks for an exhausted-model fallback.
      }
    } catch (error) {
      this.log("engine: could not resume the interrupted runs", error);
    }
  }

  async close(): Promise<void> {
    this.unsubscribeLedger();
    this.unsubscribeCommits();
    for (const state of this.states.values()) {
      state.stopView?.();
      state.view?.dispose();
      state.view = undefined;
      state.stopView = undefined;
    }
    this.states.clear();
    this.byPiId.clear();
    this.pendingListeners.clear();
    await this.harness.close(ctx);
  }

  // Conversations

  /** The state of a conversation, creating its Pi conversation when it has none. */
  private async ensureState(hostId: string): Promise<ConversationState> {
    const existing = this.states.get(hostId);
    if (existing) return existing;
    const piId = await this.ensurePiConversation(hostId);
    const pi = await this.harness.conversation(piId, ctx);
    if (!pi) throw new CommandError("unavailable", `conversation ${hostId} has no Pi conversation`);
    const conversation = this.core.ledger.findConversation(hostId);
    const state: ConversationState = {
      hostId,
      piId,
      pi,
      configured: false,
      busy: conversation?.busy ?? false,
      expectRun: false,
      aborted: false,
      live: { conversationId: hostId, running: false, partial: null, tools: [] },
      listeners: new Set(),
      dispatch: Promise.resolve(),
      origins: new Map(),
      probed: new Set(),
      originByEntry: new Map(),
    };
    this.states.set(hostId, state);
    this.byPiId.set(piId, state);
    const pending = this.pendingListeners.get(hostId);
    if (pending) {
      for (const listener of pending) state.listeners.add(listener);
      this.pendingListeners.delete(hostId);
    }
    return state;
  }

  /** The state of a conversation that Pi already knows, if any. */
  private async stateFor(hostId: string): Promise<ConversationState | null> {
    const existing = this.states.get(hostId);
    if (existing) return existing;
    if (this.core.ledger.piConversationId(hostId) === null) return null;
    return this.ensureState(hostId);
  }

  /** The Pi conversation of a host conversation, created on first use. */
  private async ensurePiConversation(hostId: string): Promise<ConversationId> {
    const mapped = this.core.ledger.piConversationId(hostId);
    if (mapped !== null) return Number(mapped) as ConversationId;
    const created = await this.harness.createConversation({ ownership: { kind: "ownerless" } }, ctx);
    this.core.ledger.tx(() => this.core.ledger.setPiConversationId(hostId, String(created.id)));
    return created.id;
  }

  // Observation

  /** Watch one conversation's committed state. Cheap: one view per conversation. */
  private async attachView(state: ConversationState): Promise<void> {
    if (state.view) return;
    const view = await state.pi.viewState(ctx);
    state.view = view;
    state.stopView = view.subscribe((value) => this.onView(state, value));
    this.onView(state, view.value);
  }

  /** Drop the view of a conversation that is idle and nobody watches. */
  private detachView(state: ConversationState): void {
    if (state.listeners.size > 0 || state.busy) return;
    state.stopView?.();
    state.stopView = undefined;
    state.view?.dispose();
    state.view = undefined;
  }

  private onView(state: ConversationState, value: ConversationView): void {
    const document = value.docs["pi.live"];
    // Pi stores the live document as the JSON of its own `LiveState`.
    const live = liveFrom(document === undefined ? undefined : (document as unknown as LiveState), state.hostId);
    if (live.running) state.expectRun = false;
    if (live.running) this.setBusy(state, true);
    if (!live.running) {
      this.enqueue(state, async () => {
        try {
          if (await this.continueFallback(state)) return;
        } catch (error) {
          this.log("engine: model fallback failed", error);
        }
        const current = liveFrom(await this.liveState(state), state.hostId);
        if (current.running) return;
        this.setBusy(state, false);
        if (!sameLive(state.live, current)) {
          state.live = current;
          this.emit(state, { type: "live", live: current });
        }
        if (!state.expectRun && state.listeners.size === 0) this.detachView(state);
      });
      return;
    }
    if (!sameLive(state.live, live)) {
      state.live = live;
      this.emit(state, { type: "live", live });
    }
  }

  private logFallback(state: ConversationState, from: ModelRef, to: ModelRef, reason: string): void {
    this.log(`fallback: ${state.hostId} ${from.provider}/${from.model} -> ${to.provider}/${to.model} (${reason.replace(/[\r\n]+/g, " ").slice(0, 300)})`);
  }

  /** Continue committed context, not input: no second user entry or request-id admission. */
  private async continueFallback(state: ConversationState): Promise<boolean> {
    // Merely opening an idle historical conversation must not retry its old error.
    if (!state.busy || state.aborted) return false;
    const conversation = this.core.ledger.findConversation(state.hostId);
    if (!conversation) return false;
    const settings = this.core.ledger.settings();
    const ghost = this.core.ledger.ghost(conversation.ghostId);
    const work = conversation.workId ? this.core.ledger.work(conversation.workId) : null;
    if (!this.allowsFallback(settings, conversation, work)) return false;
    const primary = this.resolveModel(settings, conversation, ghost, work);
    if (!primary || ghost.fallbacks.length === 0) return false;
    const switched = await state.pi.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, state.piId);
      if (state.aborted || live.run) return null; // Pi's own retry or another input is still running.
      const entries = await tx.scanEntries({ conversationId: state.piId }, 10);
      const tail = entries.items.find((entry) => entry.kind === "pi.assistant" || entry.kind === "pi.user");
      if (!tail || tail.kind !== "pi.assistant") return null;
      const message = tail.model?.find((item): item is AssistantMessage => item.role === "assistant");
      const reason = message ? fallbackReason(message) : null;
      if (!message || reason === null) return null;
      const fallback = await tx.doc(FallbackDoc, state.piId);
      if (fallback.lastError >= tail.id) return null;
      const candidates = fallbackModels(ghost, primary);
      const failedIndex = candidates.findIndex((candidate) => candidate.provider === message.provider && candidate.model === message.model);
      const next = candidates.slice(failedIndex + 1).find((candidate) => this.available(candidate, settings));
      fallback.lastError = tail.id;
      if (!next) return null;
      await configureAgent(tx, state.piId, {
        model: { provider: next.provider, modelId: next.model },
        thinkingLevel: next.thinking ?? "off",
      });
      // Pi exposes no retry API. Re-arm its exported generation task over the existing
      // context, atomically with the model and handled-error marker. No submission is
      // replayed; completed tool tasks/results remain in context, including unsafe effects.
      live.run = {
        taskId: await tx.createTask(GenerationTask, {}, { conversationId: state.piId, ownership: { kind: "conversation" } }),
        inputs: [],
      };
      return { from: { provider: message.provider, model: message.model }, next, reason };
    }, ctx);
    if (!switched) return false;
    this.logFallback(state, switched.from, switched.next, switched.reason);
    this.setBusy(state, true);
    return true;
  }

  /** Report a run's start or end to core, once per transition. */
  private setBusy(state: ConversationState, busy: boolean): void {
    if (state.busy === busy) return;
    state.busy = busy;
    this.core.activity(state.hostId, busy, Date.now());
  }

  private emit(state: ConversationState, event: LiveEvent): void {
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log("engine: a transcript listener failed", error);
      }
    }
  }

  /** Run a task in the conversation's order, so messages arrive in the order they were committed. */
  private enqueue(state: ConversationState, task: () => Promise<void>): void {
    state.dispatch = state.dispatch.then(async () => {
      try {
        await task();
      } catch (error) {
        this.log("engine: a committed change could not be published", error);
      }
    });
  }

  private async publishEntry(state: ConversationState, entry: EntryRecord): Promise<void> {
    const message = await this.toMessage(state, entry);
    if (message) this.emit(state, { type: "message", message });
  }

  /** Learn which entry a submission placed, so its message knows its origin. */
  private async noteSubmission(record: SubmissionRecord): Promise<void> {
    const state = this.byPiId.get(record.conversationId);
    if (!state) return;
    const requestId = record.requestId;
    if (!requestId) return;
    let meta = state.origins.get(requestId);
    if (!meta) {
      await this.loadOrigins(state);
      meta = state.origins.get(requestId);
    }
    if (!meta) return;
    const entry = placedEntry(record);
    if (entry === undefined) return;
    state.originByEntry.set(entry, meta);
  }

  // Origins

  /** Record the origin of an input before it is admitted, so it survives a crash. */
  private async recordOrigin(state: ConversationState, requestId: string, meta: OriginRecord): Promise<void> {
    state.origins.set(requestId, meta);
    await this.harness.commit(async (tx) => {
      const doc = await tx.doc(OriginsDoc, state.piId);
      doc.byRequest[requestId] = meta;
    }, ctx);
  }

  private async loadOrigins(state: ConversationState): Promise<void> {
    state.originsPromise ??= (async () => {
      const doc = await this.harness.snapshot(OriginsDoc, state.piId, ctx);
      for (const [requestId, meta] of Object.entries(doc?.byRequest ?? {})) state.origins.set(requestId, meta);
    })();
    await state.originsPromise;
  }

  /**
   * The origin of a user message. Pi keeps the request id on the submission, not on
   * the entry, so the entry is matched to its submission and the origin is read from
   * the document the engine wrote before admitting the input.
   */
  private async resolveUserMeta(state: ConversationState, entry: EntryId): Promise<UserMeta | null> {
    const cached = state.originByEntry.get(entry);
    if (cached) return cached;
    await this.loadOrigins(state);
    for (const [requestId, meta] of state.origins) {
      if (state.probed.has(requestId)) continue;
      state.probed.add(requestId);
      const record = await this.harness.commit((tx) => tx.submissionByRequest(state.piId, requestId), ctx);
      const placed = record ? placedEntry(record) : undefined;
      if (placed !== undefined) state.originByEntry.set(placed, meta);
    }
    const found = state.originByEntry.get(entry);
    return found ?? null;
  }

  private async toMessage(state: ConversationState, entry: EntryRecord): Promise<Message | null> {
    if (entry.kind !== "pi.user") return toMessage(entry, state.hostId, null);
    return toMessage(entry, state.hostId, await this.resolveUserMeta(state, entry.id));
  }

  private async liveState(state: ConversationState): Promise<LiveState | undefined> {
    return (await this.harness.snapshot(LiveDoc, state.piId, ctx)) ?? undefined;
  }

  // Models

  private rebuildModels(): void {
    if (!this.ownedModels) return;
    this.core.codexCatalog.sync();
    applyProviders(this.ownedModels, this.core.ledger.settings(), this.core.secrets, this.core.catalog);
  }
}

/** Startup could not prove that Pi's live resources were closed; retain root ownership. */
export class EngineStartupCleanupError extends AggregateError {}

/**
 * Open the engine over one Pi storage. The harness owns every conversation; core
 * drives it through the `Engine` port.
 */
export async function createEngine(deps: EngineDeps): Promise<Engine> {
  const { core, sandbox, tools, log } = deps;
  mkdirSync(dirname(deps.storagePath), { recursive: true });
  core.codexCatalog.sync();
  const ownedModels = deps.models === undefined ? buildModels(core.ledger.settings(), core.secrets, core.catalog) : null;
  const models = deps.models ?? ownedModels;
  if (!models) throw new Error("the engine needs a model catalog");
  const registry = createRegistry();
  for (const extension of tools.all()) registry.install(extension);
  const storage = await openNodeSqliteStorage(deps.storagePath);
  let harness: Harness | null = null;
  let opening = true;
  const startupReports: unknown[] = [];
  try {
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: deps.harnessSettings,
        // Harness.open reports an internal close failure here if its own startup
        // fails. Do not mistake its original rejection for successful cleanup.
        onReport: (error) => {
          if (opening) startupReports.push(error);
          else log("engine: harness report", error);
        },
        env: async ({ conversationId }) => {
          const host = core.ledger.conversationByPiId(String(conversationId));
          if (!host || host.kind !== "work" || !host.workId) return undefined;
          const work = core.ledger.workByConversation(host.id);
          return work ? sandbox.envFor(work) : undefined;
        },
      },
      ctx,
    );
    opening = false;
    return new HostEngine(deps, harness, ownedModels, registry);
  } catch (error) {
    opening = false;
    const cleanupErrors = harness ? [] : startupReports;
    try {
      if (harness) await harness.close(ctx);
      else await storage.close(ctx);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new EngineStartupCleanupError([error, ...cleanupErrors], "Pi startup cleanup failed; root remains owned until process exit");
    }
    throw error;
  }
}
