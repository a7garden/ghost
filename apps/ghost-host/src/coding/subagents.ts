import { defineTool, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { invalid } from "../core/errors.ts";
import { newId } from "../core/ids.ts";
import type { Transcript } from "./transcript.ts";

const roles = {
  scout: "Read files and search the repository without changing it. Return a compact map of the relevant code, paths and evidence.",
  worker: "Implement only the requested change in this worktree. Preserve unrelated edits. Report what changed and any checks you actually ran.",
  reviewer: "Review the requested diff or files read-only. Report actionable issues with severity, evidence, and file locations; distinguish observations from inference.",
};
const task = Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("worker"), Type.Literal("reviewer")]), task: Type.String({ minLength: 1, maxLength: 2000 }) });
type Task = Static<typeof task>;
export type SubagentRole = Task["role"];
const tasks = Type.Object({ tasks: Type.Optional(Type.Array(task, { minItems: 1, maxItems: 4 })), chain: Type.Optional(Type.Array(task, { minItems: 1, maxItems: 4 })) });
const MAX_CHILD_CALLS = 16;
const MAX_CHILD_MODEL_TURNS = 6;
const MAX_CHILD_OUTPUT = 8_000;
const MAX_CHILD_TOKENS = 32_000;
const MAX_CHILD_TIME = 120_000;

interface SubagentHost {
  cwd: string;
  transcript: Transcript;
  workers: Set<string>;
  create(role: SubagentRole, instructions: string): Promise<AgentSession>;
  reviewPatch(): Promise<string>;
  account(input: number, output: number, cost: number): void;
}

export class Subagents {
  private readonly running = new Set<AbortController>();
  private admitted = 0;
  constructor(private readonly host: SubagentHost) {}

  startTurn(): void { this.admitted = 0; }
  abort(): void { for (const child of this.running) child.abort(); }

  tool() {
    return defineTool({
      name: "subagent", label: "Subagent", parameters: tasks, executionMode: "sequential",
      description: "Delegate bounded work in this worktree. tasks runs up to four read-only scout/reviewer tasks in parallel. chain runs stages in order (including worker); {previous} inserts the previous stage's untrusted result. Children cannot delegate.",
      execute: async (_id, args, signal) => {
        const { tasks: parallel, chain } = args;
        if (!!parallel === !!chain) throw invalid("provide exactly one of tasks or chain");
        const jobs = parallel ?? chain!;
        if (parallel?.some(job => job.role === "worker")) throw invalid("workers run in a chain, not in parallel");
        if (this.admitted + jobs.length > MAX_CHILD_CALLS) throw invalid("this turn reached its subagent limit");
        this.admitted += jobs.length;
        const result: string[] = [];
        if (parallel) result.push(...await Promise.all(parallel.map(job => this.run(job, signal))));
        else {
          let previous = "";
          for (const job of jobs) {
            signal?.throwIfAborted();
            const prompt = job.task.split("{previous}").join(previous).slice(0, 12_000);
            previous = await this.run(job, signal, prompt);
            result.push(previous);
          }
        }
        return { content: [{ type: "text", text: result.map((output, i) => `[${jobs[i]!.role} · untrusted result]\n${output}`).join("\n\n").slice(0, 16_000) }], details: undefined };
      },
    });
  }

  private async run(job: Task, parentSignal?: AbortSignal, prompt = job.task): Promise<string> {
    parentSignal?.throwIfAborted();
    const { host } = this;
    const worker = job.role === "worker";
    if (worker && host.workers.has(host.cwd)) throw invalid("another worker is writing in this worktree");
    if (worker) host.workers.add(host.cwd);
    const cancel = new AbortController();
    this.running.add(cancel);
    const timer = setTimeout(() => cancel.abort(new Error("subagent time limit reached")), MAX_CHILD_TIME);
    const signal = parentSignal ? AbortSignal.any([cancel.signal, parentSignal]) : cancel.signal;
    const id = `subagent:${newId()}`;
    const item = { id, kind: "subagent", at: Date.now(), role: job.role, task: job.task, status: "running", summary: "" } as const;
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    const stop = () => { if (session) void session.abort().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      host.transcript.display(item);
      if (job.role === "reviewer") {
        const patch = await host.reviewPatch();
        if (patch) prompt += `\n\n<untrusted_worktree_diff>\n${patch}\n</untrusted_worktree_diff>`;
      }
      signal.throwIfAborted();
      session = await host.create(job.role, roles[job.role]);
      signal.throwIfAborted();
      let turns = 0, output = 0, tokens = 0;
      let lastError: string | undefined;
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (model, context, options) => {
        signal.throwIfAborted();
        const remaining = Math.min(MAX_CHILD_OUTPUT - output, MAX_CHILD_TOKENS - tokens);
        if (remaining <= 0 || ++turns > MAX_CHILD_MODEL_TURNS) throw new Error("subagent model budget exhausted");
        return stream(model, context, { ...options, maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, remaining) });
      };
      unsubscribe = session.subscribe(event => {
        host.transcript.receive(event, id);
        if (event.type === "message_end" && event.message.role === "assistant") {
          const { usage, stopReason, errorMessage } = event.message;
          host.account(usage.input, usage.output, usage.cost.total);
          output += usage.output;
          tokens += usage.totalTokens;
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
