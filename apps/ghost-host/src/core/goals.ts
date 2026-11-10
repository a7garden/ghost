import {
  GOAL_ADOPT,
  MAX_ACTIVE_MILESTONES,
  MAX_MILESTONE_WORKS,
  MAX_OPEN_GOALS,
  MAX_PLANNED_MILESTONES,
  type Decision,
  type Ghost,
  type Goal,
  type GoalProposal,
  type GoalState,
  type Milestone,
  type Work,
} from "@ghost/contract";
import type { Core } from "./core.ts";
import { conflict, invalid, notFound } from "./errors.ts";
import { newId } from "./ids.ts";

/** Persisted in `settings` (`goals`): no ledger migration, so a release rollback keeps its storage fingerprint. */
const KEY = "goals";
const DAY = 24 * 60 * 60_000;
/** After the owner declines a proposal, the main waits this long before proposing another. */
export const PROPOSAL_COOLDOWN = 3 * DAY;
/** Ended milestones each goal shows in a wake: enough to avoid repeating a dropped path, not a history dump. */
const RECENT_ENDED = 3;

interface Stored {
  goals: Goal[];
  milestones: Milestone[];
  /** When the owner last declined a goal proposal. */
  declinedAt: number | null;
}

type Change = { type: "goal"; goal: Goal } | { type: "milestone"; milestone: Milestone };

export interface GoalText {
  title: string;
  why?: string;
  boundaries?: string;
  signal?: string;
}

export interface MilestoneText {
  title: string;
  hypothesis: string;
  exit: string;
}

const open = (goal: Goal) => goal.state !== "closed";
const ended = (milestone: Milestone) => milestone.state === "done" || milestone.state === "dropped";
const clean = (value: string | undefined) => (value ?? "").trim();
const quote = (value: string, max = 200) => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * Team goals (owner decision 2026-11-11): long-term directions that guide what Ghosts choose on their own,
 * never quotas. The owner writes a goal or approves the main's proposal; under each goal the main keeps a
 * short line of milestones. No scheduler of its own: goals ride along in the existing self-directed wakes,
 * and a goal grants no tool, environment or approval beyond what each Ghost already holds.
 */
export class Goals {
  constructor(private readonly core: Core) {}

  private get ledger() {
    return this.core.ledger;
  }

  private load(): Stored {
    return { goals: [], milestones: [], declinedAt: null, ...this.ledger.setting<Partial<Stored> | null>(KEY, null) };
  }

  /** Read, change and write synchronously inside one transaction. Returning the loaded object unchanged writes nothing. */
  private change<T>(apply: (stored: Stored) => { stored: Stored; changes: Change[]; result: T }): T {
    return this.ledger.tx(() => {
      const loaded = this.load();
      const { stored, changes, result } = apply(loaded);
      if (stored !== loaded) {
        this.ledger.putSetting(KEY, stored);
        for (const event of changes) this.ledger.emit(event);
      }
      return result;
    });
  }

  goals(): Goal[] {
    return this.load().goals;
  }

  milestones(): Milestone[] {
    return this.load().milestones;
  }

  goal(goalId: string): Goal {
    const goal = this.load().goals.find((item) => item.id === goalId);
    if (!goal) throw notFound(`goal ${goalId} not found`);
    return goal;
  }

  milestone(milestoneId: string): Milestone {
    const milestone = this.load().milestones.find((item) => item.id === milestoneId);
    if (!milestone) throw notFound(`milestone ${milestoneId} not found`);
    return milestone;
  }

  /** The owner writes a goal. */
  create(input: GoalText): Goal {
    return this.change((stored) => {
      const goal = this.newGoal(stored, input, null, newId());
      return { stored: { ...stored, goals: [...stored.goals, goal] }, changes: [{ type: "goal", goal }], result: goal };
    });
  }

  private newGoal(stored: Stored, input: GoalText, proposedBy: string | null, id: string): Goal {
    const title = clean(input.title);
    if (!title) throw invalid("a goal needs a direction");
    if (stored.goals.filter(open).length >= MAX_OPEN_GOALS) throw conflict(`at most ${MAX_OPEN_GOALS} goals can be open at once; close one first`);
    const now = Date.now();
    return { id, title, why: clean(input.why), boundaries: clean(input.boundaries), signal: clean(input.signal), state: "active", proposedBy, createdAt: now, updatedAt: now, closedAt: null };
  }

  /** The owner edits, pauses, resumes or closes a goal. Closing is final and drops its open milestones. */
  update(goalId: string, patch: Partial<GoalText> & { state?: GoalState }): Goal {
    return this.change((stored) => {
      const current = stored.goals.find((item) => item.id === goalId);
      if (!current) throw notFound(`goal ${goalId} not found`);
      if (current.state === "closed") throw conflict("a closed goal cannot change; write a new one");
      if (patch.title !== undefined && !clean(patch.title)) throw invalid("a goal needs a direction");
      const now = Date.now();
      const state = patch.state ?? current.state;
      const goal: Goal = {
        ...current,
        title: patch.title === undefined ? current.title : clean(patch.title),
        why: patch.why === undefined ? current.why : clean(patch.why),
        boundaries: patch.boundaries === undefined ? current.boundaries : clean(patch.boundaries),
        signal: patch.signal === undefined ? current.signal : clean(patch.signal),
        state,
        closedAt: state === "closed" ? now : null,
      };
      const same = (["title", "why", "boundaries", "signal", "state"] as const).every((field) => goal[field] === current[field]);
      if (same) return { stored, changes: [], result: current };
      goal.updatedAt = now;
      const changes: Change[] = [{ type: "goal", goal }];
      const milestones = stored.milestones.map((milestone) => {
        if (state !== "closed" || milestone.goalId !== goalId || ended(milestone)) return milestone;
        const dropped: Milestone = { ...milestone, state: "dropped", outcome: "목표가 종료되었습니다.", settledBy: "owner", endedAt: now };
        changes.push({ type: "milestone", milestone: dropped });
        return dropped;
      });
      return { stored: { ...stored, goals: stored.goals.map((item) => (item.id === goalId ? goal : item)), milestones }, changes, result: goal };
    });
  }

  /**
   * The main Ghost proposes a goal; only the owner settles it (the card carries no recommended answer, so
   * neither the main nor a timeout can take it). One proposal waits at a time, and a decline pauses proposals.
   */
  propose(main: Ghost, input: GoalText, id: string): Decision {
    const existing = this.ledger.findDecision(id);
    if (existing) return existing;
    const stored = this.load();
    const title = clean(input.title);
    if (!title) throw invalid("a goal needs a direction");
    if (stored.goals.filter(open).length >= MAX_OPEN_GOALS) throw conflict(`the owner already has ${MAX_OPEN_GOALS} open goals; propose only after one closes`);
    if (stored.goals.some((goal) => open(goal) && goal.title === title)) throw conflict("this goal is already open");
    if (this.ledger.pendingDecisions().some((decision) => decision.proposal?.goal)) throw conflict("a goal proposal is already waiting for the owner");
    if (stored.declinedAt !== null && Date.now() - stored.declinedAt < PROPOSAL_COOLDOWN) {
      throw conflict(`the owner declined a goal proposal on ${new Date(stored.declinedAt).toISOString()}; do not propose another for three days`);
    }
    const proposal: GoalProposal = { title, why: clean(input.why), boundaries: clean(input.boundaries), signal: clean(input.signal) };
    const detail = [
      proposal.why,
      proposal.boundaries ? `지키는 선: ${proposal.boundaries}` : "",
      proposal.signal ? `참고 신호: ${proposal.signal}` : "",
    ].filter(Boolean).join("\n\n");
    return this.core.decisions.ask(main.directConversationId, `목표 제안: ${title}`.slice(0, 200), detail, [GOAL_ADOPT, "거절"], id, { goal: proposal });
  }

  /**
   * Apply the owner's answer to a goal proposal before the answer reaches the main. The adoption and its
   * marker commit together, so a replayed follow-up never creates a second goal. Returns the line for the main.
   */
  settleProposal(decision: Decision): string | null {
    const proposal = decision.proposal?.goal as GoalProposal | undefined;
    if (!proposal) return null;
    if (!adopts(decision)) {
      this.change((stored) => ({ stored: { ...stored, declinedAt: Math.max(stored.declinedAt ?? 0, decision.resolvedAt ?? Date.now()) }, changes: [], result: null }));
      return "The goal was not adopted. Do not propose another goal for three days unless the owner asks.";
    }
    return this.ledger.tx(() => {
      const current = this.ledger.decision(decision.id);
      const marked = (current.proposal?.goal as GoalProposal | undefined)?.goalId;
      if (marked) return `Adopted as goal ${marked}.`;
      let goal: Goal;
      try {
        goal = this.change((stored) => {
          const created = this.newGoal(stored, proposal, decision.ghostId, newId());
          return { stored: { ...stored, goals: [...stored.goals, created] }, changes: [{ type: "goal", goal: created }], result: created };
        });
      } catch (error) {
        return `The owner said ${GOAL_ADOPT}, but the goal could not be added: ${(error as Error).message}.`;
      }
      this.ledger.putDecision({ ...current, proposal: { ...current.proposal, goal: { ...proposal, goalId: goal.id } } });
      return `Adopted as goal ${goal.id}. Plan its first milestone when a concrete next step is clear; no milestone is fine until then.`;
    });
  }

  /** The main plans a milestone under an active goal. A replayed call with the same id returns the same milestone. */
  plan(by: Ghost, goalId: string, input: MilestoneText, id: string): Milestone {
    return this.change((stored) => {
      const existing = stored.milestones.find((item) => item.id === id);
      if (existing) return { stored, changes: [], result: existing };
      const goal = stored.goals.find((item) => item.id === goalId);
      if (!goal) throw notFound(`goal ${goalId} not found`);
      if (goal.state !== "active") throw conflict(`the goal is ${goal.state}; milestones change only under an active goal`);
      const planned = stored.milestones.filter((item) => item.goalId === goalId && item.state === "planned").length;
      if (planned >= MAX_PLANNED_MILESTONES) throw conflict(`${MAX_PLANNED_MILESTONES} milestones are already planned; plan the far road later, when the near steps have taught you something`);
      const title = clean(input.title);
      if (!title) throw invalid("a milestone needs a title");
      const exit = clean(input.exit);
      if (!exit) throw invalid("say what evidence would finish this milestone");
      const milestone: Milestone = {
        id, goalId, title, hypothesis: clean(input.hypothesis), exit, state: "planned", outcome: "", workIds: [],
        createdBy: by.id, settledBy: null, createdAt: Date.now(), startedAt: null, endedAt: null,
      };
      return { stored: { ...stored, milestones: [...stored.milestones, milestone] }, changes: [{ type: "milestone", milestone }], result: milestone };
    });
  }

  /**
   * The main moves a milestone: planned → active (at most two at once), active → done (only with an accepted
   * Work linked to it, plus the evidence in words), planned or active → dropped (with the reason).
   */
  advance(by: Ghost, milestoneId: string, state: "active" | "done" | "dropped", outcome?: string): Milestone {
    return this.change((stored) => {
      const current = stored.milestones.find((item) => item.id === milestoneId);
      if (!current) throw notFound(`milestone ${milestoneId} not found`);
      const text = clean(outcome);
      if (current.state === state && (state === "active" || current.outcome === text)) return { stored, changes: [], result: current };
      if (ended(current)) throw conflict(`this milestone is already ${current.state}; plan a new one instead`);
      const goal = stored.goals.find((item) => item.id === current.goalId)!;
      if (goal.state !== "active") throw conflict(`the goal is ${goal.state}; milestones change only under an active goal`);
      const now = Date.now();
      let next: Milestone;
      if (state === "active") {
        if (current.state !== "planned") throw conflict("only a planned milestone starts");
        const active = stored.milestones.filter((item) => item.goalId === current.goalId && item.state === "active").length;
        if (active >= MAX_ACTIVE_MILESTONES) throw conflict(`${MAX_ACTIVE_MILESTONES} milestones are already active; finish or drop one first`);
        next = { ...current, state: "active", startedAt: now };
      } else if (state === "done") {
        if (current.state !== "active") throw conflict("only an active milestone finishes; start it first");
        if (!text) throw invalid("state the evidence that finished it");
        const accepted = current.workIds.filter((workId) => this.ledger.findWork(workId)?.state === "done");
        if (accepted.length === 0) throw conflict("a milestone finishes only with an accepted Work linked to it (work_create with milestone_id); your own claim is not evidence");
        next = { ...current, state: "done", outcome: text, settledBy: by.id, endedAt: now };
      } else {
        if (!text) throw invalid("say why the path is dropped, so no one repeats it");
        next = { ...current, state: "dropped", outcome: text, settledBy: by.id, endedAt: now, startedAt: current.startedAt };
      }
      return { stored: { ...stored, milestones: stored.milestones.map((item) => (item.id === milestoneId ? next : item)) }, changes: [{ type: "milestone", milestone: next }], result: next };
    });
  }

  /** The owner finishes or drops a planned or active milestone; the owner's word needs no linked Work. */
  settleByOwner(milestoneId: string, state: "done" | "dropped", outcome?: string): Milestone {
    return this.change((stored) => {
      const current = stored.milestones.find((item) => item.id === milestoneId);
      if (!current) throw notFound(`milestone ${milestoneId} not found`);
      if (ended(current)) throw conflict(`this milestone is already ${current.state}`);
      const now = Date.now();
      const next: Milestone = { ...current, state, outcome: clean(outcome), settledBy: "owner", startedAt: current.startedAt ?? (state === "done" ? now : null), endedAt: now };
      return { stored: { ...stored, milestones: stored.milestones.map((item) => (item.id === milestoneId ? next : item)) }, changes: [{ type: "milestone", milestone: next }], result: next };
    });
  }

  /** Refuse before a Work exists: a Work may serve only an active milestone of an active goal. */
  checkLink(milestoneId: string) {
    const milestone = this.milestone(milestoneId);
    const goal = this.goal(milestone.goalId);
    if (goal.state !== "active") throw conflict(`the goal is ${goal.state}; do not start Work for it`);
    if (milestone.state !== "active") throw conflict(`the milestone is ${milestone.state}; only an active milestone takes Work (the main starts it)`);
    if (milestone.workIds.length >= MAX_MILESTONE_WORKS) throw conflict("this milestone already has its maximum of linked Work");
  }

  /** Record a root Work as serving a milestone; linking the same Work again changes nothing. A replay after the milestone ended or filled is refused like a fresh call. */
  link(milestoneId: string, workId: string): Milestone {
    return this.change((stored) => {
      const current = stored.milestones.find((item) => item.id === milestoneId);
      if (!current) throw notFound(`milestone ${milestoneId} not found`);
      if (current.workIds.includes(workId)) return { stored, changes: [], result: current };
      if (current.state !== "active") throw conflict(`the milestone is ${current.state}; the Work was created but is not linked to it`);
      const goal = stored.goals.find((item) => item.id === current.goalId);
      if (goal?.state !== "active") throw conflict(`the goal is ${goal?.state ?? "gone"}; the Work was created but is not linked to it`);
      if (current.workIds.length >= MAX_MILESTONE_WORKS) throw conflict("this milestone already has its maximum of linked Work; the Work was created but is not linked to it");
      const next = { ...current, workIds: [...current.workIds, workId] };
      return { stored: { ...stored, milestones: stored.milestones.map((item) => (item.id === milestoneId ? next : item)) }, changes: [{ type: "milestone", milestone: next }], result: next };
    });
  }

  /** The goals section of a self-directed wake: open goals, their boundaries and the milestone line. Empty without goals. */
  context(): string {
    const stored = this.load();
    const goals = stored.goals.filter(open);
    if (goals.length === 0) return "";
    const lines = ["Team goals (owner-approved long-term directions: let them guide what you choose; they are not quotas, carry no deadline and grant no authority):"];
    for (const goal of goals) {
      lines.push(`- "${quote(goal.title)}" (${goal.id})${goal.state === "paused" ? " — paused by the owner: do not act on it" : ""}`);
      // Boundaries bind every means, so they travel whole (already bounded by the contract); descriptive text is trimmed instead.
      if (goal.boundaries) lines.push(`  Never use: ${goal.boundaries.replace(/\s+/g, " ").trim()}`);
      if (goal.signal) lines.push(`  Reference signal (not a target): ${quote(goal.signal, 300)}`);
      const milestones = stored.milestones.filter((item) => item.goalId === goal.id);
      const past = milestones.filter(ended).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0)).slice(-RECENT_ENDED);
      for (const item of past) lines.push(`  ${item.state === "done" ? "Done" : "Dropped"}: "${quote(item.title, 120)}" — ${quote(item.outcome, 200)}`);
      for (const item of milestones.filter((milestone) => milestone.state === "active")) {
        const live = item.workIds.map((workId) => this.ledger.findWork(workId)).filter((work): work is Work => !!work && !["done", "failed", "cancelled"].includes(work.state)).length;
        const accepted = item.workIds.filter((workId) => this.ledger.findWork(workId)?.state === "done").length;
        lines.push(`  Active milestone: "${quote(item.title, 120)}" (${item.id}) — finishes with: ${quote(item.exit, 200)}; linked Work ${item.workIds.length} (live ${live}, accepted ${accepted})`);
      }
      const planned = milestones.filter((item) => item.state === "planned").sort((a, b) => a.createdAt - b.createdAt);
      if (planned.length) lines.push(`  Next: ${planned.slice(0, 2).map((item) => `"${quote(item.title, 80)}" (${item.id})`).join(", ")}${planned.length > 2 ? `; later: ${planned.length - 2} more` : ""}`);
      if (milestones.length === 0) lines.push("  No milestones yet.");
    }
    return lines.join("\n");
  }

  /** A Work started for a milestone carries its goal's boundaries into execution, delegated children included. */
  workInstructions(work: Work): string {
    const stored = this.load();
    const milestone = stored.milestones.find((item) => item.workIds.includes(work.rootId));
    if (!milestone) return "";
    const goal = stored.goals.find((item) => item.id === milestone.goalId);
    if (!goal) return "";
    return [
      `This Work serves the team goal "${goal.title}" through the milestone "${milestone.title}" (finishes with: ${milestone.exit}).`,
      goal.boundaries ? `The owner's boundaries for this goal bind this Work: never use ${goal.boundaries}` : "",
      "The goal is a direction, not a quota: do not stretch facts, results or means to look closer to it.",
    ].filter(Boolean).join("\n");
  }
}

/** Only exact affirmative tokens adopt; "등록하지 마세요" never does. */
function adopts(decision: Decision): boolean {
  if (decision.state === "approved") return true;
  if (decision.state !== "answered") return false;
  const text = (decision.answer ?? "").trim().replace(/[.!。]+$/, "").toLowerCase();
  return [GOAL_ADOPT, "adopt", "approve", "yes", "예", "네", "허용"].includes(text);
}
