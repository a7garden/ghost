import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc, defineDoc, GenerationTask, InboxDoc, LiveDoc,
  type GenerationCheckpoint, type GenerationHooks, type GenerationInput, type GenerationResult,
  type ConversationId, type Harness, type PhaseHandler, type Registry, type RegistryReader,
} from "@earendil-works/pi-durable";
import { memoryModels } from "./stream.ts";

export const MEMORY_MARKER = "Host memory evidence consolidation (no tools)";
export const MemoryConversationDoc = defineDoc<{ runId: string; deadline: number; requests: number }>({
  kind: "host.memory-conversation", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ runId: "", deadline: 0, requests: 0 }),
});

type GenerationPhase<P extends GenerationCheckpoint> = PhaseHandler<GenerationInput, P, GenerationCheckpoint, GenerationResult, GenerationHooks>;

/** Preserve Pi's real generation/classification; change only this conversation's runtime policy. */
function memoryPhase<P extends GenerationCheckpoint>(handler: GenerationPhase<P>): GenerationPhase<P> {
  return async (task, runtime, context) => {
    const binding = await runtime.snapshot(MemoryConversationDoc, runtime.conversationId, context);
    if (!binding?.runId) return handler(task, runtime, context);
    let rejection: string | undefined;
    if (runtime.now() >= binding.deadline) rejection = "memory generation deadline exceeded";
    else if (task.state.checkpoint.phase === "poll" || task.state.checkpoint.phase === "retry" || task.state.checkpoint.phase === "tools") rejection = "memory run does not permit deferred polling, retries or tool continuation";
    else if (task.state.checkpoint.phase === "request") {
      let admitted = false;
      await runtime.commit(async (tx) => {
        const budget = await tx.doc(MemoryConversationDoc, runtime.conversationId);
        if (budget.requests === 0) { budget.requests = 1; admitted = true; }
        return undefined;
      }, context);
      if (!admitted) rejection = "memory run already reserved its single provider request";
    }
    if (rejection) {
      const reason = rejection;
      await runtime.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, runtime.conversationId);
        for (const id of live.run?.inputs ?? []) tx.settleSubmission(id, { status: "unanswered", reason: "memory_policy", detail: reason });
        delete live.run;
        delete live.generation;
        return { status: "terminal", outcome: { status: "failed", error: { message: reason } } };
      }, context);
      return;
    }
    const settings = runtime.settings;
    const policy = {
      ...settings,
      retry: { ...settings.retry, enabled: false, maxRetries: 0 },
      compaction: { ...settings.compaction, enabled: false, backgroundTokens: 0 },
      stream: { ...settings.stream, maxRetries: 0, deferred: false as const },
    };
    const models = memoryModels(runtime.models, binding.deadline);
    const bounded = new Proxy(runtime, {
      get(target, key) {
        if (key === "settings") return policy;
        if (key === "models") return models;
        const member = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    await handler(task, bounded, context);
  };
}

/** RegistryReader is the public task-definition boundary; ordinary Ghost phases are unchanged. */
export function memoryRegistry(registry: Registry): RegistryReader {
  const original = GenerationTask.definition;
  const generation = { definition: { ...original, phases: {
    prepare: memoryPhase(original.phases.prepare), request: memoryPhase(original.phases.request),
    retry: memoryPhase(original.phases.retry), poll: memoryPhase(original.phases.poll), tools: memoryPhase(original.phases.tools),
  } } };
  return {
    subscribe: registry.subscribe.bind(registry),
    snapshot() {
      const snapshot = registry.snapshot();
      return new Proxy(snapshot, {
        get(target, key) {
          if (key === "task") return (name: string) => name === original.name ? generation : target.task(name);
          if (key === "tasks") return () => target.tasks().map((task) => task.definition.name === original.name ? generation : task);
          const member = Reflect.get(target, key, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    },
  };
}

/** Called while Harness scheduling is still disabled, before any submit/wait/resume can enable it. */
export async function gateRecoveredDreams(harness: Harness, isHostConversation: (id: ConversationId) => boolean): Promise<void> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  const candidates = new Set([...inspection.tasks.map((task) => task.record.conversationId), ...inspection.submissions.map((submission) => submission.conversationId)]);
  const dreams = new Set<number>();
  for (const id of candidates) {
    if (isHostConversation(id)) continue;
    const binding = await harness.snapshot(MemoryConversationDoc, id, BACKGROUND_CONTEXT);
    const agent = binding?.runId ? null : await harness.snapshot(AgentDoc, id, BACKGROUND_CONTEXT);
    if (binding?.runId || agent?.instructions?.startsWith(MEMORY_MARKER)) dreams.add(id);
  }
  // abortTask marks durably but, unlike Conversation.abort(), does not enable scheduling.
  for (const task of inspection.tasks) if (dreams.has(task.record.conversationId)) await harness.abortTask(task.record.id, BACKGROUND_CONTEXT);
  await harness.commit(async (tx) => {
    for (const submission of inspection.submissions) if (dreams.has(submission.conversationId)) tx.settleSubmission(submission.id, { status: "unanswered", reason: "host_restart", detail: "Interrupted memory generation was cancelled before shared harness resume" });
    for (const id of candidates) if (dreams.has(id)) {
      (await tx.doc(InboxDoc, id)).items = [];
      const live = await tx.doc(LiveDoc, id);
      delete live.run;
      delete live.generation;
    }
  }, BACKGROUND_CONTEXT);
}
