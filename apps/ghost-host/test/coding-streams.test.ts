import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingAgents } from "../src/integrations/coding-agents.ts";
import type { CodingAgentInfo } from "../src/integrations/ports.ts";

const coding = new CodingAgents(join(tmpdir(), "ghost-coding-streams-unused"));
const agent = (id: CodingAgentInfo["id"]): CodingAgentInfo => ({ id, name: id, path: `/bin/${id}`, version: null, ready: true, note: null });
const lines = (...events: unknown[]) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

// Shapes captured from omp 19 `--mode json`, Claude Code 2.1 `--output-format stream-json` and Codex 0.167 `exec --json`.

test("omp: the session id, what it ran, what came back and its closing message", () => {
  const stream = coding.stream(agent("omp"));
  const events = stream.feed(lines(
    { type: "session", version: 3, id: "01a1fce5", cwd: "/tmp/st" },
    { type: "message_start", message: { role: "user", content: [{ type: "text", text: "run ls" }] } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "run ls" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }] } },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
    { type: "tool_execution_update", toolName: "bash", partialResult: { content: [{ type: "text", text: "partial" }] } },
    { type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "a.txt\nb.txt" }], details: { trace: { huge: true } } } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "a.txt\nb.txt" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Two files." }] } },
    { type: "agent_end", messages: [] },
  ));
  expect(events).toEqual([
    { kind: "tool", text: "bash: ls" },
    { kind: "result", text: "a.txt\nb.txt" },
    { kind: "say", text: "Two files." },
  ]);
  expect(stream.nativeId).toBe("01a1fce5");
  expect(stream.final).toBe("Two files.");
});

test("Claude Code: tool calls, tool results as strings or blocks, and the result event", () => {
  const stream = coding.stream(agent("claude"));
  const events = stream.feed(lines(
    { type: "system", subtype: "init", session_id: "7e592e65", tools: ["Bash"] },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "ls", description: "List files" } }] } },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "a.txt", is_error: false }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u2", content: [{ type: "text", text: "from blocks" }] }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done.", session_id: "7e592e65" },
  ));
  expect(events).toEqual([
    { kind: "tool", text: "Bash: ls" },
    { kind: "result", text: "a.txt" },
    { kind: "result", text: "from blocks" },
    { kind: "say", text: "Done." },
  ]);
  expect(stream.nativeId).toBe("7e592e65");
  expect(stream.final).toBe("Done.");
});

test("Claude Code: an error result is shown as a note", () => {
  const stream = coding.stream(agent("claude"));
  expect(stream.feed(lines({ type: "result", is_error: true, result: "Credit balance is too low", session_id: "s1" }))).toEqual([{ kind: "note", text: "Credit balance is too low" }]);
});

test("Codex: the thread id, commands with their output and exit code, edits, and its closing message", () => {
  const stream = coding.stream(agent("codex"));
  const events = stream.feed(lines(
    { type: "thread.started", thread_id: "01a1fce5-9156" },
    { type: "item.completed", item: { id: "i0", type: "error", message: "Under-development features enabled" } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i1", type: "agent_message", text: "I'll run ls." } },
    { type: "item.started", item: { id: "i2", type: "command_execution", command: "/bin/zsh -lc ls", aggregated_output: "", exit_code: null, status: "in_progress" } },
    { type: "item.completed", item: { id: "i2", type: "command_execution", command: "/bin/zsh -lc ls", aggregated_output: "a.txt\n", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "i3", type: "command_execution", command: "false", aggregated_output: "", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "i4", type: "file_change", changes: [{ path: "b.txt", kind: "add" }] } },
    { type: "item.completed", item: { id: "i5", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 1 } },
  ));
  expect(events).toEqual([
    { kind: "say", text: "I'll run ls." },
    { kind: "tool", text: "bash: /bin/zsh -lc ls" },
    { kind: "result", text: "a.txt" },
    { kind: "result", text: "(exit 1)" },
    { kind: "tool", text: "edit: b.txt (add)" },
    { kind: "say", text: "done" },
  ]);
  expect(stream.nativeId).toBe("01a1fce5-9156");
  expect(stream.final).toBe("done");
});

test("chunks may end mid-line, noise between events is skipped, and the last unterminated line is read on flush", () => {
  const stream = coding.stream(agent("omp"));
  const line = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
  expect(stream.feed(`Warning: not json\n${line.slice(0, 30)}`)).toEqual([]);
  expect(stream.feed(`${line.slice(30)}\n${line}`)).toEqual([{ kind: "say", text: "hello" }]);
  expect(stream.flush()).toEqual([{ kind: "say", text: "hello" }]);
  expect(stream.flush()).toEqual([]);
});

test("an event shape the Host does not know is skipped, never thrown on", () => {
  const stream = coding.stream(agent("omp"));
  expect(stream.feed(lines({ type: "message_end", message: { role: "assistant", content: 7 } }, { type: 1 }, [1, 2], "text", null))).toEqual([]);
});
