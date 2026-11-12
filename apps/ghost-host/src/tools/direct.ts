import { Type } from "typebox";
import type { Acceptance, Ghost, Work, WorkDetail } from "@ghost/contract";
import { ExecutionTarget } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { forbidden, invalid } from "../core/errors.ts";
import { idFor } from "../core/ids.ts";
import { workDetail } from "../core/state.ts";
import { askOwnerTool, describeWorkLine, errorResult, firstLine, requireAllowed, requireOrigin, workDecideTool, type Scope } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/** The caller is the current active main Ghost, resolved at execution; a former main loses the role at once. */
function isCurrentMain(scope: Scope): boolean {
  return scope.ghost.isDefault && scope.ghost.state === "active";
}

/** Works created here (their whole tree) plus this Ghost's live Work, one compact line each. The current main Ghost sees the whole team's Work. */
function visibleWorks(core: Core, scope: Scope): Work[] {
  const { ledger } = core;
  if (isCurrentMain(scope)) return ledger.worksForState();
  const found = new Map<string, Work>();
  const walk = (work: Work) => {
    if (found.has(work.id)) return;
    found.set(work.id, work);
    for (const child of ledger.children(work.id)) walk(child);
  };
  for (const work of ledger.worksForState()) {
    if (work.parentId === null) {
      if (work.originConversationId === scope.conversation.id) walk(work);
    } else if (work.ghostId === scope.ghost.id && work.state !== "done" && work.state !== "failed" && work.state !== "cancelled") {
      walk(work);
    }
  }
  return [...found.values()];
}

export function createDirectTools(core: Core): Extension {
  const workCreate = defineTool({
    name: "work_create",
    description: "Create a Work for an owner task, or on your own initiative (initiative: true), and report it to this conversation. The Work runs in its own conversation.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 256, description: "Short name of the Work" }),
      brief: Type.String({ minLength: 1, maxLength: 32768, description: "What to do, with everything the assignee needs" }),
      criteria: Type.Optional(Type.String({ maxLength: 8192, description: "When the Work is done" })),
      ghost_id: Type.Optional(Type.String({ description: "Assignee Ghost; defaults to this Ghost" })),
      budget_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "Working minutes the Work may spend before it pauses and asks this conversation to extend once, split or stop it; defaults to 90" })),
      execution: Type.Optional(ExecutionTarget),
      initiative: Type.Optional(Type.Boolean({ description: "true when you start this Work on your own judgment, not an owner request: a Ghost then reviews the result instead of the owner" })),
      milestone_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "The active team-goal milestone this Work serves, from the goals in your wake; its goal's boundaries then bind the Work" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_create");
        // 퇴근 중에는 스스로 새 일을 시작하지 않는다. 소유자가 시킨 일은 막지 않는다.
        // 2026.11.11 : 「plan_next 로 남겨라」는 그 도구가 없는 Ghost(구동 꺼짐)에게는 막다른 안내였다.
        if (args.initiative && !core.duty.onDuty()) {
          // plan_next 는 직접 대화에서만, 그리고 그 Ghost 가 받았을 때만 쓸 수 있다. 아니면 막다른 안내가 된다.
          const canPlan = scope.conversation.kind === "direct" && core.autonomy.enabled(scope.ghost.id);
          const planning = canPlan ? "Record what you would do with plan_next instead." : "Tell the owner what you would do instead.";
          throw forbidden(`the owner is off duty: do not start new Work on your own until they are back. ${planning}`);
        }
        const ghostId = args.ghost_id ?? scope.ghost.id;
        const id = idFor(scope.conversation.id, api.callId);
        // Refused before the Work exists, so a stale milestone never leaves an unlinked Work behind; a replay finds its Work.
        if (args.milestone_id && !core.ledger.findWork(id)) core.goals.checkLink(args.milestone_id);
        // The Work and its milestone link commit together, so a crash never leaves a milestone Work without its goal's boundaries.
        const work = core.ledger.tx(() => {
          const created = core.works.createRoot({
            ghostId,
            title: args.title,
            brief: args.brief,
            scopeId: args.milestone_id ? core.goals.milestone(args.milestone_id).scopeId : null,
            acceptance: { criteria: args.criteria ?? "", checks: [], reviewer: args.initiative ? initiativeReviewer(core, scope.ghost, ghostId) : null },
            deadlineAt: null,
            budgetMinutes: args.budget_minutes,
            originConversationId: scope.conversation.id,
            execution: args.execution,
            id,
          });
          if (args.milestone_id) core.goals.link(args.milestone_id, created.id);
          return created;
        });
        const assignee = core.ledger.ghost(work.ghostId).name;
        return text(`Work "${work.title}" created (${work.id}), assigned to ${assignee}${args.milestone_id ? ", serving the milestone" : ""}. It reports back here when it settles.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const workList = defineTool({
    name: "work_list",
    description: "List the Work created in this conversation and this Ghost's live Work. The current main Ghost instead sees the whole team's Work, live and recently settled.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        const scope = requireAllowed(core, api, "work_list");
        const works = visibleWorks(core, scope);
        return text(works.length === 0 ? "No Work here yet." : works.map((work) => describeWorkLine(core, work)).join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const workInspect = defineTool({
    name: "work_inspect",
    description: "Inspect one Work: its tree, effects, artifacts and decisions. A Work of this conversation or assignee; the current main Ghost may inspect any team Work.",
    parameters: Type.Object({ work_id: Type.String({ minLength: 1, description: "The Work's id" }) }),
    replay: "safe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_inspect");
        const work = core.ledger.work(args.work_id);
        const root = work.rootId === work.id ? work : core.ledger.work(work.rootId);
        if (!isCurrentMain(scope)) {
          const assignedHere = work.ghostId === scope.ghost.id;
          if (root.originConversationId !== scope.conversation.id && !assignedHere) {
            throw invalid("this Work neither originates from this conversation nor is assigned to this Ghost");
          }
        }
        const detail = workDetail(core, work.id);
        return text(renderDetail(core, detail.work, detail));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const workUpdate = defineTool({
    name: "work_update",
    description: "Edit a Work created in this conversation: title, brief, done-criteria, or lower its execution budget. A budget is raised once, with work_decide on the paused Work; the due date is the owner's alone.",
    parameters: Type.Object({
      work_id: Type.String({ minLength: 1, description: "The Work's id" }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      brief: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
      criteria: Type.Optional(Type.String({ maxLength: 8192, description: "Replaces the done-criteria; checks and reviewer are not editable here" })),
      budget_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "New execution budget in working minutes; only a lower value is accepted here" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_update");
        const work = requireOrigin(core, scope, args.work_id);
        const acceptance = args.criteria === undefined ? undefined : { ...work.acceptance, criteria: args.criteria };
        if (args.budget_minutes !== undefined && args.budget_minutes > work.budgetMinutes) {
          throw forbidden("a budget is extended once with work_decide on the paused Work; lower it here or split the Work");
        }
        const next = core.works.update(work.id, {
          title: args.title,
          brief: args.brief,
          acceptance,
          budgetMinutes: args.budget_minutes,
        }, "origin");
        return text(`Work "${next.title}" is now revision ${next.revision} (${next.state}).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const workCancel = defineTool({
    name: "work_cancel",
    description: "Cancel a Work created in this conversation, including everything it delegated.",
    parameters: Type.Object({ work_id: Type.String({ minLength: 1, description: "The Work's id" }) }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_cancel");
        const work = requireOrigin(core, scope, args.work_id);
        const next = core.works.cancel(work.id, `cancelled from the conversation of ${scope.ghost.name}`);
        return text(`Work "${next.title}" is ${next.state}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const scheduleCreate = defineTool({
    name: "schedule_create",
    description: "Schedule this conversation to be woken with a prompt, once at a time or repeatedly.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 8192, description: "What this Ghost should do when woken" }),
      at: Type.Optional(Type.String({ description: "ISO 8601 time for a one-off wake" })),
      every_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat interval in minutes" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "schedule_create");
        const spec = scheduleSpec(args.at, args.every_minutes);
        const schedule = core.schedules.create({ ghostId: scope.ghost.id, conversationId: scope.conversation.id, prompt: args.prompt, spec, id: idFor(scope.conversation.id, api.callId) });
        return text(`Schedule ${schedule.id} created; next run ${schedule.nextAt === null ? "never" : new Date(schedule.nextAt).toISOString()}.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const scheduleList = defineTool({
    name: "schedule_list",
    description: "List this Ghost's schedules.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        const scope = requireAllowed(core, api, "schedule_list");
        const schedules = core.ledger.schedules().filter((schedule) => schedule.ghostId === scope.ghost.id);
        return text(
          schedules.length === 0
            ? "No schedules."
            : schedules
                .map((schedule) => {
                  const spec =
                    schedule.spec.kind === "at"
                      ? `at ${new Date(schedule.spec.at).toISOString()}`
                      : `every ${schedule.spec.seconds / 60} minutes`;
                  return `- ${schedule.id} — ${spec} — ${schedule.state} — ${firstLine(schedule.prompt)}`;
                })
                .join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const scheduleCancel = defineTool({
    name: "schedule_cancel",
    description: "Cancel one of this Ghost's schedules.",
    parameters: Type.Object({ schedule_id: Type.String({ minLength: 1 }) }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "schedule_cancel");
        const schedule = core.ledger.schedule(args.schedule_id);
        if (schedule.ghostId !== scope.ghost.id) throw invalid("that schedule belongs to another Ghost");
        core.schedules.delete(schedule.id);
        return text(`Schedule ${schedule.id} cancelled.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const ghostList = defineTool({
    name: "ghost_list",
    description: "List the active Ghosts, so a task can be handed to a better-fit Ghost.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        const scope = requireAllowed(core, api, "ghost_list");
        const ghosts = core.ledger.ghosts().filter((ghost) => ghost.state === "active");
        return text(ghosts.map((ghost: Ghost) => `- ${ghost.name} (${ghost.id}) — ${firstLine(ghost.persona)}`).join("\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({
    name: "ghost.direct",
    tools: [workCreate, workList, workInspect, workUpdate, workCancel, workDecideTool(core), askOwnerTool(core), scheduleCreate, scheduleList, scheduleCancel, ghostList],
  });
}

/**
 * Self-started Work is judged by a Ghost, not the owner: the starting Ghost when it hands the Work to
 * a teammate, else the main Ghost, else a review under the starter's own model.
 */
function initiativeReviewer(core: Core, starter: Ghost, assigneeId: string): Acceptance["reviewer"] {
  if (starter.id !== assigneeId) return { kind: "ghost", ghostId: starter.id };
  const main = core.ledger.defaultGhost();
  if (main && main.id !== assigneeId && main.state === "active" && main.deletedAt === null) return { kind: "ghost", ghostId: main.id };
  const model = starter.model ?? core.ledger.settings().defaultModel;
  return model ? { kind: "model", model } : null;
}

function scheduleSpec(at: string | undefined, everyMinutes: number | undefined) {
  if (at !== undefined && everyMinutes !== undefined) throw invalid("give either `at` or `every_minutes`, not both");
  if (at !== undefined) {
    const time = Date.parse(at);
    if (Number.isNaN(time)) throw invalid("`at` must be an ISO 8601 time");
    return { kind: "at", at: time } as const;
  }
  if (everyMinutes !== undefined) return { kind: "every", seconds: everyMinutes * 60, startAt: Date.now() } as const;
  throw invalid("give `at` for a one-off schedule or `every_minutes` for a repeating one");
}

function renderDetail(core: Core, work: Work, detail: WorkDetail): string {
  const parts = [
    describeWorkLine(core, work),
    `Brief: ${work.brief}`,
    work.acceptance.criteria ? `Done when: ${work.acceptance.criteria}` : "",
    detail.children.length ? `Children:\n${detail.children.map((child) => `  ${describeWorkLine(core, child)}`).join("\n")}` : "",
    detail.artifacts.length ? `Artifacts:\n${detail.artifacts.map((artifact) => `  - ${artifact.name} ${artifact.digest.slice(0, 12)} (${artifact.size} bytes)`).join("\n")}` : "",
    detail.effects.length ? `Effects:\n${detail.effects.map((effect) => `  - ${effect.tool} ${effect.summary} — ${effect.state}`).join("\n")}` : "",
    detail.decisions.length ? `Decisions:\n${detail.decisions.map((decision) => `  - ${decision.kind}: ${decision.title} — ${decision.state}${decision.answer ? `: ${decision.answer}` : ""}`).join("\n")}` : "",
  ];
  return parts.filter(Boolean).join("\n\n");
}
