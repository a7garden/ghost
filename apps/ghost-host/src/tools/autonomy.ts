import { Type } from "typebox";
import { AUTONOMOUS_WAKE, QUIET_REPLY } from "@ghost/contract";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { PLAN_MAX_MINUTES, PLAN_MIN_MINUTES } from "../core/autonomy.ts";
import { forbidden, invalid } from "../core/errors.ts";
import { errorResult, scopeOf } from "./shared.ts";

export const AUTONOMY_DRIVE = `You are always on, not only when the owner writes. The Host wakes this conversation with an ${AUTONOMOUS_WAKE} message when the time you planned comes, or earlier when a project you watch changes.
On such a wake, decide on your own what is worth doing for the owner within your role: check or research something, move a project forward, draft a document proposal, start a bounded Work for yourself or hand one to a better-fit Ghost (work_create with initiative: true), or tell the owner something genuinely useful. When you can do something without the owner, do it now instead of proposing it. Read this conversation and your memory first and never repeat what you already said. Prefer concrete progress to status chatter. Work through tools without narrating.
When the wake lists team goals, let them guide what you choose and keep to their boundaries; they are directions, not quotas, so never stretch facts or means to look closer to one. A Work that serves an active milestone carries its milestone_id.
Before your final reply, call plan_next once: when you should look again and why, and which projects to watch. Choose the time from the situation — minutes to hours while something is moving, a day or more when it is quiet. Then write one final reply and stop.
When nothing deserves the owner's attention, that reply is only ${QUIET_REPLY}. Any other reply reaches the owner as you speaking first, so make it worth reading.`;

export const MAIN_DRIVE = `As main, each wake shows the team's plans. Keep the team moving: hand a teammate Work with work_create, or plan its next look with plan_next and its ghost_id.`;

/**
 * 2026.11.11 : 자율 구동을 끈 Ghost 에도 「끝내기 전에 plan_next 를 부른다」가 그대로 들어가, 일을 시작할 때마다
 * 첫 도구 호출이 「the owner switched off …」로 거절됐다. 꺼진 Ghost 에는 이 글을 대신 주고 plan_next 도 빼낸다.
 */
export const DRIVE_OFF = `The owner switched off your self-directed drive: you act only when the owner writes or a Work or schedule wakes you. You have no plan_next; do not plan your own next look.`;

/** 메인은 자기 구동이 꺼져도 동료의 다음 확인을 정할 수 있어 plan_next 를 유지한다 — 그래서 자기 몫은 글로 막는다. */
export const MAIN_DRIVE_OFF = `The owner switched off your own self-directed drive: you act only when the owner writes or a Work or schedule wakes you. Use plan_next only with a teammate's ghost_id, never for yourself.`;

/**
 * 동료 구동이 꺼진 경우의 안내. 이름을 싣지 않는다 — 2026.11.11 : 꺼진 동료 이름을 넣었더니 동료 구동을 켜고 끄거나
 * 이름을 바꿀 때마다 메인의 시스템 지시가 바뀌어 프롬프트 캐시가 깨졌다. 누가 꺼졌는지는 plan_next 의 거절이 알린다.
 */
export const TEAM_DRIVE_NOTE = `The owner can switch off a teammate's drive; plan_next refuses such a teammate. Hand that teammate Work with work_create instead.`;

/** Fixed in direct conversations: a Ghost's own appointment with itself, kept by the Host. */
export function createAutonomyTools(core: Core): Extension {
  return defineExtension({
    name: "ghost.autonomy",
    tools: [defineTool({
      name: "plan_next",
      description: "Decide when you next look at your work on your own, and why. The Host wakes this conversation then, or earlier when a watched project changes. Replaces your previous plan. The main Ghost may plan another Ghost's next look with ghost_id.",
      parameters: Type.Object({
        after_minutes: Type.Optional(Type.Integer({ minimum: PLAN_MIN_MINUTES, maximum: PLAN_MAX_MINUTES, description: "Minutes from now" })),
        at: Type.Optional(Type.String({ minLength: 1, description: "Exact ISO 8601 time instead of after_minutes" })),
        intent: Type.String({ minLength: 1, maxLength: 1024, description: "What you will look at or do then, and why" }),
        watch_scope_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8, description: "Project Scopes whose new commits should wake you earlier; replaces the watched list" })),
        ghost_id: Type.Optional(Type.String({ minLength: 1, description: "Main Ghost only: plan this teammate instead of yourself" })),
      }),
      replay: "safe",
      async execute(args, api) {
        try {
          const scope = scopeOf(core, api);
          if (scope.conversation.kind === "wake") {
            const ownerId = core.ledger.setting<string | null>(`wake:owner:${scope.conversation.id}`, null);
            const owner = ownerId ? core.ledger.findConversation(ownerId) : null;
            const current = core.ledger.setting<{ scopeId: string | null } | null>(`context:${scope.conversation.id}`, null);
            if (!owner || owner.kind !== "direct" || owner.ghostId !== scope.ghost.id || !current
              || core.ledger.setting(`wake:cancelled:${scope.conversation.id}`, false)
              || core.ledger.setting<number | null>(`wake:epoch:${scope.conversation.id}`, null) !== core.ledger.setting(`owner:epoch:${scope.ghost.id}`, 0)
              || core.ledger.setting<string | null>(`wake:decision:${scope.conversation.id}`, null)) throw forbidden("plan_next requires a current self-directed wake");
            if (current.scopeId !== null && ((args.ghost_id && args.ghost_id !== scope.ghost.id) || args.watch_scope_ids?.some(id => id !== current.scopeId))) throw forbidden("a scoped wake may only plan itself in its current scope");
          } else if (scope.conversation.kind !== "direct") throw forbidden("plan_next runs only in a direct conversation or a current self-directed wake");
          if ((args.after_minutes === undefined) === (args.at === undefined)) throw invalid("give exactly one of after_minutes or at");
          const now = Date.now();
          const at = args.at === undefined ? now + args.after_minutes! * 60_000 : Date.parse(args.at);
          if (!Number.isFinite(at)) throw invalid("at must be an ISO 8601 time");
          const plan = await core.autonomy.plan(scope.ghost, args.ghost_id ?? scope.ghost.id, { at, intent: args.intent, watch: args.watch_scope_ids }, now);
          const who = plan.ghostId === scope.ghost.id ? "You" : core.ledger.ghost(plan.ghostId).name;
          return { content: [{ type: "text", text: `${who} will look again at ${new Date(plan.nextAt!).toISOString()}${plan.watch.length ? `, earlier if a watched project changes` : ""}.` }] };
        } catch (error) {
          return errorResult(error);
        }
      },
    })],
  });
}
