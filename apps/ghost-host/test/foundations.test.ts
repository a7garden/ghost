import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { BROWSER_TOOLS, type VaultItem } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Core } from "../src/core/core.ts";
import { verifyChecks } from "../src/core/verify.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { parseInput, serveBrowser } from "../src/api/browser.ts";
import type { BrowserLiveInput, BrowserLiveEvent, BrowserPort, BrowserSessionRef, SandboxEnvFactory, VaultPort } from "../src/integrations/ports.ts";
import { createBrowserTools, FACTS_SCRIPT, parseFacts } from "../src/tools/browser.ts";
import { citationFailures, SourceStore } from "../src/stores/sources.ts";
import { validateExecutionTarget } from "../src/sandbox/host-env.ts";
import { ensureWorktree, worktreeBranch } from "../src/sandbox/worktree.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox, tempDir } from "./support.ts";

/**
 * OS-independent coverage for the shopping, research and development foundations (2026-11-10):
 * an in-memory browser port instead of the agent-browser child, so these run on every platform.
 */

/** Runs the Host's page-facts script against a minimal page, the way Chrome would evaluate it. */
function factsOf(href: string, text: string) {
  const url = new URL(href);
  return parseFacts(runInNewContext(FACTS_SCRIPT, { location: { href, origin: url.origin }, document: { body: { innerText: text } }, JSON }));
}

describe("page facts", () => {
  test("recognizes Korean and English checkout steps and reads the total", () => {
    expect(factsOf("https://checkout.coupang.com/ssr/desktop/order/sheet", "배송지\n최종 결제금액\n12,300원\n결제하기")).toMatchObject({ checkout: true, amount: "12300", currency: "KRW", origin: "https://checkout.coupang.com" });
    expect(factsOf("https://order.pay.naver.com/orderSheet/123", "총 결제금액 45,000 원")).toMatchObject({ checkout: true, amount: "45000", currency: "KRW" });
    expect(factsOf("https://shop.example/cart", "Items\nOrder total: $1,234.50\nPlace your order")).toMatchObject({ checkout: true, amount: "1234.50", currency: "USD" });
  });
  test("product and article pages are not checkout steps", () => {
    expect(factsOf("https://www.coupang.com/vp/products/123", "생수 2L 6개\n바로구매 장바구니 담기\n9,900원")).toMatchObject({ checkout: false, signal: null });
    expect(factsOf("https://news.example.com/payday-loans", "An article about pay days")).toMatchObject({ checkout: false });
  });
  test("unreadable facts count as a checkout, so the owner decides", () => {
    expect(parseFacts(null)).toMatchObject({ checkout: true, signal: "unreadable" });
    expect(parseFacts({ result: "not json" })).toMatchObject({ checkout: true });
  });
});

/** An in-memory BrowserPort: page state is plain fields the test changes. */
class MemoryBrowser implements BrowserPort {
  url = "https://shop.example/product";
  facts = { origin: "https://shop.example", checkout: false, signal: null as string | null, amount: null as string | null, currency: null as string | null };
  refs: Record<string, { role: string; name: string }> = { e1: { role: "button", name: "다음" } };
  clicks: string[] = [];
  inputs: BrowserLiveInput[] = [];
  ref: BrowserSessionRef | null = null;
  sink?: (event: BrowserLiveEvent) => void;
  unsubscribed = 0;
  notice: string | null = null;
  handoffs: (string | null)[] = [];
  ends = 0;
  async run(_session: BrowserSessionRef, argv: string[], options?: { stdin?: string }) {
    this.ref = _session;
    // The real adapter reduces a secret fill to a fixed status; this one fills whatever is focused.
    if (options?.stdin !== undefined) return { ok: true, data: { status: "filled" }, error: null };
    switch (argv[0]) {
      case "get": return { ok: true, data: { url: this.url }, error: null };
      case "eval": return { ok: true, data: { result: JSON.stringify(this.facts) }, error: null };
      case "snapshot": return { ok: true, data: { origin: this.url, title: "Shop", snapshot: "- button 다음 [ref=e1]", refs: this.refs }, error: null };
      case "click": this.clicks.push(argv[1]!); return { ok: true, data: {}, error: null };
      default: return { ok: true, data: {}, error: null };
    }
  }
  async captureCredential(): Promise<string> { throw new Error("not used by checkout fixtures"); }
  async handoff(_session: BrowserSessionRef, url: string | null) { this.handoffs.push(url); }
  async endHandoff() { this.ends++; return { fallback: false }; }
  sessions() { return this.ref ? [{ ...this.ref, engine: "chrome" as const, headed: false }] : []; }
  async live(_ref: BrowserSessionRef, _options: { maxFps: number }, sink: (event: BrowserLiveEvent) => void) {
    this.sink = sink;
    sink({ type: "frame", data: "AAAA", width: 1280, height: 720 });
    return () => { this.unsubscribed++; this.sink = undefined; };
  }
  async input(_session: BrowserSessionRef, input: BrowserLiveInput) { this.inputs.push(input); this.notice = "The owner used this browser; take a fresh browser_snapshot."; }
  takeNotice() { const value = this.notice; this.notice = null; return value; }
  async close() {}
  async shutdown() {}
}

function browserFixture() {
  const ledger = new Ledger(":memory:");
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
  core.attach(new FakeEngine());
  const ghost = core.createGhost({ name: "Shopper", persona: "" });
  ledger.tx(() => ledger.putGhost({ ...ghost, tools: [...BROWSER_TOOLS] }));
  const direct = ledger.conversation(ghost.directConversationId);
  ledger.setPiConversationId(direct.id, "pi-shop");
  const item: VaultItem = { id: "login1", kind: "login", title: "Shop", origin: "https://shop.example", extraOrigins: ["https://login.shop.example"], username: "me", cardLast4: null, cardExpiry: null, contact: null, hints: "", ghostIds: [ghost.id], hasPassword: true, hasTotp: false, createdAt: 0, updatedAt: 0, expiresAt: null };
  const vault: VaultPort = { listFor: () => [item], itemFor: () => item, reveal: () => "secret-value", generateLogin: () => item };
  const browser = new MemoryBrowser();
  const sandbox: SandboxEnvFactory = { workspacePath: () => tempDir(), envFor: async () => { throw new Error("unused"); }, stageInputs: async () => {}, release: async () => {} };
  const extension = createBrowserTools(core, browser, { vault, sandbox });
  let seq = 0;
  const call = (name: string, args: unknown = {}) => extension.tools!.find((tool) => tool.name === name)!
    .execute(args as never, { conversationId: "pi-shop", taskId: `task:call-${++seq}`, callId: `call-${++seq}` } as unknown as ToolExecutionApi, { abortSignal: undefined } as Context);
  return { ledger, core, ghost, direct, browser, call };
}

describe("checkout approvals", () => {
  test("clicks on a checkout step need the owner whatever the button says", async () => {
    const f = browserFixture();
    await f.call("browser_snapshot");
    expect((await f.call("browser_click", { ref: "@e1" })).isError).toBeFalsy();
    expect(f.browser.clicks).toEqual(["@e1"]);
    f.browser.facts = { ...f.browser.facts, checkout: true, signal: "url:/checkout/" };
    const refused = await f.call("browser_click", { ref: "@e1" });
    expect(refused.isError).toBe(true);
    const pressed = await f.call("browser_press", { key: "Enter" });
    expect(pressed.isError).toBe(true);
    // Policy denies the checkout submission outright: nothing is dispatched and nothing is left to approve.
    expect(f.browser.clicks).toEqual(["@e1"]);
    expect(f.ledger.pendingDecisions()).toHaveLength(0);
    expect(f.ledger.effectsInState("pending")).toHaveLength(0);
    expect(f.ledger.effectsInState("denied").map((effect) => effect.tool).sort()).toEqual(["browser_click", "browser_press"]);
    // The owner path remains: a proposal opens an owner card for the same checkout click.
    await f.call("browser_propose", { ref: "@e1", title: "주문", reason: "확인 후 결제" });
    expect(f.ledger.pendingDecisions().map((decision) => decision.kind)).toEqual(["approve_effect"]);
    expect(f.browser.clicks).toEqual(["@e1"]);
  });
  test("an approval binds the merchant and total the Host read, and refuses a changed total", async () => {
    const f = browserFixture();
    f.browser.url = "https://shop.example/checkout";
    f.browser.facts = { origin: "https://shop.example", checkout: true, signal: "url:/checkout", amount: "12300", currency: "KRW" };
    await f.call("browser_snapshot");
    await f.call("browser_propose", { ref: "@e1", title: "주문", reason: "생수 주문" });
    let decision = f.ledger.pendingDecisions()[0]!;
    expect(decision.detail).toContain("상점: shop.example · 금액: 12,300원");
    expect(decision.proposal).toMatchObject({ merchant: "shop.example", total: "12,300원", page: { amount: "12300", currency: "KRW" } });
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.browser.clicks).toEqual(["@e1"]);
    await f.call("browser_propose", { ref: "@e1", title: "주문", reason: "다시" });
    decision = f.ledger.pendingDecisions()[0]!;
    f.browser.facts = { ...f.browser.facts, amount: "99000" };
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(f.browser.clicks).toEqual(["@e1"]);
  });
  test("vault logins fill on extra login origins and nowhere else", async () => {
    const f = browserFixture();
    await f.call("browser_snapshot");
    f.browser.url = "https://login.shop.example/login";
    const fill = await f.call("browser_fill_secret", { ref: "@e1", item_id: "login1", field: "username" });
    expect(fill.isError).toBe(true);
    const approval = f.ledger.pendingDecisions()[0]!;
    expect(approval.kind).toBe("approve_effect");
    expect(JSON.stringify(approval.proposal?.policy)).toContain("rule-of-two");
    await f.core.decisions.resolve(approval.id, { outcome: "approve" });
    expect(f.ledger.effect(approval.effectId!).state).toBe("done");
    expect(f.ledger.effect(approval.effectId!).result).toBe("Secret filled");
    f.browser.url = "https://evil.example/login";
    const refused = await f.call("browser_fill_secret", { ref: "@e1", item_id: "login1", field: "password" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("origin_mismatch");
  });
});

describe("live browser sessions", () => {
  test("owner drives any active session, with bounded frames, abort and token revocation", async () => {
    const f = browserFixture();
    await f.call("browser_snapshot");
    const path = `/api/browser/sessions/${f.direct.id}`;
    const api = (suffix: string, init?: RequestInit, authorized?: () => boolean) => serveBrowser(new Request(`http://host${suffix}`, init), new URL(`http://host${suffix}`), f.core, f.browser, authorized);
    expect((await (await api("/api/browser/sessions")).json()).sessions).toHaveLength(1);
    const abort = new AbortController();
    const response = await api(`${path}/live`, { signal: abort.signal });
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = response.body!.getReader();
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toMatchObject({ type: "frame", width: 1280 });
    for (let n=0;n<100;n++) f.browser.sink!({ type: "frame", data: String(n), width: 1, height: 1 });
    await reader.read(); // at most one queued frame and one latest frame
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('\"data\":\"99\"');
    abort.abort();
    expect((await reader.read()).done).toBe(true);
    expect(f.browser.unsubscribed).toBe(1);
    expect((await api(`${path}/input`, { method: "POST", body: JSON.stringify({ type: "text", text: "한글" }) })).status).toBe(200);
    expect(JSON.stringify(await f.call("browser_read"))).toContain("owner used");
    expect(JSON.stringify(await f.call("browser_read"))).not.toContain("owner used");
    expect((await api(`${path}/window`, { method: "POST" })).status).toBe(200);
    expect(f.browser.handoffs).toEqual(["https://shop.example/product"]);
    let authorized = true;
    const revoked = await api(`${path}/live`, {}, () => authorized);
    const revokedReader = revoked.body!.getReader();
    await revokedReader.read();
    authorized = false;
    f.browser.sink!({ type: "frame", data: "BBBB", width: 1, height: 1 });
    expect((await revokedReader.read()).done).toBe(true);
    expect(f.browser.unsubscribed).toBe(2);
    expect((await api("/api/browser/sessions/missing/input", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await api(`${path}/live?fps=99`)).status).toBe(400);
  });
  test("handoff blocks the Ghost, not the owner; answering resumes lazily", async () => {
    const f = browserFixture();
    await f.call("browser_handoff", { reason: "PASS 본인인증" });
    const decision = f.ledger.pendingDecisions()[0]!;
    expect(decision.kind).toBe("question");
    expect(f.browser.handoffs).toEqual([]);
    expect(f.ledger.effectsInState("pending")).toHaveLength(0);
    expect((await f.call("browser_snapshot")).isError).toBe(true);
    const url = new URL(`http://host/api/browser/sessions/${f.direct.id}/input`);
    expect((await serveBrowser(new Request(url, { method: "POST", body: JSON.stringify({ type: "text", text: "인증" }) }), url, f.core, f.browser)).status).toBe(200);
    await f.core.decisions.resolve(decision.id, { outcome: "answer", answer: "다 했어요" });
    expect((await f.call("browser_snapshot")).isError).toBeFalsy();
    expect(f.browser.ends).toBe(1);
  });
  test("policy can deny a native browser handoff without opening a browser or an approval detour", async () => {
    const f = browserFixture();
    f.ledger.tx(() => f.ledger.putPolicyRule({ id: "no-handoff", tool: "browser_handoff", when: {}, decision: "deny", revision: 1, createdBy: { kind: "owner" } }));
    expect((await f.call("browser_handoff", { reason: "Sign in" })).isError).toBe(true);
    expect(f.browser.handoffs).toEqual([]);
    expect(f.ledger.pendingDecisions()).toHaveLength(0);
    expect(f.ledger.effectsInState("pending")).toHaveLength(0);
  });
  test("only exact, bounded, finite owner inputs reach the browser", () => {
    expect(parseInput({ type: "mouse", event: "wheel", x: 4, y: 8, deltaY: -400 })).toMatchObject({ deltaY: -400 });
    expect(parseInput({ type: "key", event: "down", key: "한", code: "KeyA", text: "한글", modifiers: 15 })).toMatchObject({ text: "한글" });
    for (const bad of [
      { type: "mouse", event: "down", x: -1, y: 0 }, { type: "mouse", event: "down", x: NaN, y: 0 },
      { type: "mouse", event: "down", x: 1, y: Infinity }, { type: "mouse", event: "down", x: 1, y: 2, extra: 1 },
      { type: "mouse", event: "wheel", x: 0, y: 0, deltaY: 10001 }, { type: "mouse", event: "down", x: 0, y: 0, modifiers: 16 },
      { type: "key", event: "down", key: "Enter" }, { type: "key", event: "down", key: "Enter", code: "KeyA", text: "\n" },
      { type: "key", event: "down", key: "bad;eval", code: "" }, { type: "key", event: "up", key: "a", code: "", keyCode: 256 },
      { type: "key", event: "down", key: "a", code: "", modifiers: 0.5 }, { type: "text", text: "" },
      { type: "text", text: "x\0y" }, { type: "navigate", action: "open" }, { type: "eval" }, null, [],
    ]) expect(() => parseInput(bad)).toThrow();
  });
});

describe("source snapshots and citations", () => {
  test("same URL and bytes give the same id; quotes are checked against what was read", () => {
    const store = new SourceStore(tempDir());
    try {
      const page = { url: "https://news.example/a", title: "A", text: "The council approved the  budget on Tuesday.\nIt passed 7 to 2.", ghostId: "g", conversationId: "c" };
      const first = store.record(page), again = store.record(page);
      expect(first.id).toMatch(/^S-[0-9a-f]{10}$/);
      expect(again.id).toBe(first.id);
      expect(store.record({ ...page, text: `${page.text} Updated.` }).id).not.toBe(first.id);
      expect(store.check(first.id, "approved the budget on tuesday").found).toBe(true);
      expect(store.check(first.id, "approved the budget on Monday").found).toBe(false);
      expect(store.listFor(["c"]).length).toBe(2);
      expect(citationFailures(store, `The budget passed "It passed 7 to 2." [${first.id}]`)).toEqual([]);
      expect(citationFailures(store, `"It passed 9 to 0 easily." [${first.id}]`)[0]).toContain("is not in that source");
      expect(citationFailures(store, "No citations at all")).toEqual(["cites no recorded source ([S-…])"]);
      expect(citationFailures(store, "Made up [S-0123456789]")).toEqual(["cites S-0123456789, which was never read"]);
    } finally { store.close(); }
  });
  test("an artifact_citations check fails a report with a fabricated quote", async () => {
    const root = tempDir(), ledger = new Ledger(":memory:"), artifacts = new MemoryArtifacts(), sources = new SourceStore(root);
    try {
      const core = new Core({ ledger, artifacts, sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {}, sources });
      core.attach(new FakeEngine());
      const source = sources.record({ url: "https://example.com/", title: "Example", text: "This domain is for use in illustrative examples.", ghostId: "g", conversationId: "c" });
      const good = await artifacts.put(new TextEncoder().encode(`"for use in illustrative examples" [${source.id}]`), "report.md", "text/markdown");
      const bad = await artifacts.put(new TextEncoder().encode(`"for use in production systems" [${source.id}]`), "report.md", "text/markdown");
      const work = (ref: typeof good) => ({ id: "w", result: { summary: "", artifacts: [ref] } }) as unknown as Parameters<typeof verifyChecks>[1];
      expect((await verifyChecks(core, work(good), [{ kind: "artifact_citations", name: "report.md" }])).pass).toBe(true);
      const failed = await verifyChecks(core, work(bad), [{ kind: "artifact_citations", name: "report.md" }]);
      expect(failed.pass).toBe(false);
      expect(failed.reasons).toContain("is not in that source");
    } finally { sources.close(); }
  });
});

describe("worktree execution", () => {
  function repo() {
    const dir = tempDir();
    const git = (...args: string[]) => { const run = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" }); if (run.exitCode !== 0) throw new Error(run.stderr.toString()); return run.stdout.toString().trim(); };
    git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T");
    writeFileSync(join(dir, "README.md"), "hello\n"); git("add", "."); git("commit", "-qm", "init");
    return { dir, git };
  }
  test("each Work gets its own branch and checkout, reused after a restart; a child starts from its parent's branch", () => {
    const { dir, git } = repo(), root = tempDir();
    const parent = { id: "work-parent", ghostId: "ghost-a", parentId: null } as never;
    const path = ensureWorktree(root, parent, dir);
    expect(ensureWorktree(root, parent, dir)).toBe(path);
    writeFileSync(join(path, "change.txt"), "x\n");
    Bun.spawnSync(["git", "-C", path, "add", "."]); Bun.spawnSync(["git", "-C", path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "parent change"]);
    expect(git("branch", "--list", worktreeBranch("work-parent"))).toContain("ghost/work-parent");
    const child = ensureWorktree(root, { id: "work-child", ghostId: "ghost-a", parentId: "work-parent" } as never, dir);
    expect(Bun.spawnSync(["git", "-C", child, "log", "--format=%s", "-1"]).stdout.toString().trim()).toBe("parent change");
    expect(git("status", "--porcelain")).toBe("");
  });
  test("worktree execution refuses a directory that is not a repository", () => {
    const plain = tempDir(); mkdirSync(join(plain, "sub"));
    expect(() => validateExecutionTarget({ kind: "host", cwd: join(plain, "sub"), worktree: true })).toThrow("needs a git repository");
    expect(() => validateExecutionTarget({ kind: "host", cwd: join(plain, "sub") })).not.toThrow();
  });
});
