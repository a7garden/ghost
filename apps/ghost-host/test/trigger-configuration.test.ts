import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ActivityConfig, Connection, Scope } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { configurationCommand, connectionMetadata, reviseConfiguration } from "../src/core/configuration.ts";
import { planGhostConfiguration } from "../src/core/ghost-configuration.ts";
import { installMetricTracking, readMetrics, recordMetricUsage } from "../src/core/metrics.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { SourceConnections, connectionRequestIsReadOnly } from "../src/integrations/activity-sources.ts";
import { createConfigurationTools } from "../src/tools/configuration.ts";
import { createSkillsTools } from "../src/tools/skills.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox, tempDir, harness } from "./support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ctx = { abortSignal: undefined } as Context;
const api = (callId: string, conversationId = 501) => ({ conversationId, callId }) as unknown as ToolExecutionApi;
const call = (extension: Extension, name: string, args: unknown, callId: string, conversationId = 501) => extension.tools!.find((tool) => tool.name === name)!.execute(args as never, api(callId, conversationId), ctx);
function scope(id: string, ghostId: string | null, paths: string[] = []): Scope {
  return { id, name: id, ghostId, paths, vaultPath: null, state: "active", attachments: [], limits: {}, createdAt: 1, updatedAt: 1 };
}
function stop(core: Core, ledger: Ledger) { core.stop(); return core.idle().then(() => ledger.close()); }

function pollFixture(root: string, records: { id: string }[], seed = true) {
  const ledger = new Ledger(join(root, "ledger.sqlite"));
  const sources = new SourceConnections({ root, currentConnection: (id) => ledger.findConnection(id), fetch: async () => Response.json({ items: records }) });
  const core = new Core({ ledger, activitySources: sources, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
  core.attach(new FakeEngine());
  const ghost = seed ? core.createGhost({ name: "Watcher", persona: "", model: { provider: "test", model: "test-model" }, tools: ["read"] }) : ledger.ghosts()[0]!;
  const connection: Connection = { id: "account", name: "Account", config: { kind: "api", baseUrl: "https://service.example/api/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "me", headers: {}, ghostIds: [ghost.id] }, hasCredential: true, credentialVersion: "epoch-1", createdAt: 1, updatedAt: 1 };
  if (seed) ledger.tx(() => ledger.putConnection(connection));
  const config: ActivityConfig = { ghostId: ghost.id, scopeId: null, name: "Poll", prompt: "Inspect the item", acceptanceCriteria: "Report the actual item", execution: { kind: "container" }, tools: ["read"], source: { kind: "poll", connectionId: "account", path: "items", itemsPointer: "/items", idPointer: "/id", pollSeconds: 60 }, policy: { maxConcurrent: 1, maxRunsPerDay: 20, runTimeoutSeconds: 300, minCheckSeconds: 60, allowSelfCheck: false, externalActions: "deny", delivery: "changes" } };
  let closed = false;
  return { ledger, core, sources, ghost, config, async close() { if (closed) return; closed = true; await sources.close(); await stop(core, ledger); } };
}

test("poll inbox survives restart and disappearing provider data without duplicate Works", async () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const first = pollFixture(root, [{ id: "a" }, { id: "b" }]);
  cleanups.push(() => first.close());
  await first.sources.setCredential("account", "private-token", "epoch-1");
  const activity = first.core.activities.create(first.config);
  const now = Date.now();
  await first.core.activities.tickSources(now); await first.core.idle();
  const one = first.ledger.activityRuns(activity.id).find((run) => run.workId)!;
  expect(first.ledger.activity(activity.id).cursor).toBeNull();
  const work = first.ledger.work(one.workId!);
  first.ledger.tx(() => first.ledger.putWork({ ...work, state: "done", endedAt: now + 1, updatedAt: now + 1 }));
  await first.close();
  const restarted = pollFixture(root, [], false); cleanups.push(() => restarted.close());
  await restarted.core.activities.tickSources(now + 60_001); await restarted.core.idle();
  const runs = restarted.ledger.activityRuns(activity.id).filter((run) => run.workId);
  expect(runs).toHaveLength(2);
  expect(new Set(runs.map((run) => run.sourceItem!.id)).size).toBe(2);
  expect(restarted.ledger.activity(activity.id).cursor).not.toBeNull();
  const second = restarted.ledger.work(runs.find((run) => run.id !== one.id)!.workId!);
  restarted.ledger.tx(() => restarted.ledger.putWork({ ...second, state: "done", endedAt: now + 60_002, updatedAt: now + 60_002 }));
  await restarted.core.activities.tickSources(now + 120_002);
  expect(restarted.ledger.activityRuns(activity.id).filter((run) => run.workId)).toHaveLength(2);
  const account = restarted.ledger.connection("account");
  restarted.ledger.tx(() => restarted.ledger.putConnection({ ...account, config: { ...account.config, kind: "api", ghostIds: [] } as Connection["config"] }));
  await restarted.core.activities.tickSources(now + 180_003);
  expect(restarted.ledger.activity(activity.id).lastError).toContain("not granted");
});

test("poll pointers, pagination, malformed responses and credential epochs are explicit", async () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const connection: Connection = { id: "account", name: "API", config: { kind: "api", baseUrl: "https://service.example/api/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "me", headers: {}, ghostIds: ["ghost"] }, hasCredential: true, credentialVersion: "epoch-1", createdAt: 1, updatedAt: 1 };
  let current = connection;
  let malformed = false;
  const source = { kind: "poll" as const, connectionId: "account", path: "items", itemsPointer: "/data/items", idPointer: "/i~1d", pollSeconds: 60 };
  const sources = new SourceConnections({ root, currentConnection: () => current, fetch: async (input) => {
    if (malformed) return new Response("not json");
    const page2 = new URL(String(input)).searchParams.has("page");
    return Response.json({ data: { items: [{ "i/d": page2 ? "b" : "a" }] } }, page2 ? {} : { headers: { Link: '</api/items?page=2>; rel="next"' } });
  } }); cleanups.push(() => sources.close());
  await sources.setCredential("account", "secret-token", "epoch-1");
  const result = await sources.poll(connection, source, null);
  expect(result.items).toHaveLength(2);
  await expect(sources.read(connection, { ...result.items[0]!, id: result.items[1]!.id })).rejects.toThrow("does not match");
  expect((await sources.poll(connection, source, result.cursor)).items).toEqual([]);
  malformed = true;
  await expect(sources.poll(connection, source, result.cursor)).rejects.toThrow("malformed JSON");
  malformed = false;
  const authority = await sources.mcpAuthority(connection);
  await sources.rotateCredential("account", "rotated-token", "epoch-1");
  expect(() => authority.authorize()).toThrow("rotated");
  expect((await sources.mcpAuthority(connection)).headers.Authorization).toBe("Bearer rotated-token");
  current = { ...connection, credentialVersion: "epoch-2" };
  await sources.setCredential("account", "replacement-token", "epoch-2");
  await expect(sources.poll(connection, source, result.cursor)).rejects.toThrow("changed");
  await expect(sources.poll(current, source, result.cursor)).rejects.toThrow("old account");
});

test("owner read-path classification is method-bound, base-relative and ignores query", () => {
  const connection: Connection = { id: "account", name: "RPC", config: { kind: "api", baseUrl: "https://service.example/api/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "me", headers: {}, ghostIds: [], readPaths: [{ method: "POST", path: "/search/*" }] }, hasCredential: true, credentialVersion: "1", createdAt: 1, updatedAt: 1 };
  expect(connectionRequestIsReadOnly(connection, "POST", "search/messages?q=private")).toBe(true);
  expect(connectionRequestIsReadOnly(connection, "DELETE", "search/messages")).toBe(false);
  expect(connectionRequestIsReadOnly(connection, "POST", "searches/messages")).toBe(false);
});

test("commit triggers watch every scope repository directly from Git metadata", async () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const f = pollFixture(root, []); cleanups.push(() => f.close());
  const paths = [join(root, "repo-one"), join(root, "repo-two")];
  const old = "1".repeat(40), next = "2".repeat(40);
  for (const path of paths) {
    mkdirSync(join(path, ".git", "refs", "heads"), { recursive: true });
    mkdirSync(join(path, ".git", "logs"), { recursive: true });
    writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(path, ".git", "refs", "heads", "main"), `${old}\n`);
    writeFileSync(join(path, ".git", "logs", "HEAD"), `${"0".repeat(40)} ${old} Owner <owner@example.com> 1 +0000\tcommit: initial\n`);
  }
  f.ledger.tx(() => f.ledger.putScope(scope("repos", f.ghost.id, paths)));
  const activity = f.core.activities.create({ ...f.config, scopeId: "repos", source: { kind: "commit", scopeId: "repos" }, policy: { ...f.config.policy, maxConcurrent: 2 } });
  const now = Date.now();
  await f.core.activities.tickSources(now);
  expect(f.ledger.activityRuns(activity.id).filter((run) => run.workId)).toHaveLength(0);
  for (const path of paths) {
    writeFileSync(join(path, ".git", "refs", "heads", "main"), `${next}\n`);
    writeFileSync(join(path, ".git", "logs", "HEAD"), `${"0".repeat(40)} ${old} Owner <owner@example.com> 1 +0000\tcommit: initial\n${old} ${next} Owner <owner@example.com> ${Math.floor(now / 1000) + 1} +0000\tcommit: changed\n`);
  }
  await f.core.activities.tickSources(now + 60_001); await f.core.idle();
  const runs = f.ledger.activityRuns(activity.id).filter((run) => run.workId);
  expect(runs).toHaveLength(2);
  expect(new Set(runs.map((run) => run.sourceItem!.target.path))).toEqual(new Set(paths));
  expect(runs.every((run) => f.ledger.work(run.workId!).scopeId === "repos")).toBe(true);
});
test("scope receiver tightens locally, cannot alter globals or other scopes, widening asks once", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  f.core.createGhost({ name: "Main", persona: "" });
  const receiver = f.core.createGhost({ name: "Receiver", persona: "", tools: ["scope_update", "limits_set", "config_revert"] });
  f.ledger.setPiConversationId(receiver.directConversationId, "501");
  f.ledger.tx(() => { f.ledger.putScope(scope("own", receiver.id)); f.ledger.putScope(scope("other", null)); });

  const extension = createConfigurationTools(f.core);
  const tightened = await call(extension, "limits_set", { scopeId: "own", limits: { rootNodes: 2 }, reason: "Keep the tree bounded" }, "tighten");
  expect(tightened.isError).toBeFalsy(); expect(f.ledger.limits("own").rootNodes).toBe(2);
  expect(f.ledger.configRevisions("limits", "own").at(-1)?.actor).toEqual({ kind: "ghost", id: receiver.id });
  const tightening = f.ledger.configRevisions("limits", "own").at(-1)!;
  expect(planGhostConfiguration(f.core, receiver.id, { type: "config.revert", revisionId: tightening.id }).widening).toBe(true);
  expect((await call(extension, "limits_set", { limits: { rootNodes: 1 }, reason: "Global" }, "global")).isError).toBe(true);
  expect((await call(extension, "scope_update", { scopeId: "other", name: "No", reason: "Other scope" }, "other")).isError).toBe(true);
  const args = { scopeId: "own", limits: { rootNodes: 5 }, reason: "The observed task needs five nodes" };
  await call(extension, "limits_set", args, "widen"); await f.core.idle();
  await call(extension, "limits_set", args, "widen");
  const pending = f.ledger.pendingDecisions().find((decision) => decision.effectId)!;
  expect(pending.proposal?.forceOwner).toBe(true); expect(f.ledger.pendingDecisions()).toHaveLength(1);
  await f.core.decisions.resolve(pending.id, { outcome: "approve" }); await f.core.idle();
  expect(f.ledger.limits("own").rootNodes).toBe(5);
  f.ledger.tx(() => { const own = f.ledger.scope("own"); f.ledger.putScope({ ...own, limits: { rootNodes: 1 } }); });
  await call(extension, "limits_set", args, "widen");
  expect(f.ledger.limits("own").rootNodes).toBe(1);
  await call(extension, "limits_set", { ...args, limits: { rootNodes: 6 } }, "revoked-before-approval");
  const stale = f.ledger.pendingDecisions().find((decision) => decision.effectId)!;
  f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(receiver.id), tools: [] }));
  await f.core.decisions.resolve(stale.id, { outcome: "approve" }); await f.core.idle();
  expect(f.ledger.limits("own").rootNodes).toBe(1);
});

test("configuration history restores deletion and rejects newer revisions", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  f.ledger.tx(() => f.ledger.putScope(scope("own", null)));
  const apply = (command: Parameters<typeof configurationCommand>[1]) => f.ledger.tx(() => reviseConfiguration(f.core, { kind: "owner" }, command, () => configurationCommand(f.core, command)));
  apply({ type: "scope.update", scopeId: "own", name: "New" });
  const old = f.ledger.configRevisions("scope", "own").at(-1)!;
  apply({ type: "scope.update", scopeId: "own", name: "Newer" });
  expect(() => apply({ type: "config.revert", revisionId: old.id })).toThrow("newer revision");
  apply({ type: "scope.delete", scopeId: "own" });
  const deletion = f.ledger.configRevisions("scope", "own").at(-1)!;
  apply({ type: "config.revert", revisionId: deletion.id });
  expect(f.ledger.scope("own").name).toBe("Newer");
});
test("metrics use actual outcomes, time, incremental Pi usage and stored rule ids", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  const ghost = f.core.createGhost({ name: "Worker", persona: "" });
  installMetricTracking(f.ledger);
  const work = f.core.works.createRoot({ ghostId: ghost.id, title: "Actual", brief: "Do it", originConversationId: ghost.directConversationId });
  await f.core.idle();
  const current = f.ledger.work(work.id);
  const conversationId = current.conversationId!;
  recordMetricUsage(f.ledger, conversationId, 1, { totalTokens: 80, cost: { total: 0.4 } });
  recordMetricUsage(f.ledger, conversationId, 1, { totalTokens: 80, cost: { total: 0.4 } });
  recordMetricUsage(f.ledger, conversationId, 2, { totalTokens: 20, cost: { total: 0.1 } });
  f.ledger.tx(() => f.ledger.putWork({ ...current, state: "done", startedAt: 100, endedAt: 1100, updatedAt: 1100 }));
  f.ledger.tx(() => f.ledger.putDecision({ id: "decision", kind: "approve_effect", ghostId: ghost.id, conversationId, workId: work.id, effectId: null, title: "Rule decision", detail: "", options: [], proposal: { policy: { evaluation: { ruleIds: ["rule"], decidedBy: ["rule"] } } }, state: "approved", answer: null, createdAt: 1, resolvedAt: 2 }));
  const metrics = readMetrics(f.ledger, { ghostId: ghost.id, ruleId: "rule" });
  expect(metrics).toMatchObject({ completed: 1, rejected: 0, completionRate: 1, elapsedMsPerAcceptedWork: 1000, tokensPerAcceptedWork: 100, costPerAcceptedWork: 0.5, rules: { rule: { approved: 1, denied: 0 } } });
  recordMetricUsage(f.ledger, conversationId, 3, { totalTokens: 10 });
  expect(readMetrics(f.ledger).costPerAcceptedWork).toBeNull();
  expect(readMetrics(f.ledger).tokensPerAcceptedWork).toBe(110);
});

test("compiled guide is readable without an external skill installation or per-Ghost attachment", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  const ghost = f.core.createGhost({ name: "Reader", persona: "", tools: [], skills: [] });
  f.ledger.setPiConversationId(ghost.directConversationId, "501");
  const result = await call(createSkillsTools(f.core, null), "skill_read", { name: "ghost-guide", path: "SKILL.md" }, "guide");
  expect(result.isError).toBeFalsy(); expect(JSON.stringify(result.content)).toContain("Organizing work on Ghost");
});

test("quota wait, repeated failures and owner-overturned verdicts use observed transitions", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  const ghost = f.core.createGhost({ name: "Measured", persona: "" });
  installMetricTracking(f.ledger);
  const created = f.core.works.createRoot({ ghostId: ghost.id, title: "Measured", brief: "Observe transitions", originConversationId: ghost.directConversationId });
  await f.core.idle();
  const work = f.ledger.work(created.id);
  const clock = spyOn(Date, "now");
  try {
    clock.mockReturnValue(1000);
    f.ledger.tx(() => f.ledger.putWork({ ...work, hold: "quota" }));
    clock.mockReturnValue(3500);
    f.ledger.tx(() => f.ledger.putWork({ ...work, hold: "repeat", state: "blocked", verdict: { source: "review", outcome: "fail", reasons: "Observed failure", at: 3500 } }));
    clock.mockReturnValue(4000);
    f.ledger.tx(() => f.ledger.putWork({ ...work, hold: null, state: "done", endedAt: 4000, verdict: { source: "owner", outcome: "pass", reasons: "Owner checked the result", at: 4000 } }));
    expect(readMetrics(f.ledger, { ghostId: ghost.id }, 5000)).toMatchObject({ quotaWaitMs: 2500, repeatGuardHits: 1, ownerOverturnedVerdicts: 1 });
  } finally { clock.mockRestore(); }
});

test("connection audit snapshots exclude authentication and safe restore never resurrects credentials", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  const main = f.core.createGhost({ name: "Main", persona: "" });
  const base: Connection = { id: "connection", name: "Service", config: { kind: "api", baseUrl: "https://service.example/api/", authHeader: "Authorization", authPrefix: "Bearer", testPath: "me", headers: {}, ghostIds: [main.id] }, hasCredential: true, credentialVersion: "live-epoch", createdAt: 1, updatedAt: 2 };
  const unsafe = { ...base, credential: "never-record", oauthState: "never-record", config: { ...base.config, access_token: "never-record", headers: { Authorization: "never-record", "X-Api-Key": "never-record", "X-Version": "1" } } } as unknown as Connection;
  const safe = connectionMetadata(unsafe)!;
  expect(JSON.stringify(safe)).not.toContain("never-record");
  expect(safe).not.toHaveProperty("hasCredential");
  expect(safe).not.toHaveProperty("credentialVersion");
  expect(safe).not.toHaveProperty("updatedAt");
  const apply = (revisionId: string) => f.ledger.tx(() => reviseConfiguration(f.core, { kind: "owner" }, { type: "config.revert", revisionId }, () => configurationCommand(f.core, { type: "config.revert", revisionId })));
  f.ledger.tx(() => {
    f.ledger.putConnection(base);
    f.ledger.putConfigRevision({ id: "deleted", entity: "connection", entityId: base.id, before: connectionMetadata(base), after: null, actor: { kind: "owner", id: null }, reason: "Delete metadata", at: 3 });
    f.ledger.deleteConnection(base.id);
  });
  expect(planGhostConfiguration(f.core, main.id, { type: "config.revert", revisionId: "deleted" }).widening).toBe(true);
  apply("deleted");
  expect(f.ledger.connection(base.id)).toMatchObject({ hasCredential: false, credentialVersion: null, config: base.config });
  const metadata = connectionMetadata(f.ledger.connection(base.id));
  f.ledger.tx(() => f.ledger.putConfigRevision({ id: "auth-only", entity: "connection", entityId: base.id, before: metadata, after: metadata, actor: { kind: "owner", id: null }, reason: "Credential replacement requested", at: 4 }));
  expect(() => apply("auth-only")).toThrow("Authentication-only");
  const other = { ...base, config: { ...base.config, baseUrl: "https://other.example/api/" } } as Connection;
  f.ledger.tx(() => {
    f.ledger.putConnection(other);
    f.ledger.putConfigRevision({ id: "endpoint", entity: "connection", entityId: base.id, before: connectionMetadata(base), after: connectionMetadata(other), actor: { kind: "owner", id: null }, reason: "Move endpoint", at: 5 });
  });
  expect(() => apply("endpoint")).toThrow("Authentication endpoints");
  expect(f.ledger.connection(base.id).credentialVersion).toBe("live-epoch");
});

test("rule metrics include policy denials without owner cards and deduplicate allowed receipts", async () => {
  const f = harness(); cleanups.push(() => stop(f.core, f.ledger));
  const ghost = f.core.createGhost({ name: "Policy caller", persona: "" });
  f.ledger.tx(() => f.ledger.putScope(scope("own", ghost.id)));
  for (const [id, state, decision] of [["denied-effect", "denied", "deny"], ["allowed-effect", "done", "allow"]] as const) {
    const policy = { scopeId: "own", ghostId: ghost.id, evaluation: { decision, ruleIds: ["rule"], decidedBy: ["rule"], reviewers: [], autoResolve: null, reason: "Stored policy" } };
    f.ledger.tx(() => {
      f.ledger.putEffect({ id, conversationId: ghost.directConversationId, workId: null, callId: id, tool: "connection_request", inputDigest: "0".repeat(64), summary: "Observed request", state, result: decision, createdAt: 1, endedAt: 2 });
      f.ledger.putSetting(`policy:effect:${id}`, policy);
      if (decision === "allow") f.ledger.putDecision({ id: "allowed-receipt", kind: "approve_effect", ghostId: ghost.id, conversationId: ghost.directConversationId, workId: null, effectId: id, title: "Allowed", detail: "", options: [], proposal: { policy }, state: "approved", answer: null, createdAt: 1, resolvedAt: 2 });
    });
  }
  expect(readMetrics(f.ledger, { scopeId: "own", ruleId: "rule" }).rules).toEqual({ rule: { approved: 1, denied: 1 } });
});

test("activity wildcard scopes intersect concrete live Ghost grants and preserve edited rules on restart", async () => {
  const root = tempDir(); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const f = pollFixture(root, [{ id: "item" }]); cleanups.push(() => f.close());
  await f.sources.setCredential("account", "private-token", "epoch-1");
  const activity = f.core.activities.create({ ...f.config, tools: ["*"] });
  await f.core.activities.tickSources(); await f.core.idle();
  const workId = f.ledger.activityRuns(activity.id).find((run) => run.workId)!.workId!;
  expect(f.core.activities.authorize(workId, "read").activity.id).toBe(activity.id);
  expect(() => f.core.activities.authorize(workId, "bash")).toThrow("outside");
  f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), tools: ["read", "conn.account"] }));
  expect(f.core.activities.authorize(workId, "conn.account").activity.id).toBe(activity.id);
  const rule = f.ledger.policyRule(`activity:${activity.id}:action`);
  f.ledger.tx(() => f.ledger.putPolicyRule({ ...rule, decision: "owner", revision: rule.revision + 1 }));
  f.core.activities.update(activity.id, activity.revision, { ...f.config, tools: ["*"], name: "Renamed only" });
  expect(f.ledger.policyRule(rule.id).decision).toBe("owner");
  await f.close();
  const restarted = pollFixture(root, [], false); cleanups.push(() => restarted.close());
  expect(restarted.ledger.policyRule(rule.id)).toMatchObject({ decision: "owner", revision: rule.revision + 1 });
});
