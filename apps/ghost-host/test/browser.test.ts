import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BROWSER_TOOLS, DEFAULT_GHOST_PERMISSIONS, DEFAULT_GHOST_TOOLS, type GhostBrowserPermissions, type Principal } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { credentialPlugin } from "../src/integrations/browser-credential.ts";
import { AgentBrowser } from "../src/integrations/browser.ts";
import type { BrowserPort, BrowserReply } from "../src/integrations/ports.ts";
import { commitOf, createBrowserTools, findTarget, hostAllowed, targetsOf } from "../src/tools/browser.ts";
import { harness, tempDir } from "./support.ts";

/** 2026-11-09: the owner's browser as Ghost tools — reads free, actions journaled, commits approved, logins only from granted Shade items. */

const owner = { kind: "owner" } as const satisfies Principal;
const context = { publicOrigin: "http://x", documents: null };
const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;
const apiOf = (callId: string): ToolExecutionApi =>
  ({ conversationId: "pi-browser", callId, env: undefined, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;
const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
const ok = (data: Record<string, unknown>): BrowserReply => ({ ok: true, data });
const ITEM = "0193a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

/** A page whose refs are renumbered at every snapshot, like agent-browser, and that records what was done to it. */
class FakeBrowser implements BrowserPort {
  vault = true;
  url = "https://shop.example/cart";
  elements = [
    { role: "textbox", name: "Address" },
    { role: "button", name: "결제하기" },
    { role: "link", name: "Help" },
  ];
  readonly calls: string[][] = [];
  readonly performed: string[] = [];
  readonly grants = new Map<string, { itemId: string; origin: string }>();
  readonly revoked: string[] = [];
  private counter = 0;
  private refs = new Map<string, number>();

  private reply(args: string[]): BrowserReply {
    const [command, ...rest] = args;
    switch (command) {
      case "get":
        return rest[0] === "url" ? ok({ url: this.url }) : ok({ text: "Order total 32,000원" });
      case "open":
        this.url = rest[0]!;
        return ok({ url: this.url, title: "Shop" });
      case "snapshot": {
        this.refs = new Map();
        const refs: Record<string, unknown> = {};
        const lines = this.elements.map((element, index) => {
          const ref = `e${++this.counter}`;
          this.refs.set(ref, index);
          refs[ref] = element;
          return `- ${element.role} "${element.name}" [ref=${ref}]`;
        });
        return ok({ origin: this.url, refs, snapshot: lines.join("\n") });
      }
      case "screenshot":
        writeFileSync(rest[rest.length - 1]!, new Uint8Array([137, 80, 78, 71]));
        return ok({});
      case "auth":
        return ok({ loggedIn: true });
      default: {
        if (command === "press" && rest.length === 1) {
          this.performed.push(`press ${rest[0]}`);
          return ok({});
        }
        const index = this.refs.get((rest[0] ?? "").replace(/^@/, ""));
        if (index === undefined) return { ok: false, error: `Unknown ref: ${rest[0]}` };
        this.performed.push([command, this.elements[index]!.name, ...rest.slice(1)].join(" "));
        return ok({});
      }
    }
  }
  run(ghostId: string, tab: string, args: string[]) {
    return this.exclusive(ghostId, tab, (run) => run(args));
  }
  async exclusive<T>(_ghostId: string, _tab: string, body: (run: (args: string[]) => Promise<BrowserReply>) => Promise<T>): Promise<T> {
    return body(async (args) => {
      this.calls.push(args);
      return this.reply(args);
    });
  }
  scratchPath(extension: string) {
    return join(tempDir(), `shot.${extension}`);
  }
  grantLogin(grant: { itemId: string; origin: string }) {
    const token = `g${String(this.grants.size).padStart(32, "0")}`;
    this.grants.set(token, grant);
    return token;
  }
  revokeGrant(token: string) {
    this.revoked.push(token);
  }
  async closeTabs() {}
}

function setup(browserPermissions: Partial<GhostBrowserPermissions> = {}) {
  const h = harness();
  const ghost = h.core.createGhost({ name: "Shopper", persona: "", tools: [...BROWSER_TOOLS] });
  const conversation = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(conversation.id, "pi-browser");
  h.ledger.tx(() => h.ledger.setGhostPermissions(ghost.id, { ...DEFAULT_GHOST_PERMISSIONS, browser: { commit: "always", domains: [], logins: [], ...browserPermissions } }));
  const fake = new FakeBrowser();
  const extension = createBrowserTools(h.core, fake);
  const call = (name: string, args: Record<string, unknown>, callId: string = crypto.randomUUID()) =>
    extension.tools!.find((tool) => tool.name === name)!.execute(args as never, apiOf(callId), testContext());
  return { ...h, ghost, conversation, fake, call };
}

describe("browser helpers", () => {
  test("targets keep page order and count duplicates, so a target is found again after renumbering", () => {
    const first = targetsOf({ refs: { e2: { role: "button", name: "Buy" }, e1: { role: "button", name: "Buy" } }, snapshot: '- button "Buy" [ref=e1]\n- button "Buy" [ref=e2]' });
    expect(first.get("e2")).toEqual({ role: "button", name: "Buy", index: 1 });
    const later = targetsOf({ refs: { e7: { role: "button", name: "Buy" }, e8: { role: "button", name: "Buy" } }, snapshot: '- button "Buy" [ref=e7]\n- button "Buy" [ref=e8]' });
    expect(findTarget(later, first.get("e2")!)).toBe("e8");
    expect(findTarget(later, { role: "button", name: "Buy", index: 2 })).toBeNull();
  });

  test("a click on a paying or sending control counts as a commit even when undeclared", () => {
    expect(commitOf("click", { role: "button", name: "결제하기", index: 0 }, undefined)).toBe("other");
    expect(commitOf("click", { role: "button", name: "Place order", index: 0 }, undefined)).toBe("other");
    expect(commitOf("click", { role: "link", name: "Help", index: 0 }, undefined)).toBeNull();
    expect(commitOf("fill", { role: "textbox", name: "Send to", index: 0 }, undefined)).toBeNull();
    expect(commitOf("press", null, "send")).toBe("send");
  });

  test("domains allow themselves and their subdomains only; an empty list allows any host", () => {
    expect(hostAllowed("shop.example", [])).toBe(true);
    expect(hostAllowed("m.shop.example", ["shop.example"])).toBe(true);
    expect(hostAllowed("evilshop.example", ["shop.example"])).toBe(false);
  });

  test("browser tools are never in a new Ghost's default allow-list", () => {
    for (const tool of BROWSER_TOOLS) expect(DEFAULT_GHOST_TOOLS).not.toContain(tool);
  });
});

describe("browser tools", () => {
  test("reading is not journaled; local addresses and hosts outside the owner's domains are refused", async () => {
    const s = setup({ domains: ["shop.example"] });
    expect(textOf(await s.call("browser_open", { url: "https://shop.example/item/1" }))).toContain("Opened");
    expect(textOf(await s.call("browser_open", { url: "http://127.0.0.1:8080/" }))).toContain("refused");
    expect(textOf(await s.call("browser_open", { url: "https://other.example/" }))).toContain("outside the domains");
    expect(textOf(await s.call("browser_snapshot", {}))).toContain('button "결제하기"');
    expect(textOf(await s.call("browser_text", {}))).toContain("32,000원");
    expect(s.ledger.effectsInState("done")).toHaveLength(0);
  });

  test("a page action is journaled and runs on the element found again, even after the page renumbered its refs", async () => {
    const s = setup();
    await s.call("browser_snapshot", {});
    // Another snapshot elsewhere renumbers refs; the recorded target is role + name + position, not the ref.
    const result = await s.call("browser_act", { action: "fill", ref: "@e1", value: "Seoul", summary: "Fill the address" }, "fill-1");
    expect(textOf(result)).toContain("done");
    expect(s.fake.performed).toEqual(["fill Address Seoul"]);
    const [effect] = s.ledger.effectsInState("done");
    expect(effect?.tool).toBe("browser_act");
    // The same call replayed by Pi returns the recorded result and does nothing again.
    await s.call("browser_act", { action: "fill", ref: "@e1", value: "Seoul", summary: "Fill the address" }, "fill-1");
    expect(s.fake.performed).toHaveLength(1);
  });

  test("refs must come from the latest snapshot", async () => {
    const s = setup();
    expect(textOf(await s.call("browser_act", { action: "click", ref: "@e1", summary: "Click" }))).toContain("latest browser_snapshot");
    await s.call("browser_snapshot", {});
    await s.call("browser_open", { url: "https://shop.example/next" });
    expect(textOf(await s.call("browser_act", { action: "click", ref: "@e3", summary: "Help" }))).toContain("latest browser_snapshot");
  });

  test("a paying click waits for the owner, runs only after approval, and shows the page it was decided on", async () => {
    const s = setup();
    await s.call("browser_snapshot", {});
    const proposed = await s.call("browser_act", { action: "click", ref: "@e2", summary: "Pay 32,000원" }, "pay-1");
    expect(textOf(proposed)).toContain("approval required");
    expect(s.fake.performed).toEqual([]);
    const decision = s.ledger.pendingDecisions()[0]!;
    expect(decision.kind).toBe("approve_effect");
    expect(decision.proposal).toMatchObject({ kind: "browser", url: "https://shop.example/cart", target: 'button "결제하기"', commit: "바깥에 영향이 가는 동작" });
    expect((decision.proposal as { screenshot: { mediaType: string } }).screenshot.mediaType).toBe("image/png");
    await s.core.effects.resolveApproval(decision.effectId!, true);
    expect(s.fake.performed).toEqual(["click 결제하기"]);
    expect(s.ledger.effect(decision.effectId!).state).toBe("done");
  });

  test("an approved click does nothing when the page moved or the element is gone", async () => {
    const s = setup();
    await s.call("browser_snapshot", {});
    await s.call("browser_act", { action: "click", ref: "@e2", summary: "Pay" }, "pay-gone");
    const gone = s.ledger.pendingDecisions()[0]!;
    s.fake.elements = s.fake.elements.filter((element) => element.name !== "결제하기");
    await s.core.effects.resolveApproval(gone.effectId!, true);
    expect(s.ledger.effect(gone.effectId!).state).toBe("denied");
    expect(s.ledger.effect(gone.effectId!).result).toContain("no longer on the page");

    s.fake.elements.push({ role: "button", name: "결제하기" });
    const snapshot = textOf(await s.call("browser_snapshot", {}));
    const ref = /"결제하기" \[ref=(e\d+)\]/.exec(snapshot)![1]!;
    await s.call("browser_act", { action: "click", ref, summary: "Pay" }, "pay-moved");
    const moved = s.ledger.pendingDecisions().at(-1)!;
    s.fake.url = "https://phish.example/cart";
    await s.core.effects.resolveApproval(moved.effectId!, true);
    expect(s.ledger.effect(moved.effectId!).result).toContain("the page moved");
    expect(s.fake.performed).toEqual([]);
  });

  test("an approval does not outlive revoking browser_act", async () => {
    const s = setup();
    await s.call("browser_snapshot", {});
    await s.call("browser_act", { action: "click", ref: "@e2", summary: "Pay" }, "pay-revoked");
    const decision = s.ledger.pendingDecisions()[0]!;
    await execute(s.core, new Access(owner), { requestId: crypto.randomUUID(), command: { type: "ghost.update", ghostId: s.ghost.id, tools: ["browser_open"] } }, context);
    await s.core.effects.resolveApproval(decision.effectId!, true);
    expect(s.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(s.fake.performed).toEqual([]);
  });

  test("with the owner's commit grant a paying click runs at once and is still recorded", async () => {
    const s = setup({ commit: "never" });
    await s.call("browser_snapshot", {});
    expect(textOf(await s.call("browser_act", { action: "click", ref: "@e2", summary: "Pay", commit: "payment" }))).toContain("without approval");
    expect(s.ledger.pendingDecisions()).toHaveLength(0);
    expect(s.fake.performed).toEqual(["click 결제하기"]);
    expect(s.ledger.effectsInState("done").map((effect) => effect.tool)).toEqual(["browser_act"]);
  });

  test("sign-in uses only a granted login on its own origin, through a one-shot grant", async () => {
    const s = setup({ logins: [{ itemId: ITEM, origin: "https://shop.example", title: "Shop" }] });
    expect(textOf(await s.call("browser_login", { item_id: "0193a1b2-c3d4-4e5f-8a6b-000000000000" }))).toContain("not granted");
    s.fake.url = "https://other.example/login";
    expect(textOf(await s.call("browser_login", { item_id: ITEM }))).toContain("open the sign-in page on https://shop.example first");
    s.fake.url = "https://shop.example/login";
    expect(textOf(await s.call("browser_login", { item_id: ITEM }))).toContain("Signed in to Shop");
    const login = s.fake.calls.find((args) => args[0] === "auth")!;
    const token = login[2]!;
    expect(login).toEqual(["auth", "login", token, "--credential-provider", "shade", "--item", ITEM, "--no-navigate", "--url", "https://shop.example"]);
    expect(s.fake.grants.get(token)).toEqual({ itemId: ITEM, origin: "https://shop.example" });
    expect(s.fake.revoked).toEqual([token]);
    expect(s.ledger.effectsInState("done").map((effect) => effect.summary)).toEqual(["sign in to Shop"]);
  });

  test("without a Shade CLI there is no vault sign-in", async () => {
    const s = setup({ logins: [{ itemId: ITEM, origin: "https://shop.example", title: "Shop" }] });
    s.fake.vault = false;
    expect(textOf(await s.call("browser_login", { item_id: ITEM }))).toContain("not set up");
  });
});

describe("browser permissions", () => {
  test("the owner's browser grants are stored canonical, and non-https logins are refused", async () => {
    const s = setup();
    const save = (browser: GhostBrowserPermissions) =>
      execute(s.core, new Access(owner), { requestId: crypto.randomUUID(), command: { type: "ghost.permissions_update", ghostId: s.ghost.id, permissions: { ...DEFAULT_GHOST_PERMISSIONS, browser } } }, context);
    await save({ commit: "always", domains: ["*.Shop.Example.", "bank.example"], logins: [{ itemId: ITEM, origin: "https://Shop.example/", title: " Shop " }] });
    expect(s.ledger.ghost(s.ghost.id).permissions?.browser).toEqual({ commit: "always", domains: ["shop.example", "bank.example"], logins: [{ itemId: ITEM, origin: "https://shop.example", title: "Shop" }] });
    await expect(save({ commit: "always", domains: [], logins: [{ itemId: ITEM, origin: "http://shop.example", title: "Shop" }] })).rejects.toThrow("https origin");
    await expect(save({ commit: "always", domains: ["not a host"], logins: [] })).rejects.toThrow("hostname");
  });
});

describe("Shade credential plugin", () => {
  const writeGrant = (root: string, token: string, grant: Record<string, unknown>) => {
    mkdirSync(join(root, "browser", "grants"), { recursive: true });
    writeFileSync(join(root, "browser", "grants", `${token}.json`), JSON.stringify(grant));
  };
  const request = (token: string, itemRef: string, url: string) =>
    JSON.stringify({ protocol: "agent-browser.plugin.v1", type: "credential.resolve", capability: "credential.read", request: { profileName: token, itemRef, url } });
  const shade = (origin: string) => {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "item") return { code: 0, stdout: JSON.stringify({ status: "ok", data: { item: { id: ITEM, origin, username: "alice" } } }), stderr: "", secret: "" };
        return { code: 0, stdout: "", stderr: "", secret: "S3cret!pw" };
      },
    };
  };
  const token = `g${"a".repeat(32)}`;

  test("resolves the granted item once, reading the secret over a descriptor", async () => {
    const root = tempDir();
    writeGrant(root, token, { itemId: ITEM, origin: "https://shop.example", expiresAt: Date.now() + 60_000 });
    const vault = shade("https://shop.example");
    const reply = JSON.parse(await credentialPlugin({ root, shade: "shade", input: request(token, ITEM, "https://shop.example/login"), runShade: vault.run }));
    expect(reply).toEqual({ protocol: "agent-browser.plugin.v1", success: true, credential: { username: "alice", password: "S3cret!pw", url: "https://shop.example" } });
    expect(vault.calls).toEqual([["item", "show", ITEM, "--json"], ["secret", "read", ITEM, "--out-fd", "3"]]);
    expect(existsSync(join(root, "browser", "grants", `${token}.json`))).toBe(false);
    const again = JSON.parse(await credentialPlugin({ root, shade: "shade", input: request(token, ITEM, "https://shop.example/login"), runShade: vault.run }));
    expect(again.success).toBe(false);
  });

  test("refuses another item, another origin, an expired grant or a vault item that moved, without reading a secret", async () => {
    const cases: [Record<string, unknown>, string, string, string][] = [
      [{ itemId: ITEM, origin: "https://shop.example", expiresAt: Date.now() + 60_000 }, "0193a1b2-c3d4-4e5f-8a6b-000000000000", "https://shop.example/", "https://shop.example"],
      [{ itemId: ITEM, origin: "https://shop.example", expiresAt: Date.now() + 60_000 }, ITEM, "https://phish.example/", "https://shop.example"],
      [{ itemId: ITEM, origin: "https://shop.example", expiresAt: Date.now() - 1 }, ITEM, "https://shop.example/", "https://shop.example"],
      [{ itemId: ITEM, origin: "https://shop.example", expiresAt: Date.now() + 60_000 }, ITEM, "https://shop.example/", "https://elsewhere.example"],
    ];
    for (const [grant, itemRef, url, itemOrigin] of cases) {
      const root = tempDir();
      writeGrant(root, token, grant);
      const vault = shade(itemOrigin);
      const reply = JSON.parse(await credentialPlugin({ root, shade: "shade", input: request(token, itemRef, url), runShade: vault.run }));
      expect(reply.success).toBe(false);
      expect(JSON.stringify(reply)).not.toContain("S3cret");
      expect(vault.calls.some((args) => args[0] === "secret")).toBe(false);
    }
  });

  test("answers the manifest request", async () => {
    const reply = JSON.parse(await credentialPlugin({ root: tempDir(), shade: "shade", input: JSON.stringify({ protocol: "agent-browser.plugin.v1", type: "plugin.manifest", capability: "plugin.manifest", request: {} }) }));
    expect(reply.manifest.capabilities).toEqual(["credential.read"]);
  });
});

describe("agent-browser port", () => {
  /** A stand-in CLI run by Bun on every OS: records argv, knows one tab label, answers in agent-browser's JSON. */
  function fakeCli(root: string) {
    const script = join(root, "fake-agent-browser.ts");
    const log = join(root, "argv.log");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const command = args.slice(args.indexOf("--json") + 1);
if (command[0] === "tab" && command[1] !== "new" && command[1] !== "list") console.log(JSON.stringify({ success: false, data: null, error: "No tab with label" }));
else if (command[0] === "get") console.log(JSON.stringify({ success: true, data: { url: "https://shop.example/" }, error: null }));
else console.log(JSON.stringify({ success: true, data: {}, error: null }));
`,
    );
    return { script, log };
  }

  test("each call runs in the Ghost's browser and profile, focusing the conversation's tab first", async () => {
    const root = tempDir();
    const { script, log } = fakeCli(root);
    const browser = new AgentBrowser({ executable: process.execPath, prefix: [script], root, shade: null, ghostCommand: ["ghost"] });
    const reply = await browser.run("ghost-1", "cconv-1", ["get", "url"]);
    expect(reply).toEqual({ ok: true, data: { url: "https://shop.example/" } });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const tail = (args: string[]) => args.slice(args.indexOf("--json") + 1);
    expect(calls.map(tail)).toEqual([["tab", "cconv-1"], ["tab", "new", "--label", "cconv-1"], ["get", "url"]]);
    expect(calls[0]).toContain("ghost-ghost-1");
    expect(calls[0]![calls[0]!.indexOf("--profile") + 1]).toBe(join(root, "browser", "profiles", "ghost-1"));
    expect(JSON.parse(readFileSync(join(root, "browser", "agent-browser.json"), "utf8"))).toEqual({ plugins: [] });
    // Three child processes; starting Bun takes over a second each on Windows with real-time scanning.
  }, 30_000);

  test("with Shade configured the plugin wrapper runs this Ghost's credential subcommand", () => {
    const root = tempDir();
    const shade = join(root, "shade");
    writeFileSync(shade, "");
    const browser = new AgentBrowser({ executable: process.execPath, root, shade, ghostCommand: ["/opt/ghost/ghost"] });
    expect(browser.vault).toBe(true);
    const config = JSON.parse(readFileSync(join(root, "browser", "agent-browser.json"), "utf8")) as { plugins: { name: string; command: string; capabilities: string[] }[] };
    expect(config.plugins).toEqual([{ name: "shade", command: expect.stringContaining("shade-credential"), capabilities: ["credential.read"] }]);
    const wrapper = readFileSync(config.plugins[0]!.command, "utf8");
    expect(wrapper).toContain("/opt/ghost/ghost");
    expect(wrapper).toContain("browser-credential");
    expect(wrapper).toContain(shade);
    const token = browser.grantLogin({ itemId: ITEM, origin: "https://shop.example" });
    expect(token).toMatch(/^g[0-9a-f]{32}$/);
    expect(JSON.parse(readFileSync(join(root, "browser", "grants", `${token}.json`), "utf8"))).toMatchObject({ itemId: ITEM, origin: "https://shop.example" });
    browser.revokeGrant(token);
    expect(existsSync(join(root, "browser", "grants", `${token}.json`))).toBe(false);
  });
});
