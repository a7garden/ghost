import { isTerminal } from "./works.ts";
import type { Core } from "./core.ts";
import type { Ghost, Work, WorkState } from "@ghost/contract";

/** Rows shown in one main wake; everything else stays reachable through work_list and work_inspect. */
const MAX_CONTEXT_ROWS = 24;

const LIVE_STATES: readonly WorkState[] = ["queued", "running", "waiting", "verifying", "blocked"];

/**
 * The main Ghost as team connector, not router. A settled ordinary root Work or a blocked Work does
 * not open a new conversation anywhere: it pulls the current main Ghost's next self-directed look
 * forward through `Autonomy.teamChanged`, so the existing admission path — duty, the daily budget,
 * busy conversations, the concurrency cap — stays the only way team evidence reaches a model. The
 * Work ledger is the evidence; the wake prompt reads it at preparation time. Owner-initiated roots
 * keep reporting to their own origin conversation immediately, as always.
 */
export class Team {
  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  /** The current main Ghost straight from the ledger, or null; never a captured caller identity. */
  private main(): Ghost | null {
    const main = this.ledger.defaultGhost();
    return main && main.state === "active" && main.deletedAt === null ? main : null;
  }

  /** Ordinary Work: a root that is not an Activity run. Activity outcomes stay inside the activity's own rule. */
  private ordinary(work: Work): boolean {
    return work.parentId === null && !work.activityId;
  }

  /**
   * A settled ordinary root pulls the current main's next look forward — unless it already reports
   * into a conversation of the main itself, where the ordinary origin report carries the outcome.
   */
  async report(work: Work): Promise<void> {
    if (!this.ordinary(work) || !isTerminal(work) || work.state === "cancelled") return;
    const main = this.main();
    if (!main) return;
    const origin = this.ledger.findConversation(work.originConversationId);
    if (origin?.ghostId === main.id) return;
    await this.core.autonomy.teamChanged(work);
  }

  /** A blocked non-activity Work pulls the main's next look forward; blocked Work sends no origin report. */
  async blocked(work: Work): Promise<void> {
    if (work.state !== "blocked" || work.activityId) return;
    await this.core.autonomy.teamChanged(work);
  }

  /**
   * Bounded live overview for the main Ghost's wake: every live team Work as one row with name,
   * state and reason, plus explicit counts over all live Work. The main's own live Work is already
   * listed separately by the wake, so rows cover teammates; full detail stays with work_list and
   * work_inspect.
   */
  context(sources?: Set<string>): string {
    const live = this.ledger.worksInState(...LIVE_STATES);
    if (live.length === 0) return "";
    const tally = LIVE_STATES.map((state) => [state, live.filter((work) => work.state === state).length] as const)
      .filter(([, count]) => count > 0)
      .map(([state, count]) => `${state} ${count}`)
      .join(", ");
    const main = this.main();
    const rows = live.filter((work) => !main || work.ghostId !== main.id);
    const lines = [`Live team Work: ${live.length} (${tally})`];
    for (const work of rows.slice(0, MAX_CONTEXT_ROWS)) {
      if (work.conversationId) sources?.add(work.conversationId);
      const assignee = this.ledger.ghost(work.ghostId).name;
      const marker = work.activityId ? " [activity]" : "";
      const reason = work.reason ? ` — ${work.reason.split("\n", 1)[0]!.slice(0, 200)}` : "";
      lines.push(`- "${work.title}" (${work.id}) — ${assignee} — ${work.state}${marker}${reason}`);
    }
    const hidden = rows.length - Math.min(rows.length, MAX_CONTEXT_ROWS);
    if (hidden > 0) lines.push(`+${hidden} more: work_list shows all, work_inspect takes a row's id`);
    return lines.join("\n");
  }
}
