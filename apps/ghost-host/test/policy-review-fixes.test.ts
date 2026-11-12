import { afterEach, expect, test } from "bun:test";
import { CAPABILITY_GRANT, type PolicyRule } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { classifyEffect, evaluateStoredPolicy, policyRead, policyTaint } from "../src/core/policy-context.ts";
import { digestOf } from "../src/core/ids.ts";
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

function slotReview() {
  const h = setup();
  const slot = { model: { provider: "provider", model: "model" }, fallbacks: [{ provider: "fallback", model: "secondary", thinking: "low" }] };
  Object.assign(h.engine, { wake: async () => {} });
  h.ledger.tx(() => {
    h.ledger.putSetting("slots", { careful: slot });
    for (const old of h.ledger.policyRules()) h.ledger.deletePolicyRule(old.id);
    h.ledger.putPolicyRule(rule("slot-review", "review", { tool: "document_propose", reviewer: { kind: "slot", slot: "careful" } }));
  });
  const decision = h.ledger.tx(() => h.core.decisions.open({ kind: "document_review", ghostId: h.ghost.id, conversationId: h.conversationId, workId: null, effectId: null, title: "Review", detail: "Draft", options: [], proposal: { title: "Draft", body: "Text", pageId: null } }));
  const wake = h.core.newConversation(h.main.id, "wake", null, "Slot review");
  h.ledger.tx(() => {
    h.ledger.putConversation(wake);
    h.ledger.setPiConversationId(wake.id, "slot-review-pi");
    h.ledger.putSetting(`wake:decision:${wake.id}`, decision.id);
    h.ledger.putSetting(`wake:slot:${wake.id}`, "careful");
    h.ledger.putSetting(`wake:slot-config:${wake.id}`, digestOf(slot));
  });
  const tool = createMainTools(h.core).tools!.find((entry) => entry.name === "decision_settle")!;
  let sequence = 0;
  const invoke = (actual: () => Promise<unknown>, agent = async () => ({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off" })) => {
    const callId = `slot-${++sequence}`;
    const args = { decision_id: decision.id, outcome: "leave", note: "Independent slot review" };
    const commit = async (read: (tx: unknown) => Promise<unknown>) => {
      const execution = await actual() as { model: { provider: string; modelId: string }; thinkingLevel: string; invalid?: string };
      const message = { role: "assistant", provider: execution.model.provider, model: execution.model.modelId, content: [{ type: "toolCall", id: callId, name: "decision_settle", arguments: args }] };
      const request = { generationTaskId: "73", attempt: 1, cutoff: "70", provider: message.provider, model: message.model, thinking: execution.thinkingLevel, slotDigest: digestOf(slot), ...(execution.invalid ? { invalid: execution.invalid } : {}) };
      h.ledger.tx(() => {
        h.ledger.putSetting(`policy:review-request:${wake.id}:73:1:70`, request);
        h.ledger.putSetting(`policy:review-response:${wake.id}:${callId}`, { ...request, messageDigest: digestOf(message) });
      });
      return read({ task: async (id: unknown) => id === 73 ? { kind: "pi.generation", conversationId: "slot-review-pi", state: { checkpoint: { phase: "tools", assistant: 75 } } } : { kind: "pi.tool", conversationId: "slot-review-pi", owner: 73, input: { assistant: 75, callId } }, entry: async () => ({ kind: "pi.assistant", conversationId: "slot-review-pi", model: [message] }) });
    };
    return tool.execute(args as never, { conversationId: "slot-review-pi", taskId: 74, callId, agent, commit } as unknown as ToolExecutionApi, {} as Context);
  };
  return { ...h, slot, decision, wake, invoke };
}

test("slot review uses the actual primary or fallback execution, not nullable Conversation.model", async () => {
  const h = slotReview();
  expect(h.wake.model).toBeNull();
  expect((await h.invoke(async () => ({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off" }))).isError).toBeFalsy();
  expect((await h.invoke(async () => ({ model: { provider: "fallback", modelId: "secondary" }, thinkingLevel: "low" }))).isError).toBeFalsy();
  expect(h.ledger.decision(h.decision.id).proposal!.reviewedBy).toMatchObject({ ghostId: h.main.id, slot: "careful" });
});

test("slot review fails closed for wrong execution, wrong binding or changed configuration", async () => {
  const h = slotReview();
  expect((await h.invoke(async () => ({ model: { provider: "wrong", modelId: "model" }, thinkingLevel: "off" }))).isError).toBe(true);
  expect((await h.invoke(async () => ({ model: { provider: "fallback", modelId: "secondary" }, thinkingLevel: "off" }))).isError).toBe(true);
  h.ledger.tx(() => h.ledger.putSetting(`wake:slot:${h.wake.id}`, "different"));
  expect((await h.invoke(async () => ({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off" }))).isError).toBe(true);
  h.ledger.tx(() => {
    h.ledger.putSetting(`wake:slot:${h.wake.id}`, "careful");
    h.ledger.putSetting("slots", { careful: { ...h.slot, fallbacks: [] } });
  });
  expect((await h.invoke(async () => ({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off" }))).isError).toBe(true);
  expect(h.ledger.decision(h.decision.id).proposal!.reviewedBy).toBeUndefined();
});

test("a slot change during actual execution lookup revokes settlement before audit mutation", async () => {
  const h = slotReview();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<unknown>();
  const result = h.invoke(() => { entered.resolve(); return release.promise; });
  await entered.promise;
  h.ledger.tx(() => h.ledger.putSetting("slots", { careful: { ...h.slot, model: { provider: "other", model: "other" } } }));
  release.resolve({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off" });
  expect((await result).isError).toBe(true);
  expect(h.ledger.decision(h.decision.id).proposal!.reviewedBy).toBeUndefined();
});

test("an invalidated immutable response proof never settles even when its model matches", async () => {
  const h = slotReview();
  const result = await h.invoke(async () => ({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off", invalid: "Slot changed during generation" }));
  expect(result.isError).toBe(true);
  expect(h.ledger.decision(h.decision.id).proposal!.reviewedBy).toBeUndefined();
});

test("restoring slot A cannot disguise a settlement generated under slot B as phase-agent A", async () => {
  const h = slotReview();
  const generatedUnderB = { model: { provider: "provider", modelId: "different-model" }, thinkingLevel: "high" };
  h.ledger.tx(() => h.ledger.putSetting("slots", { careful: { model: { provider: "provider", model: "different-model", thinking: "high" }, fallbacks: [] } }));
  h.ledger.tx(() => h.ledger.putSetting("slots", { careful: h.slot }));
  const result = await h.invoke(async () => generatedUnderB, async () => ({ model: { provider: "provider", modelId: "model" }, thinkingLevel: "off" }));
  expect(result.isError).toBe(true);
  expect(h.ledger.decision(h.decision.id).proposal!.reviewedBy).toBeUndefined();
});

test("scheduled and awaited allow dispatch share a single effect execution", async () => {
  const h = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  h.ledger.tx(() => {
    for (const old of h.ledger.policyRules()) h.ledger.deletePolicyRule(old.id);
    h.ledger.putPolicyRule(rule("explicit-allow", "allow"));
  });
  h.core.effects.onApproved("mail_send", async () => { calls++; entered.resolve(); await release.promise; return "sent"; });
  const effect = h.core.effects.propose({ conversationId: h.main.directConversationId, callId: "single-flight", tool: "mail_send", input: {}, summary: "Send", title: "Allowed send", detail: "Explicit policy allowance", proposal: { input: {} } });
  const first = h.core.effects.resolveApproval(effect.id, true);
  const second = h.core.effects.resolveApproval(effect.id, true);
  await entered.promise;
  expect(calls).toBe(1);
  release.resolve();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(h.ledger.effect(effect.id).state).toBe("done");
});

test("owner-only credential, handoff, capability and configuration floors never replace deny", () => {
  const h = setup();
  h.ledger.tx(() => h.ledger.putPolicyRule(rule("explicit-deny", "deny")));
  for (const proposal of [
    { forceOwner: true },
    { secureForm: { kind: "login" } },
    { browserHandoff: { reason: "Sign in" } },
    { capability: { ghostId: h.ghost.id, tools: ["host_read"], hostExecution: true } },
  ]) {
    const decision = h.core.decisions.ask(h.conversationId, "Denied request", "Do not perform", [CAPABILITY_GRANT], undefined, proposal);
    expect(decision.state).toBe("denied");
    expect(decision.proposal!.policy).toMatchObject({ evaluation: { decision: "deny", decidedBy: ["explicit-deny"] } });
  }
});

test("top-level forceOwner is durable and cannot suppress later explicit effect denial", async () => {
  const h = setup();
  let calls = 0;
  h.core.effects.onApproved("mail_send", async () => { calls++; return "sent"; });
  h.ledger.tx(() => {
    for (const old of h.ledger.policyRules()) h.ledger.deletePolicyRule(old.id);
    h.ledger.putPolicyRule(rule("allow", "allow"));
  });
  const effect = h.core.effects.propose({ conversationId: h.main.directConversationId, callId: "forced-owner", tool: "mail_send", input: {}, summary: "Send", title: "Owner authorization", detail: "Review before sending", proposal: { input: {} }, forceOwner: true });
  const decision = h.ledger.pendingDecisions({ effectId: effect.id })[0]!;
  expect(decision.proposal!.forceOwner).toBe(true);
  expect(h.core.effects.proposalStatus(effect)).toContain("approval required");
  h.ledger.tx(() => h.ledger.putPolicyRule(rule("revoke-forced-owner", "deny", { tool: "mail_send" })));
  await h.core.decisions.settleExpired();
  expect(h.ledger.decision(decision.id).state).toBe("denied");
  expect(h.ledger.effect(effect.id).state).toBe("denied");
  expect(calls).toBe(0);
  const blocked = h.ledger.tx(() => h.core.decisions.open({ kind: "approve_effect", ghostId: h.main.id, conversationId: h.main.directConversationId, workId: null, effectId: effect.id, title: "Still denied", detail: "A floor cannot revive denial", options: [], proposal: { forceOwner: true } }));
  expect(blocked.state).toBe("denied");
  expect(blocked.proposal!.policy).toMatchObject({ evaluation: { decision: "deny", decidedBy: ["revoke-forced-owner"] } });
});
