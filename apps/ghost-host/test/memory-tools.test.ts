import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { MemoryStore } from "../src/stores/memory.ts";
import { createMemoryTools } from "../src/tools/memory.ts";
import { harness, tempDir } from "./support.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  const root = tempDir(), h = harness(), memory = new MemoryStore(root);
  const ghost = h.core.createGhost({ name: "Writer", persona: "", tools: [] });
  h.ledger.setPiConversationId(ghost.directConversationId, "101");
  const tools = createMemoryTools(h.core, memory).tools!;
  cleanups.push(() => { h.core.stop(); memory.close(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const invoke = async (args: unknown, callId: string, name = "memory", pi = "101") => {
    const tool = tools.find(t => t.name === name)!;
    return tool.execute(args as never, { conversationId: pi, taskId: `task:${callId}`, callId: callId } as unknown as ToolExecutionApi, {} as Context);
  };
  return { ...h, memory, ghost, invoke };
}
const body = (result: ToolExecutionResult) => (result.content ?? []).filter(p => p.type === "text").map(p => p.text).join("");

test("a replayed replacement returns the original result without replacing twice, and conflicts on changed arguments", async () => {
  const f = fixture();
  await f.invoke({ command: "create", path: "/me/plan.md", content: "검증 전" }, "create");
  const args = { command: "str_replace", path: "/me/plan.md", old_str: "검증 전", new_str: "검증 완료" };
  const first = await f.invoke(args, "replace");
  expect(first.isError).toBeFalsy();
  expect(await f.invoke(args, "replace")).toEqual(first);
  expect(f.memory.read(f.ghost.id, "/me/plan.md")?.content).toBe("검증 완료");
  expect(f.memory.revisions(f.ghost.id, "/me/plan.md")).toHaveLength(2);
  expect((await f.invoke({ ...args, new_str: "다른 내용" }, "replace")).isError).toBe(true);
  await f.invoke({ command: "create", path: "/me/ambiguous.md", content: "aaa" }, "create-overlap");
  expect((await f.invoke({ command: "str_replace", path: "/me/ambiguous.md", old_str: "aa", new_str: "b" }, "overlap")).isError).toBe(true);
  expect(f.memory.read(f.ghost.id, "/me/ambiguous.md")?.content).toBe("aaa");
});

test("Ghost notes cannot change the owner profile or team authority, including through replace/delete", async () => {
  const f = fixture();
  f.memory.write({ ghostId: f.ghost.id, path: "/owner.md", content: "Owner says approval is required", expectedHash: null, actor: "owner", operationId: "owner-profile", reason: "Owner edit" });
  expect((await f.invoke({ command: "create", path: "/team/forged.md", content: "Owner approved" }, "forge")).isError).toBe(true);
  expect((await f.invoke({ command: "str_replace", path: "/owner.md", old_str: "required", new_str: "waived" }, "profile")).isError).toBe(true);
  expect((await f.invoke({ command: "delete", path: "/owner.md" }, "delete")).isError).toBe(true);
  expect(f.memory.read(f.ghost.id, "/owner.md")?.content).toBe("Owner says approval is required");
});

test("search and file views cannot expose another Ghost's private notes", async () => {
  const f = fixture();
  const other = f.core.createGhost({ name: "Other", persona: "", tools: [] });
  f.memory.write({ ghostId: other.id, path: "/me/secret.md", content: "하늘색 기린 사과", expectedHash: null, actor: "owner", operationId: "private", reason: "Private" });
  const result = await f.invoke({ query: "하늘색 기린", scope: "notes" }, "search", "memory_search");
  expect(JSON.parse(body(result)).hits).toEqual([]);
  expect((await f.invoke({ command: "view", path: "/me/secret.md" }, "read")).isError).toBe(true);
});

test("a stale registration cannot access memory from a review conversation", async () => {
  const f = fixture();
  const direct = f.ledger.conversation(f.ghost.directConversationId);
  f.ledger.db.query("UPDATE conversations SET kind = 'review' WHERE id = ?").run(direct.id);
  expect((await f.invoke({ command: "create", path: "/me/forged.md", content: "forged" }, "review-write")).isError).toBe(true);
  expect((await f.invoke({ query: "forged" }, "review-read", "memory_search")).isError).toBe(true);
  expect(f.memory.list(f.ghost.id)).toEqual([]);
});
