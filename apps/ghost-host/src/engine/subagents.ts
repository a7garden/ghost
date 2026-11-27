import { defineDoc, GenerationTask, type GenerationCheckpoint, type GenerationHooks, type GenerationInput, type GenerationResult, type PhaseHandler, type RegistryReader } from "@earendil-works/pi-durable";
import type { ModelRef } from "@ghost/contract";
import type { Core } from "../core/core.ts";

/** Creation and the call-to-child mapping share one Pi commit, including crash recovery. */
export const HelpersDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "ghost.helpers", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): { byCall: Record<string, number> } => ({ byCall: {} }),
});

export type HelperRole = { modelRole: string; instructions: string; models: ModelRef[] };

export function helperRole(core: Core, id: string): HelperRole | null {
  return core.ledger.setting<HelperRole | null>(`subagent:role:${id}`, null);
}

/** Only the failed attempt is retried on the next model. Charge its usage even though Pi omits errors from model context. */
export const HelperRouteDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "ghost.helper-route", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ index: 0, failedTurns: 0, failedTokens: 0 }),
});

/** A named helper lets the Host, not Pi's same-model backoff, handle generation errors. */
export function subagentRegistry(registry: RegistryReader, core: Core): RegistryReader {
  const base = registry.snapshot().task(GenerationTask.definition.name) as typeof GenerationTask;
  const original = base.definition;
  type Phase<P extends GenerationCheckpoint> = PhaseHandler<GenerationInput, P, GenerationCheckpoint, GenerationResult, GenerationHooks>;
  function noRetry<P extends GenerationCheckpoint>(handler: Phase<P>): Phase<P> {
    return (task, runtime, context) => {
      const host = core.ledger.conversationByPiId(String(runtime.conversationId));
      if (host?.kind === "subagent" && helperRole(core, host.id)) {
        const settings = runtime.settings;
        Object.defineProperty(runtime, "settings", { configurable: true, value: {
          ...settings, retry: { ...settings.retry, enabled: false }, stream: { ...settings.stream, maxRetries: 0 },
        } });
      }
      return handler(task, runtime, context);
    };
  }
  const generation = { ...base, definition: { ...original, phases: {
    ...original.phases, request: noRetry(original.phases.request), poll: noRetry(original.phases.poll),
  } } };
  return {
    subscribe: registry.subscribe.bind(registry),
    snapshot() {
      const snapshot = registry.snapshot();
      return new Proxy(snapshot, {
        get(target, key) {
          if (key === "task") return (name: string) => name === original.name ? generation : target.task(name);
          if (key === "tasks") return () => target.tasks().map(task => task.definition.name === original.name ? generation : task);
          const member = Reflect.get(target, key, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    },
  };
}

/** Promotion is atomic with the passive assistant entry in the owner's transcript. */
export const WakeRepliesDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "ghost.wake-replies", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): { byWake: Record<string, true> } => ({ byWake: {} }),
});
