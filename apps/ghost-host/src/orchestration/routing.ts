import { CommandError } from "../core/errors.ts";
import { quotaHit, type QuotaHit } from "../engine/fallback.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { OrchestrationModelRef } from "@ghost/contract";
import type { CodingModelSelection } from "../coding/models.ts";

const key = (ref: OrchestrationModelRef) => `${ref.provider}/${ref.model}`;
type Stream = AgentSession["agent"]["streamFunction"];
type Select = (ref: OrchestrationModelRef) => Promise<CodingModelSelection>;
type Route = { index: number; selection: CodingModelSelection };

/** A quota settles the current generation, not the task. Never replay a prompt or tool side effect. */
export class OrchestrationRouter {
  private readonly quotas = new Map<string, QuotaHit>();

  async next(chain: OrchestrationModelRef[], start: number, select: Select): Promise<Route> {
    let failure: unknown;
    const now = Date.now();
    for (let index = start; index < chain.length; index++) {
      const ref = chain[index]!;
      const id = key(ref);
      const quota = this.quotas.get(id);
      if (quota?.resumeAt && quota.resumeAt > now) { failure = new CommandError("unavailable", quota.reason); continue; }
      if (quota) this.quotas.delete(id);
      try { return { index, selection: await select(ref) }; }
      catch (error) {
        if (!(error instanceof CommandError) || (error.code !== "invalid" && error.code !== "unavailable")) throw error;
        failure = error;
      }
    }
    throw failure ?? new CommandError("unavailable", "no usable orchestration model");
  }

  wrap(stream: Stream, chain: OrchestrationModelRef[], initial: Route, select: Select,
    budget: () => number, charge: (input: number, output: number, cost: number, tokens: number) => void, signal: AbortSignal): Stream {
    let route = initial;
    return async (_model, context, options) => {
      const requestSignal = options?.signal ? AbortSignal.any([options.signal, signal]) : signal;
      for (;;) {
        requestSignal.throwIfAborted();
        const { model, thinking } = route.selection;
        const maxTokens = Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens, budget());
        const reply = await stream(model, context, { ...options, apiKey: undefined, headers: undefined, env: undefined,
          reasoning: thinking === "off" ? undefined : thinking, signal: requestSignal, maxTokens });
        if (route.index + 1 >= chain.length) {
          // The same health hint should steer later children even for the last model in this chain.
          void reply.result().then(message => { this.remember(chain[route.index]!, quotaHit(message)); });
          return reply;
        }
        const message = await reply.result();
        const quota = quotaHit(message);
        this.remember(chain[route.index]!, quota);
        if (!quota || requestSignal.aborted) return reply;
        let replacement: typeof route;
        try { replacement = await this.next(chain, route.index + 1, select); }
        catch (error) { if (error instanceof CommandError) return reply; throw error; }
        // Do not charge the final reply here; Pi will account for that message on settlement.
        charge(message.usage.input, message.usage.output, message.usage.cost.total, message.usage.totalTokens);
        route = replacement;
      }
    };
  }

  private remember(ref: OrchestrationModelRef, quota: QuotaHit | null): void {
    const id = key(ref);
    if (quota?.resumeAt) this.quotas.set(id, quota);
    else this.quotas.delete(id);
  }
}
