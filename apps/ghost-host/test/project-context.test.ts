import { Database } from "bun:sqlite";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { toMessage } from "../src/engine/messages.ts";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { realpathSync, rmSync, symlinkSync } from "node:fs";
import { Command, Work, validate, type Command as CommandType, type Principal } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { snapshot } from "../src/core/state.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { MIGRATIONS } from "../src/ledger/schema.ts";
import { harness, tempDir } from "./support.ts";

const context = { publicOrigin: "http://localhost", documents: null };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
function fixture(path = ":memory:") {
  const result = harness(path);
  cleanups.push(async () => { result.core.stop(); await result.core.idle(); result.ledger.close(); });
  const ghost = result.core.createGhost({ name: "Owner", persona: "" });
  const send = (command: CommandType, requestId = crypto.randomUUID(), principal: Principal = { kind: "owner" }) => execute(result.core, new Access(principal), { requestId, command }, context);
  return { ...result, ghost, send };
}

function oldLedger(path: string) {
  const db = new Database(path, { create: true });
  for (const migration of MIGRATIONS.slice(0, 10)) db.exec(migration);
  db.exec("PRAGMA user_version=10");
  db.query("INSERT INTO spaces(id,name,path,grants,created_at) VALUES (?,?,?,?,?)").run("old-one", "First", "/tmp", "[]", 1);
  db.query("INSERT INTO spaces(id,name,path,grants,created_at) VALUES (?,?,?,?,?)").run("old-two", "Second", "/tmp/second", "[]", 2);
  db.exec(`INSERT INTO ghosts(id,name,persona,look,is_default,state,direct_conversation_id,created_at,updated_at) VALUES ('g','Ghost','','{"avatarId":null}',1,'active','direct',1,1);
    INSERT INTO conversations(id,ghost_id,kind,title,created_at,last_activity_at,pi_conversation_id) VALUES ('direct','g','direct','Owner',1,2,'pi-direct');
    INSERT INTO conversations(id,ghost_id,kind,work_id,title,created_at,last_activity_at,pi_conversation_id) VALUES ('work','g','work','w','Work',3,4,'pi-work');
    INSERT INTO conversations(id,ghost_id,kind,work_id,title,created_at,last_activity_at) VALUES ('review','g','review','w','Review',5,6);
    CREATE INDEX custom_conversations_title ON conversations(title);
    INSERT INTO works(id,root_id,ghost_id,origin_conversation_id,conversation_id,title,brief,acceptance,state,revision,created_at,updated_at) VALUES ('w','w','g','direct','work','Work','plain','{"criteria":"","checks":[],"reviewer":null}','running',1,1,1);
    INSERT INTO decisions(id,kind,ghost_id,conversation_id,work_id,title,detail,options,state,created_at) VALUES ('d','question','g','direct','w','Question','','[]','pending',1);
    INSERT INTO effects(id,work_id,conversation_id,call_id,tool,summary,input_digest,state,created_at) VALUES ('e','w','work','call','bash','old effect','digest','unknown',1);`);
  const prefix = 'Mentioned projects (untrusted names): [{"name":"First","spaceId":"old-one"},{"name":"Second","spaceId":"old-two"}]\nRead these projects with document_list and document_read before answering or working on the request.\n\n';
  db.query("UPDATE works SET brief=? WHERE id='w'").run(prefix + "Visible owner text\nKeep this line");
  db.query("INSERT INTO events(at,data) VALUES (?,?)").run(1, JSON.stringify({ type: "space", space: { id: "old-one", name: "First", path: "/tmp", createdAt: 1 } }));
  const activity = {
    id: "old-activity", ghostId: "g", name: "Read old documents", prompt: "Read the vault", acceptanceCriteria: "Report observations",
    source: { kind: "schedule", spec: { kind: "every", seconds: 3600, startAt: 1 } }, execution: { kind: "container" },
    tools: ["document_spaces", "document_read"],
    policy: { maxRunsPerDay: 1, maxConcurrent: 1, runTimeoutSeconds: 60, allowSelfCheck: false, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" },
    revision: 1, paused: true, pauseReason: "Owner paused", nextAt: 3600001, cursor: null, lastCheckedAt: null,
    lastError: null, failureCount: 0, deletedAt: null, createdAt: 1, updatedAt: 1,
  };
  db.query("INSERT INTO activities(id,data) VALUES (?,?)").run(activity.id, JSON.stringify(activity));
  db.query("INSERT INTO events(at,data) VALUES (?,?)").run(2, JSON.stringify({ type: "activity", activity }));
  db.query("UPDATE works SET tool_scope=? WHERE id='w'").run(JSON.stringify(activity.tools));
  db.query("INSERT INTO events(at,data) VALUES (?,?)").run(3, JSON.stringify({ type: "work", work: {
    id: "w", parentId: null, rootId: "w", ghostId: "g", originConversationId: "direct", conversationId: "work",
    title: "Work", brief: prefix + "Visible owner text\nKeep this line", acceptance: { criteria: "", checks: [], reviewer: null },
    state: "running", revision: 1, revisionsUsed: 0, deadlineAt: null, result: null, verdict: null, reason: null,
    toolScope: activity.tools, createdAt: 1, startedAt: 1, endedAt: null, updatedAt: 1,
  } }));
  db.close();
}

test("new installations have no scopes and seed owner-editable rules only once", () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ledger.db");
  let ledger = new Ledger(path);
  expect(ledger.scopes()).toEqual([]);
  expect(ledger.policyRules().length).toBeGreaterThan(0);
  ledger.tx(() => { for (const rule of ledger.policyRules()) ledger.deletePolicyRule(rule.id); });
  ledger.close(); ledger = new Ledger(path);
  expect(ledger.policyRules()).toEqual([]);
  ledger.close();
});

test("policy seeding preserves legacy owner approval timing, delegation and Ghost exceptions once", () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, approvals] of [
    { autoMinutes: 0, delegate: "none" },
    { autoMinutes: 7, delegate: "reversible", ghosts: { g: "owner" } },
  ].entries()) {
    const path = join(root, `approval-policy-${index}.db`);
    oldLedger(path);
    const old = new Database(path);
    old.query("INSERT INTO settings(key,value) VALUES ('approvals',?)").run(JSON.stringify(approvals));
    old.close();
    let ledger = new Ledger(path);
    const document = ledger.policyRule("document-new");
    if (approvals.delegate === "none") {
      expect(document.decision).toBe("owner");
      expect(document.reviewer).toBeUndefined();
      expect(document.autoResolve).toBeUndefined();
    } else {
      expect(document).toMatchObject({ decision: "review", reviewer: { kind: "main" }, autoResolve: { afterMinutes: 7, answer: "approve" } });
      expect(ledger.policyRule("document-new:g")).toMatchObject({ ghostId: "g", decision: "owner", reviewer: { kind: "main" } });
      expect(ledger.policyRule("document-new:g").autoResolve).toBeUndefined();
    }
    const seeded = ledger.policyRules();
    ledger.tx(() => ledger.putSetting("approvals", { autoMinutes: 30, delegate: "reversible" }));
    ledger.close();
    ledger = new Ledger(path);
    expect(ledger.policyRules()).toEqual(seeded);
    ledger.close();
  }
});

test("migration preserves old scope ids, every conversation, foreign keys, indexes and Work text", () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ledger.db"); oldLedger(path);
  let ledger = new Ledger(path);
  expect(ledger.scopes().map(scope => scope.id)).toEqual(["old-one", "old-two"]);
  expect(ledger.scope("old-one")).toMatchObject({ paths: ["/tmp"], vaultPath: "/tmp", ghostId: null, state: "active", attachments: [], limits: {} });
  expect(ledger.db.query("SELECT name FROM sqlite_master WHERE name='spaces'").get()).toBeNull();
  expect(ledger.conversations()).toHaveLength(3);
  expect(ledger.piConversationId("work")).toBe("pi-work");
  expect(ledger.eventsAfter(0)?.[0]?.data).toEqual({ type: "scope", scope: ledger.scope("old-one") });
  expect(ledger.work("w")).toMatchObject({ brief: "Visible owner text\nKeep this line", scopeId: "old-one", attachments: [], slot: null, retry: null, scopeReferences: [{ id: "old-one", name: "First" }, { id: "old-two", name: "Second" }] });
  expect(ledger.ghost("g").tools).toContain("document_scopes");
  expect(ledger.ghost("g").tools).not.toContain("document_spaces");
  expect(ledger.activity("old-activity")).toMatchObject({ scopeId: null, tools: ["document_scopes", "document_read"], paused: true, pauseReason: "Owner paused" });
  expect(ledger.work("w").toolScope).toEqual(["document_scopes", "document_read"]);
  const events = ledger.eventsAfter(0)!;
  expect(events.map(event => event.data)).toContainEqual(expect.objectContaining({ type: "activity", activity: expect.objectContaining({ scopeId: null, tools: ["document_scopes", "document_read"] }) }));
  expect(events.map(event => event.data)).toContainEqual(expect.objectContaining({ type: "work", work: expect.objectContaining({ brief: "Visible owner text\nKeep this line", scopeId: "old-one", toolScope: ["document_scopes", "document_read"] }) }));
  expect(ledger.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(ledger.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(ledger.db.query("SELECT name FROM sqlite_master WHERE name='custom_conversations_title'").get()).not.toBeNull();
  expect(ledger.findDecision("d")?.workId).toBe("w");
  expect(ledger.effectsForWork("w")[0]?.state).toBe("unknown");
  const before = ledger.work("w"); ledger.close(); ledger = new Ledger(path);
  expect(ledger.work("w")).toEqual(before);
  ledger.close();
});

test("migration never strips owner text that only resembles the exact legacy prefix encoding", () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const suffix = "\nRead these projects with document_list and document_read before answering or working on the request.\n\n";
  const encodings = [
    '[{"spaceId":"old-one","name":"First"}]',
    '[{ "name": "First", "spaceId": "old-one" }]',
    '[{"name":"First","spaceId":"old-one","ownerText":true}]',
    '[{"name":"\\u0046irst","spaceId":"old-one"}]',
  ];
  for (const [index, encoding] of encodings.entries()) {
    const path = join(root, `literal-${index}.db`);
    oldLedger(path);
    const brief = `Mentioned projects (untrusted names): ${encoding}${suffix}This entire message is owner-authored.`;
    const old = new Database(path);
    old.query("UPDATE works SET brief=? WHERE id='w'").run(brief);
    old.query("UPDATE events SET data=json_set(data,'$.work.brief',?) WHERE json_extract(data,'$.type')='work'").run(brief);
    old.close();
    const ledger = new Ledger(path);
    try {
      expect(ledger.work("w")).toMatchObject({ brief, scopeId: null, scopeReferences: [] });
      expect(ledger.eventsAfter(0)!.map(event => event.data)).toContainEqual(expect.objectContaining({ type: "work", work: expect.objectContaining({ brief, scopeId: null }) }));
    } finally { ledger.close(); }
  }
});

test("fresh wake and subagent conversations use deterministic request identities without a one-per-Work restriction", () => {
  const { ledger, core, ghost } = fixture();
  const work = core.works.createRoot({ ghostId: ghost.id, title: "Task", brief: "Task", originConversationId: ghost.directConversationId });
  const wake = ledger.createWakeConversation(ghost.id, "wake-1", "Wake", work.id);
  expect(ledger.createWakeConversation(ghost.id, "wake-1", "Wake", work.id).id).toBe(wake.id);
  expect(ledger.createWakeConversation(ghost.id, "wake-2", "Wake", work.id).id).not.toBe(wake.id);
  expect(ledger.createSubagentConversation(ghost.id, "wake-1", "Read", work.id).kind).toBe("subagent");
  expect(ledger.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("commands accept one scope and structured documents, never the retired multi-space parameters", () => {
  for (const base of [{ type: "message.send", conversationId: "c", text: "Request" }, { type: "work.create", ghostId: "g", title: "Title", brief: "Request" }]) {
    expect(validate(Command, { ...base, scopeId: "project", attachments: [{ kind: "skill", name: "writing" }] })).toBe(true);
    expect(validate(Command, { ...base, scopeId: null })).toBe(true);
    expect(validate(Command, { ...base, spaceIds: ["project"] })).toBe(false);
    expect(validate(Command, { ...base, scopeIds: ["project"] })).toBe(false);
  }
  expect(validate(Command, { type: "space.create", name: "Old", path: "/tmp" })).toBe(false);
});

test("scope paths require real absolute directories and default to the receiving default Ghost", async () => {
  const { send, ledger } = fixture();
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, "link"); symlinkSync(root, link);
  const created = await send({ type: "scope.create", name: "Project", paths: [link] });
  expect(ledger.scope(String(created.scopeId))).toMatchObject({ paths: [realpathSync(root)], vaultPath: null, ghostId: null });
  await expect(send({ type: "scope.create", name: "Bad", paths: ["relative"] })).rejects.toThrow("absolute directories");
  await expect(send({ type: "scope.create", name: "Bad", paths: [join(root, "missing")] })).rejects.toThrow("absolute directories");
});

test("owner scope, rule, slot and MCP updates persist, emit events and revert exact before states", async () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const { send, ledger, core } = fixture(join(root, "ledger.db"));
  const created = await send({ type: "scope.create", name: "Project", paths: [root], vaultPath: root });
  const scopeId = String(created.scopeId);
  const before = ledger.scope(scopeId);
  const sequence = ledger.seq();
  await send({ type: "scope.update", scopeId, name: "Renamed", attachments: [{ kind: "skill", name: "writing" }] });
  const revision = ledger.configRevisions("scope", scopeId).at(-1)!;
  await send({ type: "config.revert", revisionId: revision.id });
  expect(ledger.scope(scopeId)).toEqual(before);
  ledger.tx(() => ledger.putProvider({ id: "p", kind: "openai", name: "P", baseUrl: null, models: [] }));
  await send({ type: "slot.set", name: "writer", model: { provider: "p", model: "one", thinking: "off" }, fallbacks: [] });
  const slot = ledger.settings().slots!.writer;
  await send({ type: "slot.set", name: "writer", model: { provider: "p", model: "two", thinking: "low" }, fallbacks: [] });
  await send({ type: "config.revert", revisionId: ledger.configRevisions("slot", "writer").at(-1)!.id });
  expect(ledger.settings().slots!.writer).toEqual(slot);
  const ruleResult = await send({ type: "rule.create", tool: "document_*", scopeId, when: { access: "write" }, decision: "owner" });
  const ruleId = String(ruleResult.ruleId), rule = ledger.policyRule(ruleId);
  await send({ type: "rule.update", ruleId, decision: "deny", scopeId: null });
  expect(ledger.policyRule(ruleId).scopeId).toBeUndefined();
  await send({ type: "config.revert", revisionId: ledger.configRevisions("rule", ruleId).at(-1)!.id });
  expect(ledger.policyRule(ruleId)).toEqual(rule);
  const serverResult = await send({ type: "mcp.create", name: "notes", enabled: false, transport: { kind: "stdio", command: "node", args: ["server.js"], env: [], cwd: root }, readTools: [] });
  const serverId = String(serverResult.serverId), server = ledger.mcpServer(serverId);
  await send({ type: "mcp.update", serverId, enabled: true, readTools: ["list"] });
  await send({ type: "config.revert", revisionId: ledger.configRevisions("mcp", serverId).at(-1)!.id });
  expect(ledger.mcpServer(serverId)).toEqual(server);
  const state = snapshot(core, new Access({ kind: "owner" }));
  expect(state.scopes).toEqual([before]);
  expect(state.policyRules).toContainEqual(rule);
  expect(state.mcpServers).toEqual([server]);
  const events = ledger.eventsAfter(sequence)!.map(event => event.data.type);
  expect(events).toContain("scope"); expect(events).toContain("policy_rule"); expect(events).toContain("mcp_server"); expect(events).toContain("config_revision");
  const reopened = new Ledger(join(root, "ledger.db"));
  expect(reopened.scope(scopeId)).toEqual(before); expect(reopened.policyRule(ruleId)).toEqual(rule); expect(reopened.mcpServer(serverId)).toEqual(server);
  expect(reopened.configRevisions()).toEqual(ledger.configRevisions()); reopened.close();
});

test("delete and revert cannot orphan live Work, attachment roots, reviewers or default slots", async () => {
  const { send, ledger, ghost, core } = fixture();
  const created = await send({ type: "scope.create", name: "Project", paths: ["/tmp"], vaultPath: "/tmp" });
  const scopeId = String(created.scopeId);
  const work = core.works.createRoot({ ghostId: ghost.id, title: "Task", brief: "Task", scopeId, originConversationId: ghost.directConversationId });
  const seq = ledger.seq(), revisions = ledger.configRevisions().length;
  await expect(send({ type: "scope.delete", scopeId })).rejects.toThrow();
  await expect(send({ type: "config.revert", revisionId: ledger.configRevisions("scope", scopeId)[0]!.id })).rejects.toThrow();
  expect(ledger.seq()).toBe(seq); expect(ledger.configRevisions()).toHaveLength(revisions); expect(ledger.scope(scopeId).id).toBe(scopeId);
  core.works.cancel(work.id);
  const rule = await send({ type: "rule.create", tool: "*", scopeId, when: {}, decision: "owner" });
  await expect(send({ type: "scope.delete", scopeId })).rejects.toThrow();
  await send({ type: "rule.delete", ruleId: String(rule.ruleId) });
  await send({ type: "scope.delete", scopeId });
  expect(ledger.work(work.id).scopeId).toBe(scopeId);
});

test("limits revisions restore overrides, inheriting again after scoped overrides are cleared", async () => {
  const { send, ledger } = fixture();
  const scopeId = String((await send({ type: "scope.create", name: "Project", paths: [] })).scopeId);
  await send({ type: "limits.set", scopeId, limits: { dailyWakes: 2 } });
  expect(ledger.limits(scopeId).dailyWakes).toBe(2);
  await send({ type: "limits.set", scopeId, limits: {} });
  expect(ledger.limits(scopeId).dailyWakes).toBe(ledger.limits().dailyWakes);
  await send({ type: "config.revert", revisionId: ledger.configRevisions("limits", scopeId).at(-1)!.id });
  expect(ledger.limits(scopeId).dailyWakes).toBe(2);
  const before = ledger.limits(); await send({ type: "limits.set", limits: { dailyWakes: 4 } });
  await send({ type: "config.revert", revisionId: ledger.configRevisions("limits", null).at(-1)!.id });
  expect(ledger.limits()).toEqual(before);
});

test("owner text remains unchanged with structured scope and documents through Work edits", async () => {
  const { send, ledger, engine, ghost, core } = fixture();
  const scopeId = String((await send({ type: "scope.create", name: "비행 기록", paths: ["/tmp"], vaultPath: "/tmp" })).scopeId);
  const docs = [{ kind: "page" as const, scopeId, locator: "plan.md" }];
  await send({ type: "message.send", conversationId: ghost.directConversationId, text: "계획을 알려줘", scopeId, attachments: docs });
  expect(engine.to(ghost.directConversationId).at(-1)).toMatchObject({ text: "계획을 알려줘", scopeId, docAttachments: docs });
  const workId = String((await send({ type: "work.create", ghostId: ghost.id, title: "계획", brief: "이륙 준비", scopeId, attachments: docs })).workId);
  expect(ledger.work(workId)).toMatchObject({ brief: "이륙 준비", scopeId, attachments: docs });
  await send({ type: "work.update", workId, brief: "준비 계획 수정" });
  expect(ledger.work(workId)).toMatchObject({ brief: "준비 계획 수정", scopeId, attachments: docs });
  expect(validate(Work, ledger.work(workId))).toBe(true);
  await core.idle();
});

test("configuration is owner-authorized and repeated deletes return the durable receipt", async () => {
  const { send, ledger } = fixture();
  const scopeId = String((await send({ type: "scope.create", name: "Project", paths: [] })).scopeId);
  const ghostPrincipal = { kind: "ghost", id: "g" } as unknown as Principal;
  await expect(send({ type: "scope.update", scopeId, paths: ["/tmp"] }, crypto.randomUUID(), ghostPrincipal)).rejects.toThrow("owner principal");
  const requestId = crypto.randomUUID();
  await send({ type: "scope.delete", scopeId }, requestId);
  const count = ledger.configRevisions().length;
  await expect(send({ type: "scope.delete", scopeId }, requestId)).resolves.toEqual({});
  expect(ledger.configRevisions()).toHaveLength(count);
});

test("scoped goals and milestones persist attribution and never leak another scope's context", () => {
  const { ledger, core, ghost } = fixture();
  ledger.tx(() => ledger.putScope({ id: "s", name: "S", ghostId: null, paths: [], vaultPath: null, state: "active", attachments: [], limits: {}, createdAt: 1, updatedAt: 1 }));
  core.goals.create({ title: "Global", boundaries: "No spending" });
  const goal = core.goals.create({ scopeId: "s", title: "Scope only", boundaries: "No publishing" });
  const milestone = core.goals.plan(ghost, goal.id, { title: "Next", exit: "Evidence" }, "ms");
  expect(milestone.scopeId).toBe("s"); expect(core.goals.goals("s")).toEqual([goal]);
  expect(core.goals.context()).not.toContain("Scope only"); expect(core.goals.context("s")).toContain("Scope only");
});

test("a maximum-size owner brief remains valid without a hidden project prefix", async () => {
  const { send, ledger, ghost } = fixture();
  const scopeId = String((await send({ type: "scope.create", name: "\u0001".repeat(128), paths: [] })).scopeId);
  const brief = "a".repeat(32768);
  const attachments = Array.from({ length: 32 }, (_, index) => ({ kind: "skill" as const, name: `skill-${index}` }));
  const workId = String((await send({ type: "work.create", ghostId: ghost.id, scopeId, title: "Long brief", brief, attachments })).workId);
  expect(ledger.work(workId).brief).toBe(brief);
  expect(validate(Work, ledger.work(workId))).toBe(true);
  expect(ledger.work(workId).attachments).toEqual(attachments);
});

test("slot deletion and creation reverts reject default and live reviewer references", async () => {
  const { send, ledger } = fixture();
  ledger.tx(() => ledger.putProvider({ id: "p", kind: "openai", name: "P", baseUrl: null, models: [] }));
  await send({ type: "slot.set", name: "reviewer", model: { provider: "p", model: "one" }, fallbacks: [] });
  const creation = ledger.configRevisions("slot", "reviewer")[0]!;
  await send({ type: "settings.update", defaultSlot: "reviewer" });
  await expect(send({ type: "slot.delete", name: "reviewer" })).rejects.toThrow("referenced");
  await expect(send({ type: "config.revert", revisionId: creation.id })).rejects.toThrow("referenced");
  await send({ type: "settings.update", defaultSlot: null });
  const ruleId = String((await send({ type: "rule.create", tool: "*", when: {}, decision: "review", reviewer: { kind: "slot", slot: "reviewer" } })).ruleId);
  await expect(send({ type: "slot.delete", name: "reviewer" })).rejects.toThrow("referenced");
  await send({ type: "rule.delete", ruleId });
  await send({ type: "slot.delete", name: "reviewer" });
  await send({ type: "config.revert", revisionId: ledger.configRevisions("slot", "reviewer").at(-1)!.id });
  expect(ledger.settings().slots!.reviewer.model.model).toBe("one");
});

test("Ghost and activity owner mutations are revisioned and reversible without discarding history", async () => {
  const { send, ledger, ghost } = fixture();
  const teammateId = String((await send({ type: "ghost.create", name: "Teammate", persona: "", tools: [] })).ghostId);
  const before = ledger.ghost(teammateId);
  await send({ type: "ghost.update", ghostId: teammateId, name: "Renamed", attachments: [{ kind: "skill", name: "writing" }] });
  await send({ type: "config.revert", revisionId: ledger.configRevisions("ghost", teammateId).at(-1)!.id });
  expect(ledger.ghost(teammateId)).toEqual(before);
  const activityId = String((await send({ type: "activity.create", config: {
    ghostId: ghost.id, name: "Periodic", prompt: "Read", acceptanceCriteria: "Evidence",
    source: { kind: "schedule", spec: { kind: "every", seconds: 3600, startAt: Date.now() + 3600_000 } }, execution: { kind: "workspace" }, tools: [],
    policy: { maxRunsPerDay: 1, maxConcurrent: 1, runTimeoutSeconds: 60, allowSelfCheck: false, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" },
  } })).activityId);
  const activity = ledger.activity(activityId);
  await send({ type: "activity.pause", activityId, paused: true });
  await send({ type: "config.revert", revisionId: ledger.configRevisions("activity", activityId).at(-1)!.id });
  expect(ledger.activity(activityId)).toEqual(activity);
});

test("a failed revision write rolls back configuration, events and the API receipt atomically", async () => {
  const { send, ledger } = fixture();
  const seq = ledger.seq();
  const save = ledger.putConfigRevision.bind(ledger);
  ledger.putConfigRevision = () => { throw new Error("revision storage unavailable"); };
  const requestId = crypto.randomUUID();
  await expect(send({ type: "scope.create", name: "Atomic", paths: [] }, requestId)).rejects.toThrow("revision storage unavailable");
  ledger.putConfigRevision = save;
  expect(ledger.scopes()).toEqual([]);
  expect(ledger.seq()).toBe(seq);
  expect(ledger.request(requestId)).toBeNull();
  await send({ type: "scope.create", name: "Atomic", paths: [] }, requestId);
  expect(ledger.scopes()).toHaveLength(1);
  expect(ledger.configRevisions("scope")).toHaveLength(1);
});


test("legacy message origins preserve multiple saved space ids and exact visible text", () => {
  const entry = { id: "message", kind: "pi.user", model: [{ role: "user", content: "Old model-only project prefix\nVisible owner text", timestamp: 1 }] } as EntryRecord;
  const references = [{ id: "deleted-first", name: "First" }, { id: "deleted-second", name: "Second" }];
  const projected = toMessage(entry, "conversation", { origin: "owner", attachments: [], spaces: references, text: "Visible owner text" });
  expect(projected?.text).toBe("Visible owner text");
  expect(projected?.scopes).toEqual(references);
});
