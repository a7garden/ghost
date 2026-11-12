import { describe, expect, test } from "bun:test";
import { DEFAULT_APPROVAL_POLICY, type EffectClass, type EffectTargetKind, type PolicyContext, type PolicyDecision, type PolicyRule } from "@ghost/contract";
import { activityRules, approvalRules, DEFAULT_RULES, evaluatePolicy } from "../src/core/policy.ts";

const MATE = "ghost-mate";
const MAIN = "ghost-main";
const ACTIVITY = "activity-1";

function effect(tool: string, kind: EffectTargetKind, axes: Partial<Omit<EffectClass, "tool" | "target">> & { id?: string | null } = {}): EffectClass {
  const { id = null, ...rest } = axes;
  return {
    tool, target: { kind, id }, access: "write", reversible: false, external: false, amount: null,
    taint: { untrustedInput: false, privateData: false }, ...rest,
  };
}

function context(extra: Partial<PolicyContext> = {}): PolicyContext {
  return { ghostId: MATE, scopeId: null, triggerId: null, mainGhostId: MAIN, counts: {}, ...extra };
}

function rule(id: string, decision: PolicyDecision, extra: Partial<PolicyRule> = {}): PolicyRule {
  return { id, tool: "*", when: {}, decision, revision: 1, createdBy: { kind: "owner" }, ...extra };
}

describe("precedence", () => {
  const click = effect("browser_click", "browser_origin", { id: "https://shop.example", reversible: true });

  test("a broad deny beats the most specific allow", () => {
    const rules = [
      rule("narrow-allow", "allow", { ghostId: MATE, tool: "browser_click", when: { targetKind: "browser_origin", targetId: "https://shop.example", reversible: true } }),
      rule("broad-deny", "deny"),
    ];
    const result = evaluatePolicy(click, context(), rules);
    expect(result.decision).toBe("deny");
    expect(result.ruleIds).toEqual(["narrow-allow", "broad-deny"]);
    expect(result.decidedBy).toEqual(["broad-deny"]);
  });

  test("a narrower allow never opens a broader owner rule, in either order", () => {
    const allow = rule("allow-shop", "allow", { tool: "browser_*", when: { targetId: "https://*.example" } });
    const owner = rule("owner-browser", "owner", { tool: "browser_*" });
    const shop = effect("browser_click", "browser_origin", { id: "https://shop.example" });
    expect(evaluatePolicy(shop, context(), [allow, owner]).decision).toBe("owner");
    expect(evaluatePolicy(shop, context(), [owner, allow]).decision).toBe("owner");
  });

  test("deny > owner > review > allow", () => {
    const review = rule("r", "review", { reviewer: { kind: "slot", slot: "careful" } });
    expect(evaluatePolicy(click, context(), [rule("a", "allow"), review]).decision).toBe("review");
    expect(evaluatePolicy(click, context(), [review, rule("o", "owner")]).decision).toBe("owner");
    expect(evaluatePolicy(click, context(), [rule("o", "owner"), rule("d", "deny"), review]).decision).toBe("deny");
  });

  test("scope, Ghost and trigger conditions limit where a rule applies", () => {
    const rules = [rule("scoped", "deny", { scopeId: "novel" }), rule("mate", "owner", { ghostId: MATE }), rule("run", "deny", { triggerId: ACTIVITY })];
    expect(evaluatePolicy(click, context({ ghostId: "other" }), rules).ruleIds).toEqual([]);
    expect(evaluatePolicy(click, context(), rules).decision).toBe("owner");
    expect(evaluatePolicy(click, context({ scopeId: "novel" }), rules).decision).toBe("deny");
    expect(evaluatePolicy(click, context({ ghostId: "other", triggerId: ACTIVITY }), rules).decidedBy).toEqual(["run"]);
  });

  test("a Ghost never reviews its own effect; the owner decides and the automatic settlement stays", () => {
    const review = rule("self", "review", { reviewer: { kind: "ghost", ghostId: MATE }, autoResolve: { afterMinutes: 10, answer: "approve" } });
    const result = evaluatePolicy(click, context(), [review]);
    expect(result).toMatchObject({ decision: "owner", reviewers: [], autoResolve: { afterMinutes: 10, answer: "approve" } });
  });

  test("automatic settlement needs every deciding rule to grant it", () => {
    const a = rule("a", "review", { reviewer: { kind: "main" }, autoResolve: { afterMinutes: 10, answer: "approve" } });
    const b = rule("b", "review", { reviewer: { kind: "slot", slot: "s" }, autoResolve: { afterMinutes: 30, answer: "approve" } });
    expect(evaluatePolicy(click, context(), [a, b])).toMatchObject({ decision: "review", autoResolve: { afterMinutes: 30, answer: "approve" }, reviewers: [{ kind: "ghost", ghostId: MAIN }, { kind: "slot", slot: "s" }] });
    expect(evaluatePolicy(click, context(), [a, rule("c", "review", { reviewer: { kind: "main" } })]).autoResolve).toBeNull();
  });

  test("the result is deterministic and the inputs are left untouched", () => {
    const rules = Object.freeze(DEFAULT_RULES.map((entry) => Object.freeze(structuredClone(entry))));
    const frozen = Object.freeze(structuredClone(click));
    const first = evaluatePolicy(frozen, context(), rules);
    expect(evaluatePolicy(frozen, context(), rules)).toEqual(first);
  });
});

describe("limits", () => {
  const post = effect("conn.social", "connection", { id: "social", external: true });
  const pay = (value: number | null, currency: string | null = "KRW") => effect("browser_propose", "browser_origin", { amount: { value, currency } });

  test("a daily count escalates an allow to the owner once reached", () => {
    const rules = [rule("posts", "allow", { tool: "conn.social", maxPerDay: 3 })];
    expect(evaluatePolicy(post, context({ counts: { posts: 2 } }), rules).decision).toBe("allow");
    const over = evaluatePolicy(post, context({ counts: { posts: 3 } }), rules);
    expect(over).toMatchObject({ decision: "owner", decidedBy: ["posts"] });
    expect(over.reason).toContain("3 a day");
  });

  test("an escalated review loses its automatic settlement", () => {
    const rules = [rule("posts", "review", { tool: "conn.social", maxPerDay: 1, reviewer: { kind: "main" }, autoResolve: { afterMinutes: 30, answer: "approve" } })];
    expect(evaluatePolicy(post, context({ counts: { posts: 1 } }), rules)).toMatchObject({ decision: "owner", autoResolve: null, reviewers: [{ kind: "ghost", ghostId: MAIN }] });
  });

  test("an amount above the limit, in another currency or unreadable escalates to the owner", () => {
    const rules = [rule("small", "allow", { maxAmount: { value: 10_000, currency: "KRW" } })];
    expect(evaluatePolicy(pay(9_000), context(), rules).decision).toBe("allow");
    expect(evaluatePolicy(pay(10_000), context(), rules).decision).toBe("allow");
    expect(evaluatePolicy(pay(10_001), context(), rules).decision).toBe("owner");
    expect(evaluatePolicy(pay(5, "USD"), context(), rules).decision).toBe("owner");
    expect(evaluatePolicy(pay(null), context(), rules).decision).toBe("owner");
    expect(evaluatePolicy(post, context(), rules).decision).toBe("allow");
  });

  test("limits never soften a deny", () => {
    expect(evaluatePolicy(post, context({ counts: { stop: 9 } }), [rule("stop", "deny", { maxPerDay: 1 })]).decision).toBe("deny");
  });
});

describe("no matching rule", () => {
  test("a reversible workspace change is allowed", () => {
    expect(evaluatePolicy(effect("mcp.files.write", "workspace", { reversible: true }), context(), [])).toMatchObject({ decision: "allow", ruleIds: [] });
  });

  test("external, irreversible or outside-workspace effects go to the owner", () => {
    expect(evaluatePolicy(effect("mcp.files.write", "workspace"), context(), []).decision).toBe("owner");
    expect(evaluatePolicy(effect("mcp.chat.post", "workspace", { reversible: true, external: true }), context(), []).decision).toBe("owner");
    expect(evaluatePolicy(effect("mcp.cal.create", "mcp_server", { id: "cal", reversible: true }), context(), []).decision).toBe("owner");
  });

  test("an unknown tool still meets the default table's generic rows", () => {
    expect(evaluatePolicy(effect("mcp.cal.list", "mcp_server", { id: "cal", access: "read", reversible: true }), context(), DEFAULT_RULES).decision).toBe("allow");
    expect(evaluatePolicy(effect("mcp.cal.create", "mcp_server", { id: "cal" }), context(), DEFAULT_RULES)).toMatchObject({ decision: "owner", ruleIds: [] });
  });
});

/** What today's code does, as the decision card it opens. `main` is the main Ghost settling or leaving a view. */
type Outcome = { decision: PolicyDecision; main?: boolean; auto?: "approve" | "recommended" };

type Case = { behavior: string; effect: EffectClass; context?: Partial<PolicyContext>; rules?: PolicyRule[]; expected: Outcome };

const read = (tool: string, kind: EffectTargetKind, id: string | null = null) => effect(tool, kind, { id, access: "read", reversible: true });
const settings = (extra: Partial<typeof DEFAULT_APPROVAL_POLICY>) => approvalRules({ ...DEFAULT_APPROVAL_POLICY, ...extra });
const activity = (externalActions: "deny" | "approval" | "allow") => [...DEFAULT_RULES, ...activityRules({ id: ACTIVITY, policy: { externalActions } as never })];
const inRun = { triggerId: ACTIVITY };

const CASES: Case[] = [
  // Work tools (tools/work.ts): journaled, no decision.
  { behavior: "write/edit in a container workspace", effect: effect("write", "workspace", { id: "work-1", reversible: true }), expected: { decision: "allow" } },
  { behavior: "bash in a container workspace reaches the egress proxy and still runs untainted", effect: effect("bash", "workspace", { id: "work-1", reversible: true, external: true }), expected: { decision: "allow" } },
  { behavior: "workspace bash after private and untrusted reads needs the owner", effect: effect("bash", "workspace", { id: "work-1", reversible: true, external: true, taint: { untrustedInput: true, privateData: true } }), expected: { decision: "owner" } },
  { behavior: "workspace bash in an activity that denies external actions is refused", effect: effect("bash", "workspace", { id: "work-1", reversible: true, external: true }), context: inRun, rules: activity("deny"), expected: { decision: "deny" } },
  { behavior: "bash on a host Work inside its authorized cwd", effect: effect("bash", "scope_path", { id: "/Users/o/project" }), expected: { decision: "allow" } },
  { behavior: "publish_artifact", effect: effect("publish_artifact", "workspace", { reversible: true }), expected: { decision: "allow" } },
  // Host-internal tools: work, schedule, Ghost management, memory, self_adapt.
  { behavior: "ghost_update by the main", effect: effect("ghost_update", "host"), context: { ghostId: MAIN }, expected: { decision: "allow" } },
  { behavior: "memory write", effect: effect("memory", "host", { reversible: true }), expected: { decision: "allow" } },
  { behavior: "vault_generate_login", effect: effect("vault_generate_login", "host"), expected: { decision: "allow" } },
  // Reads are never gated.
  { behavior: "web_read", effect: read("web_read", "browser_origin", "https://news.example"), expected: { decision: "allow" } },
  { behavior: "host_read", effect: read("host_read", "mac"), expected: { decision: "allow" } },
  { behavior: "mail_read", effect: { ...read("mail_read", "mail_account", "inbox"), taint: { untrustedInput: true, privateData: true } }, expected: { decision: "allow" } },
  { behavior: "toss_read", effect: read("toss_read", "connection", "toss"), expected: { decision: "allow" } },
  // connection_request (tools/connections.ts).
  { behavior: "connection_request read-only GET runs immediately", effect: read("connection_request", "connection", "github"), expected: { decision: "allow" } },
  { behavior: "connection_request POST/PUT/PATCH/DELETE or Slack write waits for the owner alone", effect: effect("connection_request", "connection", { id: "slack", external: true }), expected: { decision: "owner" } },
  { behavior: "connection_request write in an activity that denies external actions is refused", effect: effect("connection_request", "connection", { id: "slack", external: true }), context: inRun, rules: activity("deny"), expected: { decision: "deny" } },
  { behavior: "connection_request write in an allow activity still waits for the owner", effect: effect("connection_request", "connection", { id: "slack", external: true }), context: inRun, rules: activity("allow"), expected: { decision: "owner" } },
  { behavior: "connection_register waits for the owner alone", effect: effect("connection_register", "connection", { id: "new" }), expected: { decision: "owner" } },
  // host_command_propose (tools/host.ts, core/decisions.ts reversible()).
  { behavior: "host_command_propose allowlisted read-only inspection runs immediately", effect: read("host_command_propose", "mac", "/Users/o"), expected: { decision: "allow" } },
  { behavior: "host_command_propose with host-proven reversible effects: main settles, approves after 30 min", effect: effect("host_command_propose", "mac", { reversible: true }), expected: { decision: "review", main: true, auto: "approve" } },
  { behavior: "host_command_propose with opaque or irreversible effects: owner, main leaves a view", effect: effect("host_command_propose", "mac"), expected: { decision: "owner", main: true } },
  { behavior: "the main's own reversible Mac command: owner, approves after 30 min", effect: effect("host_command_propose", "mac", { reversible: true }), context: { ghostId: MAIN }, expected: { decision: "owner", auto: "approve" } },
  // Browser (tools/browser.ts).
  { behavior: "browser_click on an ordinary element", effect: effect("browser_click", "browser_origin", { id: "https://a.example", reversible: true }), expected: { decision: "allow" } },
  { behavior: "browser_click on a pay/send/delete-named element is refused (use browser_propose)", effect: effect("browser_click", "browser_origin", { id: "https://a.example", external: true }), expected: { decision: "deny" } },
  { behavior: "browser_click on a checkout page is refused", effect: effect("browser_click", "browser_origin", { id: "https://a.example", reversible: true, amount: { value: null, currency: null } }), expected: { decision: "deny" } },
  { behavior: "browser_press Enter on a high-impact target is refused", effect: effect("browser_press", "browser_origin", { id: "https://a.example" }), expected: { decision: "deny" } },
  { behavior: "browser_press Enter on a checkout page is refused", effect: effect("browser_press", "browser_origin", { reversible: true, amount: { value: 30_000, currency: "KRW" } }), expected: { decision: "deny" } },
  { behavior: "browser_fill and browser_type are not guarded", effect: effect("browser_fill", "browser_origin", { reversible: true }), expected: { decision: "allow" } },
  { behavior: "browser_upload sends a workspace file", effect: effect("browser_upload", "browser_origin", { external: true, reversible: true }), expected: { decision: "allow" } },
  { behavior: "browser_fill_secret with a granted vault item", effect: effect("browser_fill_secret", "browser_origin", { reversible: true, taint: { untrustedInput: false, privateData: true } }), expected: { decision: "allow" } },
  { behavior: "browser_propose: owner, main leaves a view", effect: effect("browser_propose", "browser_origin", { external: true, amount: { value: 30_000, currency: "KRW" } }), expected: { decision: "owner", main: true } },
  { behavior: "browser_fill_card: owner, main leaves a view", effect: effect("browser_fill_card", "browser_origin", { amount: { value: null, currency: null }, taint: { untrustedInput: false, privateData: true } }), expected: { decision: "owner", main: true } },
  { behavior: "browser_handoff: owner alone", effect: effect("browser_handoff", "browser_origin"), expected: { decision: "owner" } },
  // Desktop (tools/desktop.ts).
  { behavior: "desktop_click on an ordinary element", effect: effect("desktop_click", "mac", { reversible: true }), expected: { decision: "allow" } },
  { behavior: "desktop_launch and desktop_focus", effect: effect("desktop_launch", "mac", { reversible: true }), expected: { decision: "allow" } },
  { behavior: "desktop_click on a send/pay/delete-named element is refused", effect: effect("desktop_click", "mac"), expected: { decision: "deny" } },
  { behavior: "desktop_pointer on a high-impact label is refused", effect: effect("desktop_pointer", "mac"), expected: { decision: "deny" } },
  { behavior: "desktop_keys submit on a high-impact target is refused", effect: effect("desktop_keys", "mac"), expected: { decision: "deny" } },
  { behavior: "desktop_press submit on a high-impact target is refused", effect: effect("desktop_press", "mac"), expected: { decision: "deny" } },
  { behavior: "desktop_propose: owner, main leaves a view", effect: effect("desktop_propose", "mac", { external: true }), expected: { decision: "owner", main: true } },
  // Mail (tools/mail.ts).
  { behavior: "mail_update (seen, flag, archive, trash, move) runs journaled", effect: effect("mail_update", "mail_account", { id: "inbox", reversible: true }), expected: { decision: "allow" } },
  { behavior: "mail_send: owner, main leaves a view", effect: effect("mail_send", "mail_account", { id: "inbox", external: true }), expected: { decision: "owner", main: true } },
  // Documents (tools/documents.ts).
  { behavior: "document_propose new page: main settles, approves after 30 min", effect: effect("document_propose", "document_vault", { id: "space-1", reversible: true }), expected: { decision: "review", main: true, auto: "approve" } },
  { behavior: "document_propose edit of an existing page: owner, main leaves a view", effect: effect("document_propose", "document_vault", { id: "space-1" }), expected: { decision: "owner", main: true } },
  { behavior: "approved document_write journals a vault revision", effect: effect("document_write", "document_vault", { reversible: true }), expected: { decision: "allow" } },
  { behavior: "outward browser action after private and untrusted reads needs the owner", effect: effect("browser_upload", "browser_origin", { reversible: true, external: true, taint: { untrustedInput: true, privateData: true } }), expected: { decision: "owner" } },
  // Activities (core/activities.ts, tools/activities.ts).
  { behavior: "activity_action under deny is refused", effect: effect("activity_action", "mail_account", { external: true }), context: inRun, rules: activity("deny"), expected: { decision: "deny" } },
  { behavior: "activity_action under approval: owner, main leaves a view", effect: effect("activity_action", "connection", { external: true }), context: inRun, rules: activity("approval"), expected: { decision: "owner", main: true } },
  { behavior: "activity_action under allow sends", effect: effect("activity_action", "mail_account", { external: true }), context: inRun, rules: activity("allow"), expected: { decision: "allow" } },
  { behavior: "activity_propose in a container that cannot send: main settles, approves after 30 min", effect: effect("activity_propose", "connection", { id: "mail", reversible: true }), expected: { decision: "review", main: true, auto: "approve" } },
  { behavior: "activity_propose on a schedule", effect: effect("activity_propose", "host", { reversible: true }), expected: { decision: "review", main: true, auto: "approve" } },
  { behavior: "activity_propose with host execution or desktop tools: owner, main leaves a view", effect: effect("activity_propose", "mac", { reversible: true }), expected: { decision: "owner", main: true } },
  { behavior: "activity_propose that sends on its own: owner, main leaves a view", effect: effect("activity_propose", "connection", { reversible: true, external: true }), expected: { decision: "owner", main: true } },
  // Questions and grants (tools/shared.ts, tools/self.ts, tools/vault.ts, core/goals.ts).
  { behavior: "ask_owner with a recommended option: main answers, the recommendation is taken after 30 min", effect: effect("ask_owner", "host", { reversible: true }), expected: { decision: "review", main: true, auto: "recommended" } },
  { behavior: "ask_owner without a recommendation: owner, main leaves a view", effect: effect("ask_owner", "host"), expected: { decision: "owner", main: true } },
  { behavior: "the main's own question without a recommendation: owner alone", effect: effect("ask_owner", "host"), context: { ghostId: MAIN }, expected: { decision: "owner" } },
  { behavior: "capability_request for tools: main grants, granted after 30 min", effect: effect("capability_request", "host", { id: MATE, reversible: true }), expected: { decision: "review", main: true, auto: "recommended" } },
  { behavior: "capability_request that opens the Mac: main grants, never on silence", effect: effect("capability_request", "mac", { id: MATE, reversible: true }), expected: { decision: "review", main: true } },
  { behavior: "the main's own capability_request: owner, granted after 30 min", effect: effect("capability_request", "host", { id: MAIN, reversible: true }), context: { ghostId: MAIN }, expected: { decision: "owner", auto: "recommended" } },
  { behavior: "vault_request secure form: owner alone", effect: effect("vault_request", "host"), expected: { decision: "owner" } },
  { behavior: "goal_propose: owner alone", effect: effect("goal_propose", "host"), context: { ghostId: MAIN }, expected: { decision: "owner" } },
  // Result acceptance (core/works.ts verify(), core/decisions.ts reversible()).
  { behavior: "result with report and criteria: main settles, never on silence", effect: effect("complete", "host", { reversible: true }), expected: { decision: "review", main: true } },
  { behavior: "result without report or criteria: owner, main leaves a view", effect: effect("complete", "host"), expected: { decision: "owner", main: true } },
  // Approval settings (Settings.approvals).
  { behavior: "delegation off: reversible Mac command waits for the owner, approves after 30 min", effect: effect("host_command_propose", "mac", { reversible: true }), rules: settings({ delegate: "none" }), expected: { decision: "owner", auto: "approve" } },
  { behavior: "delegation off: mail_send has no main view", effect: effect("mail_send", "mail_account", { external: true }), rules: settings({ delegate: "none" }), expected: { decision: "owner" } },
  { behavior: "automatic settling off: main still settles a reversible command", effect: effect("host_command_propose", "mac", { reversible: true }), rules: settings({ autoMinutes: 0 }), expected: { decision: "review", main: true } },
  { behavior: "a different wait applies to every automatic settlement", effect: effect("document_propose", "document_vault", { reversible: true }), rules: settings({ autoMinutes: 90 }), expected: { decision: "review", main: true, auto: "approve" } },
  { behavior: "a Ghost set to owner: its reversible decisions wait for the owner, main leaves a view", effect: effect("host_command_propose", "mac", { reversible: true }), rules: settings({ ghosts: { [MATE]: "owner" } }), expected: { decision: "owner", main: true } },
  { behavior: "a Ghost set to owner leaves other Ghosts automatic", effect: effect("host_command_propose", "mac", { reversible: true }), context: { ghostId: "ghost-other" }, rules: settings({ ghosts: { [MATE]: "owner" } }), expected: { decision: "review", main: true, auto: "approve" } },
  { behavior: "no active main: a reversible decision waits for the owner, approves after 30 min", effect: effect("host_command_propose", "mac", { reversible: true }), context: { mainGhostId: null }, expected: { decision: "owner", auto: "approve" } },
];

describe("DEFAULT_RULES reproduce today's approval behavior", () => {
  for (const entry of CASES) {
    test(entry.behavior, () => {
      const rules = entry.rules ?? DEFAULT_RULES;
      const result = evaluatePolicy(entry.effect, context(entry.context), rules);
      // The configured wait, read from the rules under test (30 minutes by default).
      const minutes = rules.find((candidate) => candidate.autoResolve)?.autoResolve?.afterMinutes;
      expect({ decision: result.decision, reviewers: result.reviewers, autoResolve: result.autoResolve }).toEqual({
        decision: entry.expected.decision,
        reviewers: entry.expected.main ? [{ kind: "ghost", ghostId: MAIN }] : [],
        autoResolve: entry.expected.auto ? { afterMinutes: minutes!, answer: entry.expected.auto } : null,
      });
    });
  }

  test("every default rule is reached by some current behavior", () => {
    const reached = new Set(CASES.flatMap((entry) => evaluatePolicy(entry.effect, context(entry.context), entry.rules ?? DEFAULT_RULES).ruleIds));
    expect(DEFAULT_RULES.map((entry) => entry.id).filter((id) => !reached.has(id))).toEqual([]);
  });
});
