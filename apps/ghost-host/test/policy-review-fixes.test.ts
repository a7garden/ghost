import { afterEach, expect, test } from "bun:test";
import { CAPABILITY_GRANT, type PolicyRule } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { classifyEffect, evaluateStoredPolicy, policyRead, policyTaint } from "../src/core/policy-context.ts";
import { createBrowserTools } from "../src/tools/browser.ts";
import { classifyDesktopEffect } from "../src/tools/desktop.ts";
import { createMainTools } from "../src/tools/main.ts";
import type { BrowserPort, BrowserRunOptions, BrowserSessionRef } from "../src/integrations/ports.ts";
import { harness } from "./support.ts";

const opened: { core: Core; ledger: Ledger }[] = [];
afterEach(async () => { for (const h of opened.splice(0)) { h.core.stop(); await h.core.idle(); h.ledger.close(); } });
function setup() {
  const h = harness(); opened.push(h);
  const main = h.core.createGhost({ name: "Main", persona: "" });
  const ghost = h.core.createGhost({ name: "Reader", persona: "", tools: ["web_read", "browser_read", "browser_open"] });
  h.ledger.setPiConversationId(ghost.directConversationId, "reader-pi");
  return { ...h, main, ghost, conversationId: ghost.directConversationId };
}
const rule = (id: string, decision: PolicyRule["decision"], extra: Partial<PolicyRule> = {}): PolicyRule => ({ id, tool: "*", when: {}, decision, revision: 1, createdBy: { kind: "owner" }, ...extra });
const read = { tool: "web_read", target: { kind: "browser_origin" as const, id: "https://8.8.8.8" }, access: "read" as const, reversible: true, external: false, amount: null };

test("read reservations charge once per call and cannot race another read", () => {
  const h = setup();
  h.ledger.tx(() => { for (const old of h.ledger.policyRules()) h.ledger.deletePolicyRule(old.id); h.ledger.putPolicyRule(rule("one-read", "allow", { tool: "web_read", maxPerDay: 1 })); });
  policyRead(h.core, h.conversationId, read, "first");
  policyRead(h.core, h.conversationId, read, "first");
  expect(() => policyRead(h.core, h.conversationId, read, "second")).toThrow("1 a day");
  const day = new Date(Date.now()).toISOString().slice(0, 10);
  expect(h.ledger.setting<Record<string, number>>(`policy:counts:${day}`, {})["one-read"]).toBe(1);
  expect(h.ledger.effectsInState("done")).toHaveLength(0);
});

test("connection and MCP reads taint private data before a later outward action", () => {
  for (const kind of ["connection", "mcp_server"] as const) {
    const h = setup();
    policyRead(h.core, h.conversationId, { ...read, tool: `${kind}.read`, target: { kind, id: "account" } }, kind);
    expect(policyTaint(h.core, h.conversationId)).toEqual({ untrustedInput: true, privateData: true });
    const effect = classifyEffect(h.core, h.conversationId, "browser_upload", null, { target: { kind: "browser_origin", id: "https://8.8.8.8" }, access: "write", reversible: true, external: true, amount: null });
    expect(h.ledger.tx(() => evaluateStoredPolicy(h.core, h.conversationId, effect)).evaluation.decidedBy).toContain("rule-of-two");
  }
});

test("an origin deny stops browser navigation and read exposure", async () => {
  const h = setup();
  let bodyReads = 0, opens = 0;
  const browser = { run: async (_ref: BrowserSessionRef, argv: string[], options?: BrowserRunOptions) => {
    options?.authorize?.();
    if (argv[0] === "open") opens++;
    if (argv[0] === "get" && argv[1] === "url") return { ok: true, data: "https://8.8.8.8/private", error: null };
    if (argv[0] === "get" && argv[1] === "text") { bodyReads++; return { ok: true, data: "private body", error: null }; }
    return { ok: true, data: {}, error: null };
  } } as BrowserPort;
  const extension = createBrowserTools(h.core, browser, { vault: null, sandbox: {} as never });
  h.ledger.tx(() => h.ledger.putPolicyRule(rule("origin-deny", "deny", { when: { targetKind: "browser_origin", targetId: "https://8.8.8.8" } })));
  for (const [name, args] of [["browser_open", { url: "https://8.8.8.8/private" }], ["browser_read", {}]] as const) {
    const tool = extension.tools!.find((entry) => entry.name === name)!;
    const result = await tool.execute(args as never, { conversationId: "reader-pi", callId: name } as unknown as ToolExecutionApi, {} as Context);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private body");
  }
  expect(opens).toBe(0); expect(bodyReads).toBe(0);
});

test("a named slot is passed to the reviewer wake, not only recorded in the audit", async () => {
  const h = setup();
  const slots: (string | undefined)[] = [];
  Object.assign(h.engine, { wake: async (_ghostId: string, _submission: unknown, options?: { slot?: string }) => { slots.push(options?.slot); } });
  h.ledger.tx(() => {
    h.ledger.putSetting("slots", { careful: { model: { provider: "provider", model: "model" }, fallbacks: [] } });
    for (const old of h.ledger.policyRules()) h.ledger.deletePolicyRule(old.id);
    h.ledger.putPolicyRule(rule("slot-review", "review", { tool: "document_propose", reviewer: { kind: "slot", slot: "careful" } }));
  });
  const decision = h.ledger.tx(() => h.core.decisions.open({ kind: "document_review", ghostId: h.ghost.id, conversationId: h.conversationId, workId: null, effectId: null, title: "Review", detail: "Draft", options: [], proposal: { title: "Draft", body: "Text", pageId: null } }));
  await h.core.decisions.settleExpired();
  expect(slots).toContain("careful");
  expect(h.ledger.decision(decision.id).state).toBe("pending");
});

test("main cannot grant subordinate or own widening through capability review", async () => {
  const h = setup();
  for (const ghost of [h.ghost, h.main]) {
    const decision = h.core.decisions.ask(ghost.directConversationId, "PC permission", "Grant PC execution", [CAPABILITY_GRANT], undefined, { capability: { ghostId: ghost.id, tools: ["host_read"], hostExecution: true }, review: { recommend: "answer", answer: CAPABILITY_GRANT, expiresAt: null } });
    await expect(h.core.decisions.settleForOwner(h.main.id, decision.id, { outcome: "answer", answer: CAPABILITY_GRANT, note: "Grant" })).rejects.toThrow();
    await h.core.decisions.settleExpired(decision.createdAt + 86_400_000);
    expect(h.ledger.ghost(ghost.id).hostExecution).toBe(false);
    expect(h.ledger.decision(decision.id).state).toBe("pending");
  }
});

test("physical input uses observed target/action without blanket irreversible classification", () => {
  expect(classifyDesktopEffect({ appId: "editor", label: "Document text", local: false })).toMatchObject({ reversible: true, external: true, amount: null });
  expect(classifyDesktopEffect({ appId: "editor", local: true })).toMatchObject({ reversible: true, external: false, amount: null });
  expect(classifyDesktopEffect({ appId: "bank", label: "Pay now", local: false })).toMatchObject({ reversible: false, external: true, amount: { value: null } });
  expect(classifyDesktopEffect({ appId: "unknown", local: false }).reversible).toBe(false);
});

test("helper reads retain the parent's live activity trigger and reject invalid provenance", async () => {
  const h = setup();
  const now = Date.now();
  const activity = h.core.activities.create({ ghostId: h.ghost.id, scopeId: null, name: "Read source", prompt: "Read only", acceptanceCriteria: "Report evidence", execution: { kind: "container" }, tools: ["web_read"], source: { kind: "schedule", spec: { kind: "every", seconds: 3600, startAt: now } }, policy: { maxRunsPerDay: 20, maxConcurrent: 1, runTimeoutSeconds: 300, allowSelfCheck: true, minCheckSeconds: 60, externalActions: "deny", delivery: "changes" } });
  const admitted = await h.core.activities.run(activity.id);
  await h.core.idle();
  const run = h.ledger.findActivityRun(admitted.runIds[0]!)!;
  const work = h.ledger.work(run.workId!);
  const helper = h.core.newConversation(h.ghost.id, "subagent", null, "Reader helper");
  h.ledger.tx(() => {
    h.ledger.putConversation(helper);
    h.ledger.putSetting(`subagent:parent:${helper.id}`, work.conversationId);
    h.ledger.putPolicyRule(rule("trigger-read-deny", "deny", { triggerId: activity.id, tool: "web_read" }));
    h.ledger.putSetting(`subagent:work:${helper.id}`, work.id);
    h.ledger.putSetting(`subagent:scope:${helper.id}`, work.scopeId);
  });
  expect(() => policyRead(h.core, helper.id, read, "helper-read")).toThrow("trigger-read-deny");
  h.ledger.tx(() => h.ledger.putSetting(`subagent:work:${helper.id}`, "different-work"));
  expect(() => policyRead(h.core, helper.id, read, "moved-work")).toThrow("binding");
  h.ledger.tx(() => h.ledger.putSetting(`subagent:parent:${helper.id}`, h.main.directConversationId));
  expect(() => policyRead(h.core, helper.id, read, "invalid-parent")).toThrow("provenance");
});

test("a decision wake can settle only its bound card and cannot manage Ghosts", async () => {
  const h = setup();
  const cards = ["One", "Two"].map((title) => h.ledger.tx(() => h.core.decisions.open({
    kind: "document_review", ghostId: h.ghost.id, conversationId: h.conversationId,
    workId: null, effectId: null, title, detail: "Draft", options: [], proposal: { title, body: "Text", pageId: null },
  })));
  const wake = h.core.newConversation(h.main.id, "wake", null, "Decision review");
  h.ledger.tx(() => {
    h.ledger.putConversation(wake);
    h.ledger.setPiConversationId(wake.id, "bound-review-pi");
    h.ledger.putSetting(`wake:decision:${wake.id}`, cards[0]!.id);
  });
  const extension = createMainTools(h.core);
  const invoke = (name: string, args: unknown) => extension.tools!.find((tool) => tool.name === name)!.execute(args as never, { conversationId: "bound-review-pi", callId: name } as unknown as ToolExecutionApi, {} as Context);
  expect((await invoke("decision_settle", { decision_id: cards[1]!.id, outcome: "leave", note: "Wrong card" })).isError).toBe(true);
  expect((await invoke("decision_settle", { decision_id: cards[0]!.id, outcome: "leave", note: "Independent review" })).isError).toBeFalsy();
  expect((await invoke("ghost_create", { name: "Unrelated", persona: "No", reason: "No" })).isError).toBe(true);
  expect(h.ledger.ghosts().some((ghost) => ghost.name === "Unrelated")).toBe(false);
});

test("Work policy inherits the immutable source taint snapshot", async () => {
  const h = setup();
  const work = h.core.works.createRoot({ ghostId: h.ghost.id, title: "Source", brief: "Read", originConversationId: h.conversationId });
  await h.core.idle();
  h.ledger.tx(() => h.ledger.putSetting(`work:source-taint:${work.id}`, { untrustedInput: true, privateData: true }));
  expect(policyTaint(h.core, h.ledger.work(work.id).conversationId!)).toEqual({ untrustedInput: true, privateData: true });
});
