import { defineTool, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CodingSession, OrchestrationAgent, OrchestrationConfig, OrchestrationModelRef } from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import { newId } from "../core/ids.ts";
import { modelChain } from "../orchestration/config.ts";
import { OrchestrationRouter } from "../orchestration/routing.ts";
import type { CodingModelSelection } from "./models.ts";
import type { Transcript } from "./transcript.ts";

type Task = { agent: string; task: string };
const MAX_CHILD_CALLS = 16;
const MAX_CHILD_MODEL_TURNS = 6;
const MAX_CHILD_OUTPUT = 8_000;
const MAX_CHILD_TOKENS = 32_000;
const MAX_CHILD_TIME = 120_000;

interface SubagentHost {
  cwd: string;
  transcript: Pick<Transcript, "display" | "receive">;
  workers: Set<string>;
  router: OrchestrationRouter;
  config(): OrchestrationConfig;
  sessionEnabled(): boolean;
  parentModel(): Pick<CodingSession, "model" | "thinking">;
  select(ref: OrchestrationModelRef): Promise<CodingModelSelection>;
  create(agent: OrchestrationAgent, selection: CodingModelSelection, extension: ExtensionFactory): Promise<AgentSession>;
  reviewPatch(): Promise<string>;
  account(input: number, output: number, cost: number): void;
}

export class Subagents {
  private readonly running = new Set<AbortController>();
  private admitted = 0;
  constructor(private readonly host: SubagentHost) {}

  startTurn(): void { this.admitted = 0; }
  abort(): void { for (const child of this.running) child.abort(); }

  extension(parent?: string, depth = 0): ExtensionFactory {
    return pi => {
      let previous: OrchestrationConfig | undefined;
      let wasEnabled: boolean | undefined;
      let offered = false;
      const refresh = (loading = false) => {
        const config = this.host.config();
        const enabled = config.enabled && this.host.sessionEnabled();
        const update = previous !== config || wasEnabled !== enabled;
        if (update) {
          previous = config;
          wasEnabled = enabled;
          const tool = enabled ? this.tool(parent, depth) : undefined;
          offered = tool !== undefined;
          if (tool) pi.registerTool(tool);
        }
        if (!loading) {
          const active = pi.getActiveTools();
          if (active.includes("subagent") !== offered) {
            pi.setActiveTools(offered ? [...active, "subagent"] : active.filter(name => name !== "subagent"));
          }
        }
      };
      refresh(true);
      pi.on("before_agent_start", () => { refresh(); });
      pi.on("turn_end", () => { refresh(); });
    };
  }

  private allowed(config: OrchestrationConfig, parent: string | undefined, depth: number): OrchestrationAgent[] {
    if (!config.enabled || !this.host.sessionEnabled() || depth >= config.limits.maxDepth) return [];
    if (parent === undefined) return config.agents;
    const agent = config.agents.find(agent => agent.name === parent);
    return config.agents.filter(child => agent?.canDelegateTo.includes(child.name));
  }

  tool(parent?: string, depth = 0) {
    const config = this.host.config();
    const agents = this.allowed(config, parent, depth);
    if (!agents.length) return undefined;
    const task = Type.Object({
      agent: Type.Enum(agents.map(agent => agent.name)),
      task: Type.String({ minLength: 1, maxLength: 2000 }),
    });
    const batch = Type.Array(task, { minItems: 1, maxItems: config.limits.maxConcurrency });
    return defineTool({
      name: "subagent", label: "Subagent",
      parameters: Type.Object({ tasks: Type.Optional(batch), chain: Type.Optional(batch) }),
      executionMode: "sequential",
      description: `Delegate bounded work in this worktree. tasks runs up to ${config.limits.maxConcurrency} read-only agents in parallel. chain runs in order and accepts writers; {previous} inserts the previous untrusted result. Available agents: ${agents.map(agent => `${agent.name} (${agent.readOnly ? "read-only" : "writer"}): ${agent.description}`).join("; ")}`,
      execute: async (_id, { tasks: parallel, chain }, signal) => {
        // Ghost and its delegated sessions can use the owner-approved settings but never edit them.
        // Recheck the live policy even if the model saw an older schema before the owner saved.
        const current = this.host.config();
        const available = this.allowed(current, parent, depth);
        if (!current.enabled || !this.host.sessionEnabled()) throw invalid("orchestration is disabled");
        if (depth >= current.limits.maxDepth) throw invalid("subagent depth limit reached");
        if (!!parallel === !!chain) throw invalid("provide exactly one of tasks or chain");
        const jobs = parallel ?? chain!;
        const cap = current.limits.maxConcurrency;
        if (jobs.length < 1 || jobs.length > cap || this.running.size + (parallel ? jobs.length : 1) > cap) throw invalid("subagent concurrency limit reached");
        const admitted = jobs.map(job => {
          const agent = available.find(agent => agent.name === job.agent);
          if (!agent) throw invalid(`delegation to ${job.agent} is not allowed`);
          if (parallel && !agent.readOnly) throw invalid("writers run in a chain, not in parallel");
          return agent;
        });
        if (this.admitted + jobs.length > Math.max(MAX_CHILD_CALLS, cap)) throw invalid("this turn reached its subagent limit");
        this.admitted += jobs.length;
        const result: string[] = [];
        if (parallel) result.push(...await Promise.all(parallel.map((job, index) => this.run(current, admitted[index]!, job, depth + 1, signal))));
        else {
          let previous = "";
          for (let index = 0; index < jobs.length; index++) {
            const job = jobs[index]!;
            const prompt = job.task.split("{previous}").join(previous).slice(0, 12_000);
            previous = await this.run(current, admitted[index]!, job, depth + 1, signal, prompt);
            result.push(previous);
          }
        }
        return { content: [{ type: "text", text: result.map((output, i) => `[${jobs[i]!.agent} · untrusted result]\n${output}`).join("\n\n").slice(0, 16_000) }], details: undefined };
      },
    });
  }

  private async run(config: OrchestrationConfig, agent: OrchestrationAgent, job: Task, depth: number, parentSignal?: AbortSignal, prompt = job.task): Promise<string> {
    parentSignal?.throwIfAborted();
    const { host } = this;
    const worker = !agent.readOnly;
    if (this.running.size >= config.limits.maxConcurrency) throw invalid("subagent concurrency limit reached");
    if (worker && host.workers.has(host.cwd)) throw invalid("another worker is writing in this worktree");
    if (worker) host.workers.add(host.cwd);
    const cancel = new AbortController();
    this.running.add(cancel);
    const timer = setTimeout(() => cancel.abort(new Error("subagent time limit reached")), MAX_CHILD_TIME);
    const signal = parentSignal ? AbortSignal.any([cancel.signal, parentSignal]) : cancel.signal;
    const id = `subagent:${newId()}`;
    const item = { id, kind: "subagent", at: Date.now(), role: agent.name, task: job.task, status: "running", summary: "" } as const;
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    const stop = () => { if (session) void session.abort().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      host.transcript.display(item);
      if (agent.name === "reviewer") {
        const patch = await host.reviewPatch();
        if (patch) prompt += `\n\n<untrusted_worktree_diff>\n${patch}\n</untrusted_worktree_diff>`;
      }
      signal.throwIfAborted();
      const chain = modelChain(config, agent.modelRole, host.parentModel());
      const route = await host.router.next(chain, 0, host.select);
      signal.throwIfAborted();
      session = await host.create(agent, route.selection, this.extension(agent.name, depth));
      signal.throwIfAborted();
      let turns = 0, output = 0, tokens = 0;
      let lastError: string | undefined;
      const charge = (input: number, generated: number, cost: number, total: number) => {
        host.account(input, generated, cost);
        output += generated;
        tokens += total;
      };
      session.agent.streamFunction = host.router.wrap(session.agent.streamFunction, chain, route, host.select, () => {
        const remaining = Math.min(MAX_CHILD_OUTPUT - output, MAX_CHILD_TOKENS - tokens);
        if (remaining <= 0 || ++turns > MAX_CHILD_MODEL_TURNS) throw new Error("subagent model budget exhausted");
        return remaining;
      }, charge, signal);
      unsubscribe = session.subscribe(event => {
        host.transcript.receive(event, id);
        if (event.type === "message_end" && event.message.role === "assistant") {
          const { usage, stopReason, errorMessage } = event.message;
          charge(usage.input, usage.output, usage.cost.total, usage.totalTokens);
          lastError = stopReason === "error" || stopReason === "length" ? errorMessage ?? `subagent stopped (${stopReason})` : undefined;
        }
      });
      await session.prompt(prompt, { source: "extension", expandPromptTemplates: false });
      signal.throwIfAborted();
      if (lastError) throw new Error(lastError);
      const summary = session.getLastAssistantText()?.slice(0, 4000) || "The subagent returned no final text.";
      host.transcript.display({ ...item, status: "done", summary });
      return summary;
    } catch (error) {
      const summary = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
      host.transcript.display({ ...item, status: "error", summary });
      return summary;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      unsubscribe?.();
      session?.dispose();
      this.running.delete(cancel);
      if (worker) host.workers.delete(host.cwd);
    }
  }
}
