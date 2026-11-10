import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Message } from "@ghost/contract";
import { createEngine } from "../src/engine/index.ts";
import { MemoryStore } from "../src/stores/memory.ts";
import { commitProposal, MemoryDreams, memoryIndex, memorySnapshot, readProposal } from "../src/memory/dreams.ts";
import { memoryPrompt } from "../src/memory/pi.ts";
import type { MemoryEngine } from "../src/memory/types.ts";
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

test("dream citations require exact conversation, message and quote, without claiming entailment", () => {
  const f = memoryFixture();
  try {
    for (const source of [{ ...f.source, quote: "Fabricated" }, { ...f.source, conversationId: "other" }, { ...f.source, messageId: "other" }]) {
      const proposal = JSON.parse(f.output);
      proposal.changes[0].sources = [source];
      expect(() => readProposal(JSON.stringify(proposal), f.snapshot)).toThrow();
    }
    expect(readProposal(f.output, f.snapshot).changes[0]?.sources).toEqual([f.source]);
  } finally { f.close(); }
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
    engine = await open();
    const second = await engine.dreamMemory(input, new AbortController().signal);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    expect(h.ledger.ghosts()).toHaveLength(0);
    expect(h.ledger.conversations()).toHaveLength(0);
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
