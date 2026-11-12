import { Type, type Static } from "typebox";
import { Id, Timestamp, nullable } from "./entities.ts";

/**
 * 목표 (owner decision 2026-11-11). A goal is a long-term direction for the whole team, not a quota: it guides
 * what Ghosts choose on their own, it carries no deadline or target to optimize, and it grants no authority.
 * The owner writes one directly, or the main Ghost proposes one and the owner approves it. Under each goal the
 * main Ghost keeps a short, time-ordered line of 이정표 (milestones): only the next few are concrete, at most
 * two run at once, a finished one needs an accepted Work as evidence and a dropped one keeps its reason.
 */

export const GOAL_TITLE_MAX = 200;
export const GOAL_TEXT_MAX = 2000;
export const GOAL_SIGNAL_MAX = 500;
/** Milestones running at once under one goal. */
export const MAX_ACTIVE_MILESTONES = 2;
/** Planned milestones waiting under one goal: plan the next few, not the whole road. */
export const MAX_PLANNED_MILESTONES = 4;
/** Works linked to one milestone. */
export const MAX_MILESTONE_WORKS = 64;

export const GoalState = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("closed")]);
export type GoalState = Static<typeof GoalState>;

export const Goal = Type.Object({
  scopeId: nullable(Id),
  id: Id,
  /** The direction, in the owner's words. */
  title: Type.String({ minLength: 1, maxLength: GOAL_TITLE_MAX }),
  /** Why it matters. */
  why: Type.String({ maxLength: GOAL_TEXT_MAX }),
  /** Means the team must not use for it (unsolicited messages, false claims, spending, ...). */
  boundaries: Type.String({ maxLength: GOAL_TEXT_MAX }),
  /** What would suggest the direction is working; a reference, never a target to optimize. */
  signal: Type.String({ maxLength: GOAL_SIGNAL_MAX }),
  state: GoalState,
  /** The Ghost whose proposal the owner approved; null when the owner wrote it. */
  proposedBy: nullable(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  closedAt: nullable(Timestamp),
});
export type Goal = Static<typeof Goal>;

export const MilestoneState = Type.Union([Type.Literal("planned"), Type.Literal("active"), Type.Literal("done"), Type.Literal("dropped")]);
export type MilestoneState = Static<typeof MilestoneState>;

export const Milestone = Type.Object({
  scopeId: nullable(Id),
  id: Id,
  goalId: Id,
  title: Type.String({ minLength: 1, maxLength: GOAL_TITLE_MAX }),
  /** Why this step should move the goal. */
  hypothesis: Type.String({ maxLength: GOAL_TEXT_MAX }),
  /** The evidence that would finish it. */
  exit: Type.String({ maxLength: GOAL_TEXT_MAX }),
  state: MilestoneState,
  /** Evidence when done, the reason when dropped; empty before. */
  outcome: Type.String({ maxLength: GOAL_TEXT_MAX }),
  /** Root Works started for it, oldest first. */
  workIds: Type.Array(Id, { maxItems: MAX_MILESTONE_WORKS }),
  /** The Ghost that planned it. */
  createdBy: Id,
  /** A Ghost id, or `owner`; null until done or dropped. */
  settledBy: nullable(Id),
  createdAt: Timestamp,
  startedAt: nullable(Timestamp),
  endedAt: nullable(Timestamp),
});
export type Milestone = Static<typeof Milestone>;

/** `proposal.goal` of a `question` decision the main Ghost opens; only the owner settles it. */
export const GoalProposal = Type.Object({
  scopeId: Type.Optional(nullable(Id)),
  title: Type.String({ minLength: 1, maxLength: GOAL_TITLE_MAX }),
  why: Type.String({ maxLength: GOAL_TEXT_MAX }),
  boundaries: Type.String({ maxLength: GOAL_TEXT_MAX }),
  signal: Type.String({ maxLength: GOAL_SIGNAL_MAX }),
  /** Set with the adoption, before the answer reaches the Ghost; recovery never adopts twice. */
  goalId: Type.Optional(Id),
});
export type GoalProposal = Static<typeof GoalProposal>;
/** The answer that adopts a proposed goal; any other answer declines it. */
export const GOAL_ADOPT = "등록";
export const GOAL_DECLINE = "거절";
