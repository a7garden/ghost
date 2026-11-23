import type { Core } from "../core/core.ts";
import type { HerdrPaneView } from "@ghost/contract";
import { codingPrefs } from "./herdr.ts";
import type { HerdrPort } from "./ports.ts";

const POLL_MS = 5_000;
/** One notification per pane at most this often: an agent that flips between working and blocked is one interruption, not many. */
const QUIET_MS = 60_000;
const TITLES = {
  blocked: "에이전트가 답을 기다려요",
  done: "에이전트가 끝났어요",
  exit: "에이전트가 종료됐어요",
};
type Alert = keyof typeof TITLES;
type SeenAgent = { pane: HerdrPaneView; managed: boolean; active: boolean };

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
 * Tells the owner when an agent needs an answer, finishes a turn or exits, without starting a Ghost turn.
 * The first look at each pane is only a baseline. Work manages its own notifications.
 */
export class CodingWatcher {
  private readonly clock: Clock;
  private seen = new Map<string, SeenAgent>();
  private session: string | null = null;
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
      if (this.closed || !view.available || view.note !== null) return;
      if (view.session !== this.session) {
        this.session = view.session;
        this.seen.clear();
        this.lastTold.clear();
      }
      const { seen, lastTold } = this;
      const agents = new Map<string, SeenAgent>();
      const now = this.clock.now();
      const alert = (pane: HerdrPaneView, kind: Alert) => {
        if (prefs.notify === "off" || (prefs.notify === "blocked" && kind !== "blocked")) return;
        const last = lastTold.get(pane.id);
        if (last !== undefined && now - last < QUIET_MS) return;
        this.tell(pane, kind, view.session, now);
        lastTold.set(pane.id, now);
      };
      const alive = new Set<string>();
      for (const workspace of view.workspaces) for (const tab of workspace.tabs) for (const pane of tab.panes) {
        alive.add(pane.id);
        const before = seen.get(pane.id);
        const managed = this.core.coding.managed(view.session, pane);
        const previous = before?.pane;
        const sameTerminal = previous !== undefined && previous.terminalId === pane.terminalId;
        const sameAgent = sameTerminal && previous.agent === pane.agent
          && (previous.agentSessionId === undefined || pane.agentSessionId === undefined || previous.agentSessionId === pane.agentSessionId);
        if (pane.agent !== null) {
          const active = pane.status === "working" || pane.status === "idle" || (sameAgent && before?.active === true);
          agents.set(pane.id, { pane, managed, active });
        }
        if (managed || !before || !previous || before.managed || this.core.coding.managed(view.session, previous)) continue;
        if (pane.agent === null) {
          alert(previous, "exit");
        } else if (!sameTerminal) {
          if (before.active) alert(previous, "exit");
        } else if (sameAgent && previous.status === "working") {
          if (pane.status === "blocked") alert(pane, "blocked");
          else if (pane.status === "idle" || pane.status === "done") alert(pane, "done");
        }
      }
      for (const { pane, managed, active } of seen.values()) {
        if (!alive.has(pane.id) && !managed && active && !this.core.coding.managed(view.session, pane)) alert(pane, "exit");
      }
      this.seen = agents;
      for (const id of lastTold.keys()) if (!alive.has(id)) lastTold.delete(id);
    } catch {
      // herdr not installed or not running: nothing to compare, and nothing to say about it here.
    } finally {
      this.polling = false;
    }
  }

  private tell(pane: HerdrPaneView, alert: Alert, session: string, now: number): void {
    const { ledger } = this.core;
    ledger.tx(() => {
      const ghost = ledger.defaultGhost();
      if (ghost === null) return;
      this.core.notify({
        id: `coding:${session}:${pane.id}:${alert}:${Math.floor(now / 1000)}`,
        kind: "message",
        ghostId: ghost.id,
        conversationId: ghost.directConversationId,
        workId: null,
        decisionId: null,
        title: TITLES[alert],
        body: [pane.title, [pane.agent, pane.workspace].filter(Boolean).join(" · ")].filter(Boolean).join("\n").slice(0, 400),
      });
    });
  }
}
