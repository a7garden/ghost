import { QUIET_REPLY, type NextMessageSuggestions } from "@ghost/contract";
import type { HerdrPort } from "../integrations/ports.ts";
import type { Core } from "./core.ts";
import { notFound } from "./errors.ts";
import type { Engine } from "./ports.ts";

const MAX_CACHED = 64;
const CACHE_MS = 10 * 60_000;
const DEADLINE_MS = 15_000;
const EMPTY: NextMessageSuggestions = { suggestions: [] };
type Messages = Parameters<NonNullable<Engine["suggest"]>>[0]["messages"];
type Flight = { controller: AbortController; waiters: Set<(result: NextMessageSuggestions) => void> };

/** A read scoped to the latest completed turn, with no conversation, effect, or receipt writes. */
export class Suggestions {
  private readonly cache = new Map<string, { result: NextMessageSuggestions; expires: number }>();
  private readonly flights = new Map<string, Flight>();
  private closing = false;

  constructor(private readonly core: Core, private readonly herdr: HerdrPort | null) {}

  private enabled(): boolean {
    const settings = this.core.ledger.settings();
    return !this.closing && settings.nextMessageSuggestions !== false && Boolean(settings.suggestionModel ?? settings.defaultModel) && this.core.engine.suggest !== undefined;
  }

  async coding(id: string, signal: AbortSignal): Promise<NextMessageSuggestions> {
    const herdr = this.herdr;
    if (!herdr || signal.aborted || !this.enabled()) return EMPTY;
    const session = herdr.session;
    const view = await herdr.overview(session);
    if (!view.available || view.note !== null || signal.aborted) return EMPTY;
    const pane = view.workspaces.flatMap(workspace => workspace.tabs.flatMap(tab => tab.panes)).find(pane => pane.id === id);
    if (!pane) throw notFound(`herdr pane ${id}`);
    if ((pane.agent !== "omp" && pane.agent !== "claude") || pane.status === "working" || pane.status === "blocked") return EMPTY;
    const chat = await herdr.chat(id, null, session);
    if (!chat.source) return EMPTY;
    const messages = chat.items.filter(item => item.kind === "user" || item.kind === "agent");
    const anchor = messages.at(-1);
    if (anchor?.kind !== "agent" || !anchor.text.trim()) return EMPTY;
    return this.forAnchor(JSON.stringify(["herdr", session, id, pane.terminalId, pane.agentSessionId, anchor.id]), messages.slice(-16).map(({ kind, text }) => ({ role: kind === "user" ? "user" : "assistant", text })), signal);
  }

  async direct(id: string, signal: AbortSignal): Promise<NextMessageSuggestions> {
    const conversation = this.core.ledger.conversation(id);
    if (conversation.kind !== "direct" || conversation.busy || signal.aborted || !this.enabled()) return EMPTY;
    const page = await this.core.engine.page(id, null, 32);
    if (page.live?.running || this.core.ledger.findConversation(id)?.busy !== false) return EMPTY;
    const anchor = page.messages.at(-1);
    if (anchor?.role !== "assistant" || !anchor.text.trim() || anchor.text.trim() === QUIET_REPLY) return EMPTY;
    const messages = page.messages.flatMap(({ role, text, origin }) => role === "assistant" || (role === "user" && (origin === "owner" || origin === null)) ? [{ role, text }] : []);
    return this.forAnchor(JSON.stringify(["direct", id, anchor.id]), messages, signal);
  }

  private async forAnchor(key: string, messages: Messages, signal: AbortSignal): Promise<NextMessageSuggestions> {
    if (signal.aborted || !this.enabled()) return EMPTY;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expires > Date.now()) {
        this.cache.set(key, cached);
        return cached.result;
      }
    }
    const flight = this.flights.get(key) ?? this.start(key, messages);
    const { promise, resolve } = Promise.withResolvers<NextMessageSuggestions>();
    const finish = (result: NextMessageSuggestions) => {
      signal.removeEventListener("abort", disconnect);
      flight.waiters.delete(finish);
      resolve(result);
    };
    const disconnect = () => {
      finish(EMPTY);
      if (flight.waiters.size === 0) flight.controller.abort();
    };
    flight.waiters.add(finish);
    signal.addEventListener("abort", disconnect, { once: true });
    return promise;
  }

  private start(key: string, messages: Messages): Flight {
    const flight: Flight = { controller: new AbortController(), waiters: new Set() };
    const { signal } = flight.controller;
    this.flights.set(key, flight);
    const finish = (result: NextMessageSuggestions, remember = true) => {
      clearTimeout(timeout);
      this.flights.delete(key);
      // An answered or failed call was billed; never ask again for the anchor. An abandoned one (everyone left, deadline) is not remembered, so coming back asks again.
      if (remember) {
        this.cache.set(key, { result, expires: Date.now() + CACHE_MS });
        if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
      }
      for (const waiter of flight.waiters) waiter(result);
    };
    const timeout = setTimeout(() => {
      this.core.log("next-message suggestions timed out");
      flight.controller.abort();
    }, DEADLINE_MS);
    signal.addEventListener("abort", () => finish(EMPTY, false), { once: true });
    void Promise.resolve().then(async () => {
      if (signal.aborted) return;
      const suggestions = await this.core.engine.suggest!({ messages, signal });
      if (!signal.aborted) finish({ suggestions });
    }).catch(error => {
      if (signal.aborted) return;
      this.core.log("next-message suggestions failed", error);
      finish(EMPTY);
    });
    return flight;
  }

  close(): void {
    this.closing = true;
    for (const flight of this.flights.values()) flight.controller.abort();
    this.cache.clear();
  }
}
