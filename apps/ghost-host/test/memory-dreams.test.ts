import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { Type, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Message } from "@ghost/contract";
import { Database } from "bun:sqlite";
import { createEngine } from "../src/engine/index.ts";
import { MemoryStore } from "../src/stores/memory.ts";
import { commitProposal, MemoryDreams, memoryIndex, memorySnapshot, readProposal } from "../src/memory/dreams.ts";
import { memoryPrompt } from "../src/memory/pi.ts";
import type { MemoryEngine } from "../src/memory/types.ts";
import { MEMORY_OUTPUT_BYTES, memoryModels } from "../src/memory/stream.ts";
import { harness } from "./support.ts";

function memoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "ghost-memory-dreams-"));
  const memory = new MemoryStore(root);
  const source = { conversationId: "conversation", messageId: "owner-1", quote: "모든 대화는 Host에서 실행한다." };
  const message: Message = { id: source.messageId, conversationId: source.conversationId, role: "user", origin: "owner", text: source.quote, createdAt: 1, toolCalls: [], tool: null, attachments: [] };
  memory.indexMessage("ghost", message);
  const snapshot = memorySnapshot(memory, "ghost", 0);
  const output = JSON.stringify({ changes: [{ path: "/me/architecture.md", content: "# Architecture\nRun all conversations in Host.", sources: [source], reason: "Retain the owner's architecture decision" }], report: "Retained the owner's architecture decision." });
  const start = (id = "dream") => memory.startRun({ id, ghostId: "ghost", state: "running", startedAt: Date.now(), endedAt: null, through: snapshot.through, report: "", error: null });
  const close = () => { memory.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, memory, source, message, snapshot, output, start, close };
}

test("a citation that does not match its source rejects the proposal with its identity and retains the cursor", () => {
  const f = memoryFixture();
  try {
    const cases: [typeof f.source, string][] = [
      [{ ...f.source, quote: "모든 대화는 Ghost에서" }, '- /me/architecture.md: quote from message "owner-1" of conversation "conversation" does not occur in it (exact prefix 7 of 14 characters)'],
      [{ ...f.source, conversationId: "other" }, '- /me/architecture.md: message "owner-1" of conversation "other" is not in the immutable source snapshot'],
      [{ ...f.source, messageId: "other" }, '- /me/architecture.md: message "other" of conversation "conversation" is not in the immutable source snapshot'],
    ];
    for (const [source, failure] of cases) {
      const proposal = JSON.parse(f.output);
      proposal.changes[0].sources = [source];
      expect(() => readProposal(JSON.stringify(proposal), f.snapshot)).toThrow(`Memory proposal rejected; no changes committed and cursor retained. ${failure.slice(2)}`);
    }
    expect(readProposal(f.output, f.snapshot).changes[0]?.sources).toEqual([f.source]);
  } finally { f.close(); }
});

test("a run with one misquoted change commits nothing and retains its evidence window", () => {
  const f = memoryFixture();
  try {
    const good = { path: "/me/retained.md", content: "# Retained\nHost memory, kept.", sources: [f.source], reason: "Solid evidence" };
    const bad = { path: "/me/dropped.md", content: "# Dropped\nParaphrased.", sources: [{ ...f.source, quote: "글자가 아닌 인용" }], reason: "Inexact quote" };
    f.start("mixed");
    expect(() => commitProposal(f.memory, "mixed", f.snapshot, JSON.stringify({ changes: [good, bad], report: "Two proposals." }))).toThrow("no changes committed and cursor retained");
    expect(f.memory.read("ghost", good.path)).toBeNull();
    expect(f.memory.read("ghost", bad.path)).toBeNull();
    expect(f.memory.read("ghost", "/me/MEMORY.md")).toBeNull();
    expect(f.memory.dreamCursor("ghost")).toBe(f.snapshot.after);
  } finally { f.close(); }
});

test("a misquoted merge replacement cannot delete its source note or consume the evidence", () => {
  for (const deletionFirst of [false, true]) {
    const f = memoryFixture();
    try {
      const sourcePath = "/me/source.md";
      const original = f.memory.write({ ghostId: "ghost", path: sourcePath, content: "# Retained knowledge\nRun conversations in Host.", expectedHash: null, actor: "owner", operationId: "seed-source", reason: "Existing knowledge" })!;
      const snapshot = memorySnapshot(f.memory, "ghost", 0);
      const replacement = { path: "/me/merged.md", content: "# Merged knowledge\nRun conversations in Host.", sources: [{ ...f.source, quote: "모든 대화는 Ghost에서" }], reason: "Merge the source note" };
      const deletion = { path: sourcePath, content: null, sources: [f.source], reason: "Superseded by merged note" };
      f.start("merge");
      const changes = deletionFirst ? [deletion, replacement] : [replacement, deletion];
      expect(() => commitProposal(f.memory, "merge", snapshot, JSON.stringify({ changes, report: "Merged source into replacement." }))).toThrow("no changes committed and cursor retained");
      expect(f.memory.read("ghost", sourcePath)).toEqual(original);
      expect(f.memory.revisions("ghost", sourcePath)).toHaveLength(1);
      expect(f.memory.read("ghost", replacement.path)).toBeNull();
      expect(f.memory.read("ghost", "/me/MEMORY.md")).toBeNull();
      expect(f.memory.dreamCursor("ghost")).toBe(snapshot.after);
      expect(memorySnapshot(f.memory, "ghost", f.memory.dreamCursor("ghost")).history).toEqual(snapshot.history);
    } finally { f.close(); }
  }
});

test("dream rejects profile, another team, traversal and model-authored index edits", () => {
  const f = memoryFixture();
  try {
    for (const path of ["/owner.md", "/team/other/topic.md", "/me/../owner.md", "/me/MEMORY.md"]) {
      const proposal = JSON.parse(f.output);
      proposal.changes[0].path = path;
      expect(() => readProposal(JSON.stringify(proposal), f.snapshot)).toThrow();
    }
  } finally { f.close(); }
});

test("successful synthesis has provenance, untrusted label and atomic persistent cursor/index", () => {
  const f = memoryFixture();
  try {
    f.start();
    commitProposal(f.memory, "dream", f.snapshot, f.output);
    const file = f.memory.read("ghost", "/me/architecture.md");
    expect(file?.content).toContain("Run all conversations in Host.");
    expect(file?.content).toContain("Untrusted Host synthesis");
    expect(file?.sources).toEqual([f.source]);
    expect(file?.trust).toBe("untrusted");
    expect(f.memory.read("ghost", "/me/MEMORY.md")?.content).toContain("/me/architecture.md");
    expect(f.memory.dreamCursor("ghost")).toBe(f.snapshot.through);
    expect(f.memory.runs("ghost")[0]?.state).toBe("done");
    const reopened = new MemoryStore(f.root);
    try { expect(reopened.dreamCursor("ghost")).toBe(f.snapshot.through); } finally { reopened.close(); }
  } finally { f.close(); }
});

test("owner correction replaces a contradictory imported note and merges/deletes obsolete duplicates", () => {
  const f = memoryFixture();
  try {
    for (const path of ["/me/architecture.md", "/me/obsolete.md"]) f.memory.write({ ghostId: "ghost", path, content: "# Old architecture\nRun conversations outside Host.", expectedHash: null, actor: "owner", operationId: path, reason: "Imported legacy note" });
    const snapshot = memorySnapshot(f.memory, "ghost", 0);
    const proposal = JSON.parse(f.output);
    proposal.changes.push({ path: "/me/obsolete.md", content: null, sources: [f.source], reason: "Merge duplicate and supersede contradicted legacy assumption" });
    f.start();
    commitProposal(f.memory, "dream", snapshot, JSON.stringify(proposal));
    expect(f.memory.read("ghost", "/me/architecture.md")?.content).not.toContain("outside Host");
    expect(f.memory.read("ghost", "/me/obsolete.md")).toBeNull();
    expect(f.memory.revisions("ghost", "/me/obsolete.md").some((revision) => revision.content === null)).toBe(true);
    expect(f.memory.revisions("ghost", "/me/architecture.md")).toHaveLength(2);
    const index = f.memory.read("ghost", "/me/MEMORY.md")!.content;
    expect(index).toContain("/me/architecture.md");
    expect(index).not.toContain("/me/obsolete.md");
  } finally { f.close(); }
});

test("concurrent owner edits are preserved, with no cursor advance", () => {
  const f = memoryFixture();
  try {
    f.start();
    f.memory.write({ ghostId: "ghost", path: "/me/architecture.md", content: "Concurrent owner edit", expectedHash: null, actor: "owner", operationId: "owner-edit", reason: "Owner edit" });
    expect(() => commitProposal(f.memory, "dream", f.snapshot, f.output)).toThrow("memory changed");
    expect(f.memory.read("ghost", "/me/architecture.md")?.content).toBe("Concurrent owner edit");
    expect(f.memory.dreamCursor("ghost")).toBe(0);
  } finally { f.close(); }
});

test("failure during a later commit write rolls back earlier notes, receipts, index and cursor", () => {
  const f = memoryFixture();
  const actual = f.memory.write.bind(f.memory);
  let writes = 0;
  const failure = spyOn(f.memory, "write").mockImplementation((input) => {
    if (++writes === 2) throw new Error("commit write failed");
    return actual(input);
  });
  try {
    f.start();
    expect(() => commitProposal(f.memory, "dream", f.snapshot, f.output)).toThrow("commit write failed");
    expect(f.memory.list("ghost")).toHaveLength(0);
    expect(f.memory.dreamCursor("ghost")).toBe(0);
    expect(f.memory.runs("ghost")[0]?.state).toBe("running");
    failure.mockRestore();
    commitProposal(f.memory, "dream", f.snapshot, f.output);
    expect(f.memory.runs("ghost")[0]?.state).toBe("done");
  } finally { failure.mockRestore(); f.close(); }
});

test("stale cursor is rejected independently of matching note hashes", () => {
  const f = memoryFixture();
  try {
    f.start();
    f.memory.setDreamCursor("ghost", f.snapshot.through);
    expect(() => commitProposal(f.memory, "dream", f.snapshot, f.output)).toThrow("cursor changed");
    expect(f.memory.list("ghost")).toHaveLength(0);
  } finally { f.close(); }
});

test("model selection and Host index stay bounded while CAS covers omitted existing notes", () => {
  const f = memoryFixture();
  f.memory.write({ ghostId: "ghost", path: "/me/base.md", content: `# Topic\n${"evidence ".repeat(2500)}`, expectedHash: null, actor: "owner", operationId: "base", reason: "Owner edit" });
  const base = f.memory.read("ghost", "/me/base.md")!;
  const all = Array.from({ length: 250 }, (_, index) => ({ ...base, path: `/me/topic-${index}.md` }));
  const shared = Array.from({ length: 80 }, (_, index) => ({ ...base, path: `/team/other/topic-${index}.md`, content: "Other-team body must never enter the model prompt" }));
  const list = spyOn(f.memory, "list").mockReturnValue([...all, ...shared]);
  try {
    const snapshot = memorySnapshot(f.memory, "ghost", 0);
    expect(snapshot.versions).toHaveLength(250);
    expect(snapshot.files.length).toBeLessThan(250);
    const prompt = memoryPrompt(snapshot);
    expect(snapshot.shared.paths).toHaveLength(32);
    expect(snapshot.shared.omitted).toBe(48);
    expect(prompt).not.toContain("Other-team body");
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(96 * 1024);
    expect(JSON.parse(prompt).omittedExistingNotes).toBe(250 - snapshot.files.length);
    const index = memoryIndex(all);
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(8 * 1024);
    expect(index.split("\n").length).toBeLessThanOrEqual(200);
    expect(index).toMatch(/Omitted private notes: [1-9][0-9]*/);
    const omitted = all.find((file) => !snapshot.files.some((selected) => selected.path === file.path))!;
    const proposal = JSON.parse(f.output);
    proposal.changes[0].path = omitted.path;
    expect(() => readProposal(JSON.stringify(proposal), snapshot)).toThrow("omitted");
  } finally { list.mockRestore(); f.close(); }
});

function serviceFixture(dream: MemoryEngine["dreamMemory"]) {
  const f = memoryFixture();
  const h = harness();
  const ghost = h.core.createGhost({ name: "Memory test", persona: "" });
  h.ledger.tx(() => h.ledger.putSetting("defaultModel", { provider: "default", model: "model" }));
  const engine: MemoryEngine = { catchUpMemory: async () => {}, memoryStatus: () => ({ ready: true, pending: 0 }), dreamMemory: dream };
  const service = new MemoryDreams({ core: h.core, memory: f.memory, engine, log: () => {} });
  const close = async () => { await service.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); f.close(); };
  return { ...f, h, ghost, service, close };
}

test("model failure is visible, keeps cursor and backs off manual retries", async () => {
  let calls = 0;
  const f = serviceFixture(async () => { calls++; throw new Error("provider unavailable"); });
  f.memory.indexMessage(f.ghost.id, f.message);
  try {
    f.service.request(f.ghost.id);
    await f.service.waitForIdle();
    expect(f.memory.runs(f.ghost.id)[0]?.state).toBe("failed");
    expect(f.memory.runs(f.ghost.id)[0]?.error).toContain("provider unavailable");
    expect(f.memory.dreamCursor(f.ghost.id)).toBe(0);
    f.service.request(f.ghost.id);
    await f.service.waitForIdle();
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test("service commit conflicts remain visible failures without overwriting owner data", async () => {
  const f = serviceFixture(async (input) => {
    f.memory.write({ ghostId: f.ghost.id, path: "/me/architecture.md", content: "Concurrent owner edit", expectedHash: null, actor: "owner", operationId: "during-model", reason: "Owner edit" });
    return { snapshot: input.snapshot, output: f.output };
  });
  f.memory.indexMessage(f.ghost.id, f.message);
  try {
    f.service.request(f.ghost.id);
    await f.service.waitForIdle();
    expect(f.memory.runs(f.ghost.id)[0]?.state).toBe("failed");
    expect(f.memory.read(f.ghost.id, "/me/architecture.md")?.content).toBe("Concurrent owner edit");
    expect(f.memory.dreamCursor(f.ghost.id)).toBe(0);
  } finally { await f.close(); }
});

test("no new history produces zero model calls, including manual requests", async () => {
  let calls = 0;
  const f = serviceFixture(async (input) => { calls++; return { snapshot: input.snapshot, output: '{"changes":[],"report":""}' }; });
  f.memory.indexMessage(f.ghost.id, f.message);
  f.memory.setDreamCursor(f.ghost.id, f.memory.historySeq(f.ghost.id));
  try {
    f.service.start();
    await f.service.waitForIdle();
    f.service.request(f.ghost.id);
    await f.service.waitForIdle();
    expect(calls).toBe(0);
    expect(f.memory.runs(f.ghost.id)).toHaveLength(0);
  } finally { await f.close(); }
});

test("automatic scheduling observes idle threshold and six-hour interval; manual skips interval only", async () => {
  let calls = 0;
  const f = serviceFixture(async (input) => { calls++; return { snapshot: input.snapshot, output: '{"changes":[],"report":""}' }; });
  f.memory.indexMessage(f.ghost.id, f.message);
  try {
    f.service.start();
    await f.service.waitForIdle();
    expect(calls).toBe(0); // Newly active conversation has not been idle for three minutes.
    f.memory.startRun({ id: "recent", ghostId: f.ghost.id, state: "running", startedAt: Date.now() - 600_000, endedAt: null, through: 0, report: "", error: null });
    f.memory.finishRun("recent", "done", "Earlier pass", null);
    const conversation = f.h.ledger.conversation(f.ghost.directConversationId);
    f.h.ledger.tx(() => f.h.ledger.putConversation({ ...conversation, lastActivityAt: Date.now() - 600_000 }));
    await f.service.waitForIdle();
    expect(calls).toBe(0); // New history alone does not bypass the six-hour interval.
    f.service.request(f.ghost.id);
    await f.service.waitForIdle();
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test("daily model bound also applies to manual requests", async () => {
  let calls = 0;
  const f = serviceFixture(async (input) => { calls++; return { snapshot: input.snapshot, output: '{"changes":[],"report":""}' }; });
  f.memory.indexMessage(f.ghost.id, f.message);
  try {
    for (let index = 0; index < 4; index++) {
      const id = `today-${index}`;
      f.memory.startRun({ id, ghostId: f.ghost.id, state: "running", startedAt: Date.now() - index - 1, endedAt: null, through: 0, report: "", error: null });
      f.memory.finishRun(id, "done", "", null);
    }
    f.service.request(f.ghost.id);
    await f.service.waitForIdle();
    expect(calls).toBe(0);
  } finally { await f.close(); }
});

test("shutdown cancels the active model job without cursor advance", async () => {
  const began = Promise.withResolvers<void>();
  const f = serviceFixture(async (_input, signal) => {
    const cancelled = Promise.withResolvers<never>();
    signal.addEventListener("abort", () => cancelled.reject(new Error("cancelled")), { once: true });
    began.resolve();
    return cancelled.promise;
  });
  f.memory.indexMessage(f.ghost.id, f.message);
  try {
    f.service.request(f.ghost.id);
    await began.promise;
    await f.service.close();
    expect(f.memory.runs(f.ghost.id)[0]?.state).toBe("failed");
    expect(f.memory.dreamCursor(f.ghost.id)).toBe(0);
  } finally { await f.close(); }
});

test("memoryModel falls back to defaultModel, never the Ghost model", async () => {
  for (const explicit of [false, true]) {
    const chosen = { provider: explicit ? "memory" : "default", model: explicit ? "memory-model" : "model" };
    const f = serviceFixture(async (input) => { expect(input.model).toEqual(chosen); return { snapshot: input.snapshot, output: '{"changes":[],"report":""}' }; });
    f.memory.indexMessage(f.ghost.id, f.message);
    f.h.ledger.tx(() => f.h.ledger.putSetting("memoryModel", explicit ? chosen : null));
    try {
      f.service.request(f.ghost.id);
      await f.service.waitForIdle();
      expect(f.memory.runs(f.ghost.id)[0]?.state).toBe("done");
    } finally { await f.close(); }
  }
});

test("internal dream identity survives Pi restart with no Ghost row or tools", async () => {
  const f = memoryFixture();
  const h = harness();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let calls = 0;
  faux.setResponses([() => { calls++; return fauxAssistantMessage(fauxText(f.output)); }]);
  const open = () => createEngine({ core: h.core, storagePath: join(f.root, "pi.db"), tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" }, sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} }, models, memory: f.memory, log: () => {} });
  let engine = await open();
  const input = { id: "durable-dream", snapshot: f.snapshot, model: { provider: "faux", model: "faux-1" }, startedAt: Date.now() };
  try {
    const first = await engine.dreamMemory(input, new AbortController().signal);
    await engine.close();
    const clock = spyOn(Date, "now").mockReturnValue(input.startedAt + 120_000);
    try {
      engine = await open();
      const second = await engine.dreamMemory(input, new AbortController().signal);
      expect(first).toEqual(second);
      expect(calls).toBe(1);
      expect(h.ledger.ghosts()).toHaveLength(0);
      expect(h.ledger.conversations()).toHaveLength(0);
    } finally { clock.mockRestore(); }
  } finally { await engine.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); f.close(); }
});

test("historical catch-up crosses bounded Pi pages and checkpoints without a model wake", async () => {
  const f = memoryFixture();
  const h = harness();
  const ghost = h.core.createGhost({ name: "History test", persona: "" });
  await h.core.idle();
  const models = createModels();
  const open = (index: boolean) => createEngine({ core: h.core, storagePath: join(f.root, "pi.db"), tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" }, sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} }, models, memory: index ? f.memory : undefined, log: () => {} });
  const engine = await open(false);
  try { await engine.appendHistory(ghost.directConversationId, Array.from({ length: 205 }, (_, index) => ({ role: "user" as const, text: index === 0 ? "오래된 소유자 결정: 독립적인 Host 메모리" : `body ${index}`, at: index + 1 }))); }
  finally { await engine.close(); }
  const indexing = await open(true);
  try {
    expect(indexing.memoryStatus(ghost.id).ready).toBe(false);
    await indexing.catchUpMemory(ghost.id);
    expect(indexing.memoryStatus(ghost.id)).toEqual({ ready: true, pending: 0 });
    expect(f.memory.history(ghost.id, 0, 1000)).toHaveLength(205);
    expect(f.memory.search(ghost.id, "소유자 결정").some((hit) => hit.text.includes("오래된"))).toBe(true);
    const checkpoint = f.memory.checkpoint(ghost.directConversationId);
    await indexing.catchUpMemory(ghost.id);
    expect(f.memory.checkpoint(ghost.directConversationId)).toBe(checkpoint);
    expect(f.memory.history(ghost.id, 0, 1000)).toHaveLength(205);
  } finally { await indexing.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); f.close(); }
});

test("a queued input is published and indexed with its origin, so catch-up advances past it", async () => {
  const f = memoryFixture();
  const h = harness();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const began = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  faux.setResponses([
    async () => { began.resolve(); await release.promise; return fauxAssistantMessage(fauxToolCall("echo", { text: "look" }), { stopReason: "toolUse" }); },
    () => fauxAssistantMessage(fauxText("steered")),
    () => fauxAssistantMessage(fauxText("followed")),
  ]);
  h.ledger.tx(() => {
    h.ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: null, models: [{ id: "faux-1", name: "Faux" }] });
    h.ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  });
  h.core.secrets.put("faux", "test-key");
  const echo = defineExtension({ name: "memory.test", tools: [defineTool({ name: "echo", description: "Echo.", parameters: Type.Object({ text: Type.String() }), execute: async (args) => ({ content: [{ type: "text", text: args.text }] }) })] });
  const logs: string[] = [];
  const engine = await createEngine({
    core: h.core, storagePath: join(f.root, "pi.db"), memory: f.memory, models, log: (message, detail) => logs.push(`${message} ${detail}`),
    tools: { all: () => [echo], extensionsFor: () => [echo], instructionsFor: () => "" },
    sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} },
  });
  h.core.attach(engine);
  const ghost = h.core.createGhost({ name: "Queued", persona: "" });
  await h.core.idle();
  const conversationId = ghost.directConversationId;
  const published = new Map<string, Message>();
  const followed = Promise.withResolvers<void>();
  const stop = engine.watch(conversationId, (event) => {
    if (event.type !== "message") return;
    if (event.message.role === "user") published.set(event.message.text, event.message);
    if (event.message.text === "followed") followed.resolve();
  });
  try {
    await engine.submit(conversationId, { text: "start", origin: "owner", requestId: "r1" });
    await began.promise;
    // Placed at the next tool boundary; its publication probes the still-queued follow-up.
    await engine.submit(conversationId, { text: "decision arrived", origin: "decision", requestId: "r2", steer: true });
    await engine.submit(conversationId, { text: "scheduled wake", origin: "schedule", requestId: "r3" });
    release.resolve();
    await followed.promise;
    await engine.catchUpMemory(ghost.id);
    expect([...published.values()].map((message) => [message.text, message.origin])).toEqual([["start", "owner"], ["decision arrived", "decision"], ["scheduled wake", "schedule"]]);
    expect(f.memory.history(ghost.id, 0, 100).filter((row) => row.role === "user").map((row) => [row.text, row.origin])).toEqual([["start", "owner"], ["decision arrived", "decision"], ["scheduled wake", "schedule"]]);
    expect(engine.memoryStatus(ghost.id)).toEqual({ ready: true, pending: 0 });
    expect(logs.filter((line) => line.startsWith("memory:"))).toEqual([]);
  } finally { stop(); h.core.stop(); await h.core.idle(); await engine.close(); h.ledger.close(); f.close(); }
});

test("a one-time repair recovers origins indexed before their checkpoint and then stays done", async () => {
  const f = memoryFixture();
  const h = harness();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([() => fauxAssistantMessage(fauxText("done"))]);
  h.ledger.tx(() => {
    h.ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: null, models: [{ id: "faux-1", name: "Faux" }] });
    h.ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  });
  h.core.secrets.put("faux", "test-key");
  const ghost = h.core.createGhost({ name: "Repair test", persona: "" });
  await h.core.idle();
  const open = () => createEngine({ core: h.core, storagePath: join(f.root, "pi.db"), tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" }, sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} }, models, memory: f.memory, log: () => {} });
  const engine = await open();
  const answered = Promise.withResolvers<void>();
  const stop = engine.watch(ghost.directConversationId, (event) => { if (event.type === "message" && event.message.text === "done") answered.resolve(); });
  try {
    await engine.submit(ghost.directConversationId, { text: "아침 점검 시간입니다.", origin: "schedule", requestId: "r1" });
    await answered.promise;
    await engine.catchUpMemory(ghost.id);
  } finally { stop(); await engine.close(); }
  // The production failure shape: a recorded origin the first index never resolved, now behind its checkpoint.
  const wake = f.memory.history(ghost.id, 0, 10).find(row => row.role === "user")!.id;
  const tamper = new Database(join(f.root, "memory.db"));
  tamper.exec("UPDATE memory_history SET origin = NULL WHERE message_id = " + JSON.stringify(wake));
  tamper.close();
  expect(f.memory.unresolvedOrigins(ghost.id, ghost.directConversationId)).toEqual([wake]);
  const repaired = await open();
  try {
    await repaired.catchUpMemory();
    expect(f.memory.unresolvedOrigins(ghost.id, ghost.directConversationId)).toEqual([]);
    expect(f.memory.history(ghost.id, 0, 10).find(row => row.id === wake)?.origin).toBe("schedule");
    const again = new Database(join(f.root, "memory.db"));
    again.exec("UPDATE memory_history SET origin = NULL WHERE message_id = " + JSON.stringify(wake));
    again.close();
    await repaired.catchUpMemory();
    expect(f.memory.history(ghost.id, 0, 10).find(row => row.id === wake)?.origin).toBeNull();
  } finally { await repaired.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); f.close(); }
});

test("nested imported notes and own-team notes can be superseded/deleted with preserved revisions", () => {
  const f = memoryFixture();
  try {
    const imported = "/me/imported/episode-58.md";
    const team = "/team/ghost/strategies/obsolete.md";
    for (const path of [imported, team]) f.memory.write({ ghostId: "ghost", path, content: "Run conversations externally.", expectedHash: null, actor: "owner", operationId: path, reason: "Imported note" });
    const snapshot = memorySnapshot(f.memory, "ghost", 0);
    f.start();
    commitProposal(f.memory, "dream", snapshot, JSON.stringify({
      changes: [
        { path: imported, content: "# Corrected architecture\nRun conversations in Host.", sources: [f.source], reason: "New owner correction supersedes imported assumption" },
        { path: team, content: null, sources: [f.source], reason: "Remove obsolete contradictory team advice" },
      ],
      report: "Corrected imported memory and pruned obsolete shared advice.",
    }));
    expect(f.memory.read("ghost", imported)?.content).toContain("Run conversations in Host.");
    expect(f.memory.read("ghost", team)).toBeNull();
    expect(f.memory.revisions("ghost", imported)).toHaveLength(2);
    expect(f.memory.revisions("ghost", team).some((revision) => revision.content === null)).toBe(true);
    expect(f.memory.read("ghost", "/me/MEMORY.md")?.content).toContain(imported);
  } finally { f.close(); }
});

test("memory 429 consumes one durable attempt while ordinary Ghost retry policy stays enabled", async () => {
  const f = memoryFixture();
  const h = harness();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let calls = 0;
  const limited = () => { calls++; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit exceeded" }); };
  faux.setResponses([limited, limited, () => { calls++; return fauxAssistantMessage("ordinary recovered"); }]);
  h.ledger.tx(() => {
    h.ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: null, models: [{ id: "faux-1", name: "Faux" }] });
    h.ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  });
  h.core.secrets.put("faux", "test-key");
  const engine = await createEngine({
    core: h.core, storagePath: join(f.root, "pi.db"), memory: f.memory, models, log: () => {},
    tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" },
    sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} },
    harnessSettings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } },
  });
  h.core.attach(engine);
  try {
    const input = { id: "one-429", snapshot: f.snapshot, model: { provider: "faux", model: "faux-1" }, startedAt: Date.now() };
    await expect(engine.dreamMemory(input, new AbortController().signal)).rejects.toThrow("429");
    await expect(engine.dreamMemory(input, new AbortController().signal)).rejects.toThrow("429");
    expect(calls).toBe(1);
    const ghost = h.core.createGhost({ name: "Ordinary", persona: "" });
    await h.core.idle();
    const answered = Promise.withResolvers<void>();
    const stop = engine.watch(ghost.directConversationId, (event) => {
      if (event.type === "message" && event.message.text === "ordinary recovered") answered.resolve();
    });
    try {
      await engine.submit(ghost.directConversationId, { text: "retry normally", origin: "owner", requestId: "ordinary-retry" });
      await answered.promise;
      expect(calls).toBe(3);
    } finally { stop(); }
  } finally { h.core.stop(); await h.core.idle(); await engine.close(); h.ledger.close(); f.close(); }
});

test("oversize provider output is signal-cancelled even when the adapter ignores maxTokens", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = models.getModel("faux", "faux-1")!;
  const source = createAssistantMessageEventStream();
  let providerSignal: AbortSignal | undefined;
  const provider = spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
    providerSignal = options?.signal;
    options?.signal?.addEventListener("abort", () => source.end(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    return source;
  });
  try {
    const stream = memoryModels(models, Date.now() + 90_000).streamSimple(model, { messages: [] });
    source.push({ type: "start", partial: fauxAssistantMessage("") });
    const text = "x".repeat(MEMORY_OUTPUT_BYTES + 1);
    source.push({ type: "text_delta", contentIndex: 0, delta: text, partial: fauxAssistantMessage(text) });
    const result = await stream.result();
    expect(providerSignal?.aborted).toBe(true);
    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toContain("output exceeded");
    expect(result.content).toHaveLength(0);
    const events = [];
    for await (const event of stream) events.push(event.type);
    expect(events).toEqual(["error"]); // No mutable oversized partial reaches Pi.
  } finally { provider.mockRestore(); }
});

test("memory stream propagates shutdown cancellation and expired deadlines without another request", async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = models.getModel("faux", "faux-1")!;
  const source = createAssistantMessageEventStream();
  let providerSignal: AbortSignal | undefined;
  const provider = spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
    providerSignal = options?.signal;
    options?.signal?.addEventListener("abort", () => source.end(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    return source;
  });
  try {
    const caller = new AbortController();
    const active = memoryModels(models, Date.now() + 90_000).streamSimple(model, { messages: [] }, { signal: caller.signal });
    caller.abort(new Error("Host shutdown cancellation"));
    expect((await active.result()).errorMessage).toContain("Host shutdown cancellation");
    expect(providerSignal?.aborted).toBe(true);
    const expired = memoryModels(models, Date.now() - 1).streamSimple(model, { messages: [] });
    expect((await expired.result()).errorMessage).toContain("deadline exceeded");
    expect(provider).toHaveBeenCalledTimes(1);
  } finally { provider.mockRestore(); }
});

test("startup gates an interrupted dream before shared resume even with a busy owner conversation", async () => {
  const f = memoryFixture();
  const h = harness();
  const ghost = h.core.createGhost({ name: "Busy owner", persona: "" });
  await h.core.idle();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const began = Promise.withResolvers<void>();
  let calls = 0;
  faux.setResponses([
    async (_context, options) => {
      calls++;
      const interrupted = Promise.withResolvers<never>();
      options?.signal?.addEventListener("abort", () => interrupted.reject(new Error("process stopped")), { once: true });
      began.resolve();
      return interrupted.promise;
    },
    () => { calls++; return fauxAssistantMessage(f.output); },
  ]);
  const open = () => createEngine({ core: h.core, storagePath: join(f.root, "pi.db"), memory: f.memory, models, log: () => {}, tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" }, sandbox: { envFor: async () => { throw new Error("no sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} } });
  let engine = await open();
  const input = { id: "interrupted-memory", snapshot: f.snapshot, model: { provider: "faux", model: "faux-1" }, startedAt: Date.now() };
  try {
    const interrupted = engine.dreamMemory(input, new AbortController().signal).catch((error: unknown) => error);
    await began.promise;
    await engine.close();
    await interrupted;
    h.ledger.tx(() => h.ledger.putConversation({ ...h.ledger.conversation(ghost.directConversationId), busy: true }));
    engine = await open();
    expect(h.ledger.conversation(ghost.directConversationId).busy).toBe(true);
    engine.resume();
    await expect(engine.dreamMemory(input, new AbortController().signal)).rejects.toThrow("host_restart");
    expect(calls).toBe(1);
  } finally { h.core.stop(); await h.core.idle(); await engine.close(); h.ledger.close(); f.close(); }
});
