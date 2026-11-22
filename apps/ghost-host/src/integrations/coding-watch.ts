import type { Core } from "../core/core.ts";
import type { HerdrPaneView } from "@ghost/contract";
import { codingPrefs } from "./herdr.ts";
import type { HerdrPort } from "./ports.ts";

const POLL_MS = 5_000;
/** One notification per pane at most this often: an agent that flips between working and blocked is one interruption, not many. */
const QUIET_MS = 60_000;

interface Clock {
  now(): number;
  repeat(tick: () => Promise<void>, intervalMs: number): () => void;
}
const systemClock: Clock = {
  now: Date.now,
  repeat(tick, intervalMs) {
    const timer = setInterval(() => void tick(), intervalMs);
    return () => clearInterval(timer);
  },
};

/**
 * Tells the owner when an agent in the herdr session in use needs an answer or has finished, as a push and an inbox
 * entry on the default Ghost (no model turn). It only compares what herdr reports: a pane that goes from working to
 * blocked, or from working to done; the first look at a pane notifies nothing. The owner's `notify` choice decides which.
 */
export class CodingWatcher {
  private readonly clock: Clock;
  private readonly seen = new Map<string, HerdrPaneView["status"]>();
  private readonly lastTold = new Map<string, number>();
  private cancel: (() => void) | null = null;
  private polling = false;
  private closed = false;

  constructor(private readonly core: Core, private readonly herdr: HerdrPort, options: { clock?: Clock } = {}) {
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    if (this.closed || this.cancel !== null) return;
    this.cancel = this.clock.repeat(() => this.poll(), POLL_MS);
  }

  stop(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
  }

  /** One look; exported for the tests. */
  async poll(): Promise<void> {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      const prefs = codingPrefs(this.core.ledger.setting<unknown>("coding", null));
      const view = await this.herdr.overview();
      const panes = view.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).filter((pane) => pane.agent !== null);
      const now = this.clock.now();
      const alive = new Set<string>();
      for (const pane of panes) {
        const key = `${view.session}/${pane.id}`;
        alive.add(key);
        const before = this.seen.get(key);
        this.seen.set(key, pane.status);
        if (before !== "working" || before === pane.status || prefs.notify === "off") continue;
        const wanted = pane.status === "blocked" || (prefs.notify === "all" && pane.status === "done");
        if (!wanted || now - (this.lastTold.get(key) ?? 0) < QUIET_MS) continue;
        this.lastTold.set(key, now);
        this.tell(pane, view.session, now);
      }
      for (const key of [...this.seen.keys()]) if (!alive.has(key)) { this.seen.delete(key); this.lastTold.delete(key); }
    } catch {
      // herdr not installed or not running: nothing to compare, and nothing to say about it here.
    } finally {
      this.polling = false;
    }
  }

  private tell(pane: HerdrPaneView, session: string, now: number): void {
    const { ledger } = this.core;
    ledger.tx(() => {
      const ghost = ledger.defaultGhost();
      if (ghost === null) return;
      const blocked = pane.status === "blocked";
      this.core.notify({
        id: `coding:${session}:${pane.id}:${pane.status}:${Math.floor(now / 1000)}`,
        kind: "message",
        ghostId: ghost.id,
        conversationId: ghost.directConversationId,
        workId: null,
        decisionId: null,
        title: blocked ? "에이전트가 답을 기다려요" : "에이전트가 끝났어요",
        body: [pane.title, [pane.agent, pane.workspace].filter(Boolean).join(" · ")].filter(Boolean).join("\n").slice(0, 400),
      });
    });
  }
}
