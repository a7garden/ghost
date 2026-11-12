import { Type } from "typebox";
import { GOAL_SIGNAL_MAX, GOAL_TEXT_MAX, GOAL_TITLE_MAX, type Goal, type Milestone } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { idFor } from "../core/ids.ts";
import { requireMainCaller } from "./main.ts";
import { errorResult } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

export const GOALS_INSTRUCTIONS = `Team goals are the owner's long-term directions, shown in every self-directed wake. They guide what the team chooses; they are not quotas, have no deadline and grant no tool, environment or approval. Their boundaries bind every means.
Under each active goal you keep a short milestone line. Plan a milestone (milestone_plan) only when a concrete next step is clear: plan the next one or two, never the whole road. Start one with milestone_update active (at most two at once), then hand its work out with work_create and milestone_id. Finish it with milestone_update done only after a linked Work is accepted, and state that evidence. When evidence says a path is wrong, drop it with the reason so nobody repeats it. Spending a wake only to re-plan is not progress.
goal_list shows every goal and milestone with ids. Propose a new goal with goal_propose only when the owner has expressed a lasting intent, never from a passing remark; the owner alone adopts it.`;

function renderMilestone(milestone: Milestone, core: Core): string {
  const works = milestone.workIds.map((id) => {
    const work = core.ledger.findWork(id);
    return work ? `${work.id} ${work.state}` : id;
  });
  return [
    `  - [${milestone.state}] "${milestone.title}" (${milestone.id})`,
    milestone.hypothesis ? `    why: ${milestone.hypothesis}` : "",
    `    finishes with: ${milestone.exit}`,
    milestone.outcome ? `    ${milestone.state === "dropped" ? "dropped because" : "evidence"}: ${milestone.outcome}` : "",
    works.length ? `    Work: ${works.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

function renderGoal(goal: Goal, milestones: Milestone[], core: Core): string {
  return [
    `- [${goal.state}] "${goal.title}" (${goal.id})`,
    goal.why ? `  why: ${goal.why}` : "",
    goal.boundaries ? `  never use: ${goal.boundaries}` : "",
    goal.signal ? `  reference signal: ${goal.signal}` : "",
    ...milestones.filter((item) => item.goalId === goal.id).map((item) => renderMilestone(item, core)),
  ].filter(Boolean).join("\n");
}

/** `goal_list`, `goal_propose`, `milestone_plan`, `milestone_update`: the current main only, direct conversations only. */
export function createGoalTools(core: Core): Extension {
  const goalList = defineTool({
    name: "goal_list",
    description: "List the team's goals with their milestone lines and linked Work. Closed goals are listed last. Main Ghost only.",
    parameters: Type.Object({ scope_id: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])) }),
    replay: "safe",
    async execute(args, api) {
      try {
        requireMainCaller(core, api);
        const goals = core.goals.goals(args.scope_id);
        if (goals.length === 0) return text("No goals yet. The owner writes them, or adopts one you propose.");
        const order = [...goals].sort((a, b) => Number(a.state === "closed") - Number(b.state === "closed") || a.createdAt - b.createdAt);
        const milestones = core.goals.milestones();
        return text(order.map((goal) => renderGoal(goal, milestones, core)).join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const goalPropose = defineTool({
    name: "goal_propose",
    description:
      "Propose a long-term team goal to the owner: a direction, not a quota or deadline. Only for a lasting intent the owner has expressed. " +
      "The owner alone adopts it (등록) or declines it; the answer arrives as a message. One proposal waits at a time. Main Ghost only.",
    parameters: Type.Object({
      scope_id: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
      title: Type.String({ minLength: 1, maxLength: GOAL_TITLE_MAX, description: "The direction, in the owner's language" }),
      why: Type.String({ minLength: 1, maxLength: GOAL_TEXT_MAX, description: "Why it matters, and the owner's words or requests it comes from" }),
      boundaries: Type.Optional(Type.String({ maxLength: GOAL_TEXT_MAX, description: "Means the team must not use for it" })),
      signal: Type.Optional(Type.String({ maxLength: GOAL_SIGNAL_MAX, description: "What would suggest it is working; a reference, not a target" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireMainCaller(core, api);
        const decision = core.goals.propose(scope.ghost, { ...args, scopeId: args.scope_id }, idFor(scope.conversation.id, api.callId));
        return text(`Proposed to the owner (${decision.id}). Wait for the answer; it arrives here.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const milestonePlan = defineTool({
    name: "milestone_plan",
    description: "Plan the next milestone under an active goal: a concrete step, why it should move the goal, and the evidence that would finish it. At most four wait planned. Main Ghost only.",
    parameters: Type.Object({
      goal_id: Type.String({ minLength: 1, maxLength: 128 }),
      title: Type.String({ minLength: 1, maxLength: GOAL_TITLE_MAX }),
      hypothesis: Type.String({ minLength: 1, maxLength: GOAL_TEXT_MAX, description: "Why this step should move the goal" }),
      exit: Type.String({ minLength: 1, maxLength: GOAL_TEXT_MAX, description: "The evidence that finishes it" }),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireMainCaller(core, api);
        const milestone = core.goals.plan(scope.ghost, args.goal_id, args, idFor(scope.conversation.id, api.callId));
        return text(`Milestone "${milestone.title}" planned (${milestone.id}).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const milestoneUpdate = defineTool({
    name: "milestone_update",
    description:
      "Move a milestone: active starts a planned one (at most two at once); done finishes an active one, only after a linked Work was accepted, with the evidence in outcome; " +
      "dropped ends a planned or active one with the reason in outcome. Main Ghost only.",
    parameters: Type.Object({
      milestone_id: Type.String({ minLength: 1, maxLength: 128 }),
      state: Type.Union([Type.Literal("active"), Type.Literal("done"), Type.Literal("dropped")]),
      outcome: Type.Optional(Type.String({ maxLength: GOAL_TEXT_MAX, description: "Evidence for done, reason for dropped" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireMainCaller(core, api);
        const milestone = core.goals.advance(scope.ghost, args.milestone_id, args.state, args.outcome);
        return text(`Milestone "${milestone.title}" is ${milestone.state}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({ name: "ghost.goals", tools: [goalList, goalPropose, milestonePlan, milestoneUpdate] });
}
