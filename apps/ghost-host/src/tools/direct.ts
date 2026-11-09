import { Type } from "typebox";
import type { Ghost, Work, WorkDetail } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { invalid } from "../core/errors.ts";
import { idFor } from "../core/ids.ts";
import { workDetail } from "../core/state.ts";
import { askOwnerTool, describeWorkLine, errorResult, firstLine, requireAllowed, requireOrigin, type Scope } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/** Works created here (their whole tree) plus this Ghost's live Work, one compact line each. */
function visibleWorks(core: Core, scope: Scope): Work[] {
  const { ledger } = core;
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
    description: "Create a Work from an explicit owner task and report it to this conversation. The Work runs in its own conversation.",
    parameters: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 256, description: "Short name of the Work" }),
      brief: Type.String({ minLength: 1, maxLength: 32768, description: "What to do, with everything the assignee needs" }),
      criteria: Type.Optional(Type.String({ maxLength: 8192, description: "When the Work is done" })),
      ghost_id: Type.Optional(Type.String({ description: "Assignee Ghost; defaults to this Ghost" })),
      deadline_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "Deadline in minutes from now" })),
      owner_accepts: Type.Optional(
        Type.Boolean({ description: "true only when the owner said they want to check the result themselves; otherwise a reviewer judges it and the owner is told the outcome" }),
      ),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_create");
        const work = core.works.createRoot({
          ghostId: args.ghost_id ?? scope.ghost.id,
          title: args.title,
          brief: args.brief,
          // 2026-11-09: a reviewer, not the owner, by default. Owner acceptance stopped every Work at its end.
          acceptance: { criteria: args.criteria ?? "", checks: [], reviewer: null, owner: args.owner_accepts === true },
          deadlineAt: args.deadline_minutes === undefined ? null : Date.now() + args.deadline_minutes * 60_000,
          originConversationId: scope.conversation.id,
          id: idFor(scope.conversation.id, api.callId),
        });
        const assignee = core.ledger.ghost(work.ghostId).name;
        return text(`Work "${work.title}" created (${work.id}), assigned to ${assignee}. It reports back here when it settles.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const workList = defineTool({
    name: "work_list",
    description: "List the Work created in this conversation and this Ghost's live Work.",
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
    description: "Inspect one Work: its tree, effects, artifacts and decisions.",
    parameters: Type.Object({ work_id: Type.String({ minLength: 1, description: "The Work's id" }) }),
    replay: "safe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_inspect");
        const work = core.ledger.work(args.work_id);
        const root = work.rootId === work.id ? work : core.ledger.work(work.rootId);
        const assignedHere = work.ghostId === scope.ghost.id;
        if (root.originConversationId !== scope.conversation.id && !assignedHere) {
          throw invalid("this Work neither originates from this conversation nor is assigned to this Ghost");
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
    description: "Edit a Work created in this conversation: title, brief, done-criteria or deadline.",
    parameters: Type.Object({
      work_id: Type.String({ minLength: 1, description: "The Work's id" }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      brief: Type.Optional(Type.String({ minLength: 1, maxLength: 32768 })),
      criteria: Type.Optional(Type.String({ maxLength: 8192, description: "Replaces the done-criteria; checks and reviewer are not editable here" })),
      deadline_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "New deadline in minutes from now" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "work_update");
        const work = requireOrigin(core, scope, args.work_id);
        const acceptance = args.criteria === undefined ? undefined : { ...work.acceptance, criteria: args.criteria };
        const next = core.works.update(work.id, {
          title: args.title,
          brief: args.brief,
          acceptance,
          deadlineAt: args.deadline_minutes === undefined ? undefined : Date.now() + args.deadline_minutes * 60_000,
        });
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
    tools: [workCreate, workList, workInspect, workUpdate, workCancel, askOwnerTool(core), scheduleCreate, scheduleList, scheduleCancel, ghostList],
  });
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
