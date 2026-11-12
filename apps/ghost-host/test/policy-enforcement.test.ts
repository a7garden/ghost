import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { EffectClass, GhostTool, PolicyRule } from "@ghost/contract";
import { classifyEffect, evaluateStoredPolicy, isPolicyTightening, markPolicyRead, policyRead, policyTaint, type PolicyReceipt } from "../src/core/policy-context.ts";
import { harness } from "./support.ts";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { createDocuments } from "../src/integrations/documents.ts";
import { readdirSync } from "node:fs";
import { tempDir } from "./support.ts";

const opened: { core: Core; ledger: Ledger }[] = [];
afterEach(async () => { for (const h of opened.splice(0)) { h.core.stop(); await h.core.idle(); h.ledger.close(); } });
function setup(tools: GhostTool[] = ["mail_send", "mail_update", "browser_click", "host_command_propose", "document_propose"]) {
  const h = harness();
  opened.push(h);
  const main = h.core.createGhost({ name: "Main", persona: "" });
  const ghost = h.core.createGhost({ name: "Worker", persona: "", tools });
  return { ...h, main, ghost, conversationId: ghost.directConversationId };
}
function replaceRules(h: { ledger: Ledger }, rules: PolicyRule[]) {
  h.ledger.tx(() => {
    for (const rule of h.ledger.policyRules()) h.ledger.deletePolicyRule(rule.id);
    for (const rule of rules) h.ledger.putPolicyRule(rule);
  });
}
const ownerRule = (id: string, decision: PolicyRule["decision"], extra: Partial<PolicyRule> = {}): PolicyRule => ({ id, tool: "*", when: {}, decision, revision: 1, createdBy: { kind: "owner" }, ...extra });
const mailChange: Omit<EffectClass, "tool" | "taint"> = { target: { kind: "mail_account", id: "mail" }, access: "write", reversible: true, external: false, amount: null };

describe("stored policy enforcement", () => {
  test("defaults allow bounded internal mutation and ask the owner before sending", async () => {
    const h = setup();
    let sent = 0;
    expect(await h.core.effects.run({ conversationId: h.conversationId, callId: "update", tool: "mail_update", input: {}, summary: "Mark message read", classification: mailChange }, async () => "updated")).toBe("updated");
    h.core.effects.onApproved("mail_send", async () => { sent++; return "sent"; });
    const effect = h.core.effects.propose({ conversationId: h.conversationId, callId: "send", tool: "mail_send", input: {}, summary: "Send mail", title: "Send?", detail: "Mail body", proposal: { input: {} } });
    const decision = h.ledger.pendingDecisions({ effectId: effect.id })[0]!;
    expect(sent).toBe(0);
    expect((decision.proposal!.policy as PolicyReceipt).evaluation.decidedBy).toContain("mail-send");
    expect(decision.detail).toContain("mail-send");
    await h.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(sent).toBe(1);
  });

  test("stored deny beats allow without any adapter I/O", async () => {
    const h = setup();
    replaceRules(h, [ownerRule("allow", "allow"), ownerRule("stop", "deny")]);
    let calls = 0;
    await expect(h.core.effects.run({ conversationId: h.conversationId, callId: "denied", tool: "mail_update", input: {}, summary: "Change mail", classification: mailChange }, async () => { calls++; return "changed"; })).rejects.toThrow("stop");
    expect(calls).toBe(0);
    expect(h.ledger.effectByCall(h.conversationId, "denied")?.state).toBe("denied");
  });

  test("rule tightening while pending invalidates approval and revokes its proposal", async () => {
    const h = setup();
    let calls = 0;
    h.core.effects.onApproved("mail_send", async () => { calls++; return "sent"; });
    const effect = h.core.effects.propose({ conversationId: h.conversationId, callId: "waiting", tool: "mail_send", input: {}, summary: "Mail", title: "Send?", detail: "body", proposal: { input: {} } });
    const decision = h.ledger.pendingDecisions({ effectId: effect.id })[0]!;
    h.ledger.tx(() => h.ledger.putPolicyRule(ownerRule("revoked", "deny", { tool: "mail_send" })));
    await expect(h.core.decisions.resolve(decision.id, { outcome: "approve" })).rejects.toThrow("Policy changed");
    await h.core.decisions.settleExpired();
    expect(h.ledger.effect(effect.id).state).toBe("denied");
    expect(calls).toBe(0);
  });

  test("rules changing during an approved adapter wait are rechecked before I/O", async () => {
    const h = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    h.core.effects.onApproved("mail_send", async (effect) => {
      entered.resolve();
      await release.promise;
      h.core.effects.authorize(effect.conversationId, effect.callId);
      calls++;
      return "sent";
    });
    const effect = h.core.effects.propose({ conversationId: h.conversationId, callId: "queued", tool: "mail_send", input: {}, summary: "Mail", title: "Send?", detail: "body", proposal: { input: {} } });
    const decision = h.ledger.pendingDecisions({ effectId: effect.id })[0]!;
    const resolving = h.core.decisions.resolve(decision.id, { outcome: "approve" });
    await entered.promise;
    h.ledger.tx(() => h.ledger.putPolicyRule(ownerRule("stop-queued", "deny", { tool: "mail_send" })));
    release.resolve();
    await resolving;
    expect(calls).toBe(0);
    expect(h.ledger.effect(effect.id).state).toBe("denied");
  });

  test("daily reservations cannot race across conversations or displace the first reservation", async () => {
    const h = setup();
    const other = h.core.createGhost({ name: "Other", persona: "", tools: ["mail_update"] });
    replaceRules(h, [ownerRule("daily", "allow", { tool: "mail_update", maxPerDay: 1 })]);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const first = h.core.effects.run({ conversationId: h.conversationId, callId: "first", tool: "mail_update", input: {}, summary: "First", classification: mailChange }, async () => {
      entered.resolve();
      await release.promise;
      h.core.effects.authorize(h.conversationId, "first");
      calls++;
      return "first";
    });
    await entered.promise;
    await expect(h.core.effects.run({ conversationId: other.directConversationId, callId: "second", tool: "mail_update", input: {}, summary: "Second", classification: mailChange }, async () => { calls++; return "second"; })).rejects.toThrow("approval required");
    release.resolve();
    expect(await first).toBe("first");
    expect(calls).toBe(1);
    expect(h.ledger.pendingDecisions().some((decision) => (decision.proposal?.policy as PolicyReceipt | undefined)?.evaluation.reason.includes("1 a day"))).toBe(true);
  });

  test("effect execution cannot claim read access, and model risk text proves nothing", () => {
    const h = setup();
    expect(() => h.core.effects.begin({ conversationId: h.conversationId, callId: "false-read", tool: "mail_send", input: {}, summary: "False read", classification: { ...mailChange, access: "read" } })).toThrow("reads must use");
    expect(h.ledger.effectByCall(h.conversationId, "false-read")).toBeNull();
    const command = classifyEffect(h.core, h.conversationId, "host_command_propose", { risk: "read-only, safe, reversible", program: "sh", args: ["-c", "unknown"] });
    expect(command).toMatchObject({ access: "write", reversible: false, external: true, target: { kind: "mac" } });
  });

  test("unjournaled reads persist taint and Rule of Two asks before outward actions", () => {
    const h = setup();
    policyRead(h.core, h.conversationId, { tool: "web_read", target: { kind: "browser_origin", id: "https://example.com" }, access: "read", reversible: true, external: false, amount: null }, { taskId: "task-web-read", callId: "web-read" });
    markPolicyRead(h.core, h.conversationId, { privateData: true });
    expect(h.ledger.effectsInState("done")).toHaveLength(0);
    const classification = classifyEffect(h.core, h.conversationId, "browser_upload", {}, { target: { kind: "browser_origin", id: "https://example.com" }, access: "write", reversible: true, external: true, amount: null });
    const receipt = h.ledger.tx(() => evaluateStoredPolicy(h.core, h.conversationId, classification));
    expect(receipt.evaluation.decision).toBe("owner");
    expect(receipt.evaluation.decidedBy).toContain("rule-of-two");
  });

  test("subagent reads taint the parent and Work inherits origin taint", async () => {
    const h = setup();
    const child = h.core.newConversation(h.ghost.id, "subagent", null, "Helper", "helper-policy", Date.now());
    h.ledger.tx(() => { h.ledger.putConversation(child); h.ledger.putSetting(`subagent:parent:${child.id}`, h.conversationId); });
    markPolicyRead(h.core, child.id, { untrustedInput: true, privateData: true });
    expect(policyTaint(h.core, h.conversationId)).toEqual({ untrustedInput: true, privateData: true });
    const work = h.core.works.createRoot({ ghostId: h.ghost.id, title: "Test", brief: "Read", originConversationId: h.conversationId });
    await h.core.idle();
    expect(policyTaint(h.core, h.ledger.work(work.id).conversationId!)).toEqual({ untrustedInput: true, privateData: true });
  });

  test("uncertain outside effects are never replayed or returned as self-checkable", async () => {
    const h = setup();
    replaceRules(h, [ownerRule("explicit-send", "allow", { tool: "mail_send" })]);
    let calls = 0;
    const input = { conversationId: h.conversationId, callId: "uncertain", tool: "mail_send", input: {}, summary: "Send mail" };
    await expect(h.core.effects.run(input, async () => { calls++; throw new Error("transport lost after submission"); })).rejects.toThrow("transport lost");
    const effect = h.ledger.effectByCall(h.conversationId, "uncertain")!;
    expect(effect.state).toBe("unknown");
    expect(h.core.effects.selfCheckable(effect)).toBe(false);
    await expect(h.core.effects.run(input, async () => { calls++; return "retry"; })).rejects.toThrow("will not run again");
    expect(calls).toBe(1);
  });

  test("configuration widening and credentials remain owner-only even with blanket allow", () => {
    const h = setup();
    replaceRules(h, [ownerRule("anything", "allow")]);
    for (const proposal of [{ forceOwner: true }, { secureForm: { kind: "login" } }]) {
      const decision = h.core.decisions.ask(h.conversationId, "Owner authorization", "", [], undefined, proposal);
      expect(decision.state).toBe("pending");
      expect(h.core.decisions.reversible(decision)).toBe(false);
      expect((decision.proposal!.policy as PolicyReceipt).evaluation.autoResolve).toBeNull();
    }
  });

  test("tightening never treats removing a quota or changing rule identity as safe", () => {
    const before = ownerRule("bounded", "allow", { maxPerDay: 1 });
    expect(isPolicyTightening(before, { ...before, decision: "deny" })).toBe(true);
    expect(isPolicyTightening(before, { ...before, maxPerDay: undefined })).toBe(false);
    expect(isPolicyTightening(before, { ...before, id: "reset-counter" })).toBe(false);
    expect(isPolicyTightening(before, null)).toBe(false);
    expect(isPolicyTightening(null, ownerRule("new-owner-timeout", "owner", { autoResolve: { afterMinutes: 1, answer: "approve" } }))).toBe(false);
  });
  test("document writes recheck policy after asynchronous validation", async () => {
    const h = setup();
    const path = tempDir();
    const now = Date.now();
    h.ledger.tx(() => h.ledger.putScope({ id: "policy-documents", name: "Documents", ghostId: null, paths: [], vaultPath: path, state: "active", attachments: [], limits: {}, createdAt: now, updatedAt: now }));
    const documents = createDocuments(h.core);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const check = documents.check.bind(documents);
    const validation = spyOn(documents, "check").mockImplementation(async (proposal) => {
      entered.resolve();
      await release.promise;
      return check(proposal);
    });
    const decision = h.ledger.tx(() => h.core.decisions.open({
      kind: "document_review", ghostId: h.ghost.id, conversationId: h.conversationId, workId: null, effectId: null,
      title: "New note", detail: "Draft", options: [],
      proposal: { scopeId: "policy-documents", title: "New note", body: "Draft body", profile: "pdc-markdown/1", pageId: null, expectedHash: null },
    }));
    const resolving = h.core.decisions.resolve(decision.id, { outcome: "approve" });
    await entered.promise;
    h.ledger.tx(() => h.ledger.putPolicyRule(ownerRule("revoke-document", "deny", { tool: "document_propose" })));
    release.resolve();
    await resolving;
    validation.mockRestore();
    expect(readdirSync(path)).toHaveLength(0);
    expect(h.ledger.effectByCall(h.conversationId, `decision:${decision.id}`)?.state).toBe("denied");
  });
  test("the named reviewer, not the default Ghost, receives and settles the review", async () => {
    const h = setup();
    const reviewer = h.core.createGhost({ name: "Reviewer", persona: "" });
    replaceRules(h, [ownerRule("named", "review", { tool: "mail_update", reviewer: { kind: "ghost", ghostId: reviewer.id } })]);
    let calls = 0;
    await expect(h.core.effects.run({ conversationId: h.conversationId, callId: "named-review", tool: "mail_update", input: {}, summary: "Change mail", classification: mailChange }, async () => { calls++; return "changed"; })).rejects.toThrow("approval required");
    const decision = h.ledger.pendingDecisions()[0]!;
    expect(h.engine.to(reviewer.directConversationId).some((submission) => submission.requestId === `decision-review:${decision.id}`)).toBe(true);
    await expect(h.core.decisions.settleForOwner(h.main.id, decision.id, { outcome: "approve", note: "Wrong reviewer" })).rejects.toThrow("not the live policy reviewer");
    await h.core.decisions.settleForOwner(reviewer.id, decision.id, { outcome: "approve", note: "Checked the exact request" });
    expect(calls).toBe(1);
  });

  test("a missing configured reviewer never turns into automatic approval", async () => {
    const h = setup();
    replaceRules(h, [ownerRule("unavailable-slot", "review", { tool: "mail_update", reviewer: { kind: "slot", slot: "missing" }, autoResolve: { afterMinutes: 1, answer: "approve" } })]);
    await expect(h.core.effects.run({ conversationId: h.conversationId, callId: "missing-review", tool: "mail_update", input: {}, summary: "Change mail", classification: mailChange }, async () => "must not run")).rejects.toThrow("approval required");
    const decision = h.ledger.pendingDecisions()[0]!;
    expect((decision.proposal!.policy as PolicyReceipt).evaluation.autoResolve).toBeNull();
    expect(decision.detail).toContain("Configured reviewer or slot is unavailable");
    await h.core.decisions.settleExpired(decision.createdAt + 120_000);
    expect(h.ledger.decision(decision.id).state).toBe("pending");
  });

  test("only an owner rule bound to observed target and known amount can settle money automatically", async () => {
    const h = setup();
    replaceRules(h, [ownerRule("bounded-payment", "owner", { tool: "mail_send", when: { targetKind: "mail_account", targetId: "mail", amount: true }, maxAmount: { value: 10, currency: "USD" }, autoResolve: { afterMinutes: 1, answer: "approve" } })]);
    let calls = 0;
    h.core.effects.onApproved("mail_send", async () => { calls++; return "sent"; });
    const propose = (callId: string, value: number | null) => h.core.effects.propose({
      conversationId: h.conversationId, callId, tool: "mail_send", input: { value }, summary: "Known payment", title: "Payment", detail: "Observed target and amount",
      classification: { ...mailChange, reversible: false, external: true, amount: { value, currency: "USD" } }, proposal: { input: { value } },
    });
    const known = propose("known-amount", 5);
    const knownDecision = h.ledger.pendingDecisions({ effectId: known.id })[0]!;
    await h.core.decisions.settleExpired(knownDecision.createdAt + 120_000);
    expect(calls).toBe(1);
    const unknown = propose("unknown-amount", null);
    const unknownDecision = h.ledger.pendingDecisions({ effectId: unknown.id })[0]!;
    await h.core.decisions.settleExpired(unknownDecision.createdAt + 120_000);
    expect(calls).toBe(1);
    expect(h.ledger.decision(unknownDecision.id).state).toBe("pending");
  });
  test("a Ghost cannot accept its own result through a review conversation", async () => {
    const h = setup();
    const work = h.core.works.createRoot({ ghostId: h.ghost.id, title: "Evidence", brief: "Produce evidence", acceptance: { criteria: "Evidence exists", checks: [], reviewer: null }, originConversationId: h.conversationId });
    await h.core.idle();
    h.ledger.tx(() => {
      h.ledger.putWork({ ...h.ledger.work(work.id), state: "verifying", result: { summary: "Claimed complete", artifacts: [] } });
      h.ledger.putConversation(h.core.newConversation(h.ghost.id, "review", work.id, "Self review"));
    });
    h.core.works.applyVerdict(work.id, { outcome: "pass", source: "review", reasons: "I approve myself", at: Date.now() });
    expect(h.ledger.work(work.id).state).toBe("verifying");
    expect(h.ledger.pendingDecisions({ workId: work.id }).some((decision) => decision.kind === "accept_result")).toBe(true);
  });

  test("blanket allow cannot bypass result verification", async () => {
    const h = setup();
    replaceRules(h, [ownerRule("allow-everything", "allow")]);
    const work = h.core.works.createRoot({ ghostId: h.ghost.id, title: "Evidence", brief: "Produce evidence", acceptance: { criteria: "Evidence exists", checks: [], reviewer: null }, originConversationId: h.conversationId });
    await h.core.idle();
    const candidate = { ...h.ledger.work(work.id), state: "verifying" as const, result: { summary: "Claimed complete", artifacts: [] } };
    h.ledger.tx(() => { h.ledger.putWork(candidate); h.core.decisions.openAcceptance(candidate, null); });
    expect(h.ledger.work(work.id).state).toBe("verifying");
    expect(h.ledger.pendingDecisions({ workId: work.id })[0]?.detail).toContain("cannot accept an unverified completion claim");
  });
});
