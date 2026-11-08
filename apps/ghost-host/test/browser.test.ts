import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { BROWSER_TOOLS, type VaultItem } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AgentBrowser, createBrowser } from "../src/integrations/browser.ts";
import type { BrowserPort, BrowserSessionRef, SandboxEnvFactory, VaultPort } from "../src/integrations/ports.ts";
import { createBrowserTools } from "../src/tools/browser.ts";
import { loadConfig } from "../src/config.ts";
import { harness, tempDir } from "./support.ts";

const SECRET = "never-return-this-credential-9823";
function fakeExecutable(root: string) {
  const path = join(root, "fake-browser");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
const root = ${JSON.stringify(root)};
const argv = process.argv.slice(2);
const i = argv.indexOf("--json");
const command = argv.slice(i + 1);
appendFileSync(root + "/calls", JSON.stringify({ argv, env: { HOME: process.env.HOME, PATH: process.env.PATH, OWNER_SECRET: process.env.OWNER_SECRET, keyLength: process.env.AGENT_BROWSER_ENCRYPTION_KEY?.length } }) + "\\n");
let data = {};
if (command[0] === "hang") { writeFileSync(root + "/child-pid", String(process.pid)); setInterval(() => {}, 10000); await new Promise(() => {}); }
if (command[0] === "flood") { process.stdout.write("x".repeat(2 * 1024 * 1024)); process.exit(0); }
if (command[0] === "hold") { await fetch(command[1]); writeFileSync(root + "/hold-finished", "1"); }
if (command[0] === "after-hold" && !existsSync(root + "/hold-finished")) process.exit(1);
if (command[0] === "get" && command[1] === "url") data = { url: existsSync(root + "/url") ? readFileSync(root + "/url", "utf8") : "https://example.com/" };
if (command[0] === "get" && command[1] === "text") data = { text: existsSync(root + "/page-text") ? readFileSync(root + "/page-text", "utf8") : "Submit" };
if (command[0] === "snapshot") data = { snapshot: "- link More information [ref=e1]", refs: { e1: { role: "link", name: "More information" } } };
if (command[0] === "screenshot") { writeFileSync(command[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64")); data = { path: command[1] }; }
if (command[0] === "eval") {
  const script = await Bun.stdin.text();
  if (existsSync(root + "/fail-secret")) { process.stderr.write(script); process.stdout.write(script); process.exit(1); }
  if (!script.includes('window.top !== window') || !script.includes('location.origin !==') || !script.includes('Object.getOwnPropertyDescriptor')) throw new Error("missing fill guard");
  // Simulate a compromised child response: the host must discard everything but the fixed status.
  data = { result: "filled", echoed: script };
}
if (command[0] === "download") writeFileSync(command[2], "downloaded");
process.stdout.write(JSON.stringify({ success: true, data, error: null }));
`);
  chmodSync(path, 0o700);
  return path;
}
interface Recorded { argv: string[]; env: { HOME: string; PATH: string; OWNER_SECRET?: string; keyLength: number } }
function records(root: string): Recorded[] {
  if (!existsSync(join(root, "calls"))) return [];
  return readFileSync(join(root, "calls"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
}
function commands(root: string) { return records(root).map(({ argv }) => argv.slice(argv.indexOf("--json") + 1)); }
const session = { ghostId: "ghost1", conversationId: "conversation1" };
const sandbox = (workspace: string): SandboxEnvFactory => ({ workspacePath: () => workspace, envFor: async () => { throw new Error("unused"); }, stageInputs: async () => {}, release: async () => {} });
function fixture() {
  const root = tempDir(); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
  const h = harness();
  const ghost = h.core.createGhost({ name: "Browser", persona: "Careful" });
  h.ledger.tx(() => h.ledger.putGhost({ ...ghost, tools: [...BROWSER_TOOLS] }));
  const direct = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(direct.id, "pi-browser");
  const item: VaultItem = { id: "login1", kind: "login", title: "Example", origin: "https://example.com", username: null, cardLast4: null, cardExpiry: null, contact: null, hints: "", ghostIds: [ghost.id], hasPassword: true, hasTotp: false, createdAt: 0, updatedAt: 0, expiresAt: null };
  let reveals = 0;
  const vault: VaultPort = { listFor: () => [item], itemFor: (_g, id) => { if (id !== item.id) throw new Error("wrong item"); return item; }, reveal: () => { reveals++; return SECRET; }, generateLogin: () => item };
  const extension = createBrowserTools(h.core, browser, { vault, sandbox: sandbox(workspace) });
  let seq = 0;
  const call = (name: string, args: unknown = {}, pi = "pi-browser", callId = `call-${++seq}`) => {
    const tool = extension.tools!.find((t) => t.name === name)!;
    return tool.execute(args as never, { conversationId: pi, callId } as unknown as ToolExecutionApi, { abortSignal: undefined } as Context);
  };
  return { ...h, root, workspace, browser, ghost, direct, item, call, extension, reveals: () => reveals };
}

describe("isolated browser port", () => {
  test("config, private HOME, encrypted key, namespace, restore and proxy flags are host-owned", async () => {
    const root = tempDir();
    expect(createBrowser(loadConfig({}, root), { root })).toBeNull();
    writeFileSync(join(root, "config.json"), JSON.stringify({ browser: { executable: fakeExecutable(root), chrome: "/test/chrome", idleTimeoutMinutes: 7 } }));
    const browser = createBrowser(loadConfig({}, root), { root })!;
    try {
      await browser.run(session, ["open", "https://example.com/"]);
      const record = records(root)[0]!;
      expect(record.env.HOME).toBe(join(root, "browser/home")); expect(record.env.keyLength).toBe(64); expect(record.env.OWNER_SECRET).toBeUndefined();
      expect(record.argv).toContain("--namespace"); expect(record.argv).toContain("ghost-ghost1"); expect(record.argv).toContain("/test/chrome"); expect(record.argv).toContain("7m");
      expect(record.argv).toContain(join(root, "browser/config.json")); expect(readFileSync(join(root, "browser/config.json"), "utf8")).toBe("{}");
      expect(record.argv.find((a) => a.includes("--proxy-server="))).toMatch(/--proxy-server=http:\/\/127\.0\.0\.1:\d+,--proxy-bypass-list=<-loopback>,--force-webrtc-ip-handling-policy=disable_non_proxied_udp/);
      expect(statSync(join(root, "browser/key")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, "browser/key"), "utf8")).toMatch(/^[a-f0-9]{64}$/);
    } finally { await browser.shutdown(); }
  });
  test("LRU admission closes old sessions, conversation sessions differ but Ghost restore is shared", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    try {
      await Promise.all(Array.from({ length: 5 }, (_, n) => browser.run({ ghostId: "same", conversationId: String(n) }, ["snapshot"])));
      const lines = records(root); expect(commands(root).filter((a) => a[0] === "close" && a.length === 1)).toHaveLength(1);
      expect(new Set(lines.map(({ argv }) => argv[argv.indexOf("--session") + 1])).size).toBe(5);
      expect(lines.every(({ argv }) => argv[argv.indexOf("--restore") + 1] === "ghost-same")).toBe(true);
    } finally { await browser.shutdown(); }
  });
  test("stdin responses cannot echo secret data or raw errors", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    try {
      const result = await browser.run(session, ["eval", "--stdin"], { stdin: `window.top !== window; location.origin !== ''; Object.getOwnPropertyDescriptor; ${SECRET}` });
      expect(result).toEqual({ ok: true, data: { status: "filled" }, error: null });
      expect(JSON.stringify(records(root))).not.toContain(SECRET);
      writeFileSync(join(root, "fail-secret"), "1");
      let message = "";
      try { await browser.run(session, ["eval", "--stdin"], { stdin: SECRET }); }
      catch (error) { message = String(error); }
      expect(message).toContain("Browser command failed"); expect(message).not.toContain(SECRET);
    } finally { await browser.shutdown(); }
  });
  test("child deadlines and output caps stop failed commands without forwarding their output", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    try {
      // A real child-process deadline must exercise OS signal delivery, not a fake JS clock.
      await expect(browser.run(session, ["hang"], { timeoutMs: 100 })).rejects.toThrow("deadline exceeded");
      if (existsSync(join(root, "child-pid"))) {
        const pid = Number(readFileSync(join(root, "child-pid"), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      }
      await expect(browser.run(session, ["flood"])).rejects.toThrow("Browser command failed");
    } finally { await browser.shutdown(); }
  });
  test("commands serialize within a session while another conversation remains independent", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { entered.resolve(); return release.promise; } });
    try {
      const first = browser.run(session, ["hold", `http://127.0.0.1:${server.port}`]);
      await entered.promise;
      const queued = browser.run(session, ["after-hold"]);
      expect((await browser.run({ ...session, conversationId: "independent" }, ["snapshot"])).ok).toBe(true);
      expect(commands(root).some((argv) => argv[0] === "after-hold")).toBe(false);
      release.resolve(new Response("released"));
      expect((await first).ok).toBe(true); expect((await queued).ok).toBe(true);
    } finally { release.resolve(new Response("released")); await browser.shutdown(); await server.stop(true); }
  });
  test("session text redaction covers card grouping and screenshot lock expires only on origin change or close", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    const card = "4111 1111 1111 1111";
    try {
      const script = `window.top !== window; location.origin !== ''; Object.getOwnPropertyDescriptor; ${card}`;
      await browser.run(session, ["eval", "--stdin"], { stdin: script, sensitive: { value: card, field: "card_number", origin: "https://example.com" } });
      writeFileSync(join(root, "page-text"), "4111111111111111 / 4111-1111-1111-1111 / 4111 1111 1111 1111");
      const page = await browser.run(session, ["get", "text"]);
      expect(JSON.stringify(page.data)).not.toContain("4111"); expect(JSON.stringify(page.data)).toContain("[redacted]");
      await expect(browser.run(session, ["screenshot"])).rejects.toThrow("Screenshots are disabled");
      writeFileSync(join(root, "url"), "https://example.com/another-page");
      await expect(browser.run(session, ["screenshot"])).rejects.toThrow("Screenshots are disabled");
      writeFileSync(join(root, "url"), "https://other.example/");
      expect((await browser.run(session, ["screenshot"])).ok).toBe(true);
      await browser.close(session);
      const fresh = await browser.run(session, ["get", "text"]); expect(JSON.stringify(fresh.data)).toContain("4111");
    } finally { await browser.shutdown(); }
  });
});

describe("browser tools", () => {
  test("every tool refuses disabled tools and review conversations at execution time", async () => {
    const f = fixture();
    try {
      f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, tools: [] }));
      for (const name of BROWSER_TOOLS) expect((await f.call(name)).isError).toBe(true);
      f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, tools: [...BROWSER_TOOLS] }));
      const review = f.core.newConversation(f.ghost.id, "review", null, "Review");
      f.ledger.setPiConversationId(review.id, "pi-review");
      for (const name of BROWSER_TOOLS) expect((await f.call(name, {}, "pi-review")).isError).toBe(true);
      expect(records(f.root)).toHaveLength(0);
    } finally { await f.browser.shutdown(); }
  });
  test("reads are not journaled; page actions journal fixed outcomes and do not replay", async () => {
    const f = fixture();
    try {
      for (const [name, args] of [["browser_open", { url: "https://example.com/" }], ["browser_snapshot", { interactive: true, selector: "main" }], ["browser_read", { ref: "@e1" }], ["browser_scroll", { direction: "down" }], ["browser_navigate", { action: "back" }], ["browser_tabs", { action: "list" }], ["browser_tabs", { action: "switch", index: 0 }], ["browser_wait", { text: "ready" }]] as const) expect((await f.call(name, args)).isError).toBeFalsy();
      expect(f.ledger.db.query("SELECT count(*) AS n FROM effects").get()).toEqual({ n: 0 });
      const screenshot = await f.call("browser_screenshot", { full_page: true }); expect(screenshot.content?.[0]?.type).toBe("image");
      for (const [name, args] of [["browser_click", { ref: "@e1" }], ["browser_fill", { ref: "@e1", text: "hello" }], ["browser_type", { ref: "@e1", text: "there" }], ["browser_press", { key: "Enter" }], ["browser_select", { ref: "@e1", values: ["a", "b"] }], ["browser_check", { ref: "@e1", checked: false }], ["browser_tabs", { action: "new", url: "https://example.com/" }], ["browser_tabs", { action: "close", index: 0 }]] as const) {
        expect((await f.call(name, args)).isError).toBeFalsy();
      }
      expect(f.ledger.db.query("SELECT count(*) AS n FROM effects WHERE state = 'done'").get()).toEqual({ n: 8 });
      await f.call("browser_click", { ref: "@e1" }, "pi-browser", "replay");
      const before = commands(f.root).length;
      await f.call("browser_click", { ref: "@e1" }, "pi-browser", "replay"); expect(commands(f.root)).toHaveLength(before);
      expect((await f.call("browser_open", { url: "http://127.0.0.1" })).isError).toBe(true);
      expect((await f.call("browser_tabs", { action: "new", url: "file:///etc/passwd" })).isError).toBe(true);
      const beforeInjection = records(f.root).length;
      for (const [name, args] of [["browser_fill", { ref: "@e1", text: "--config=/tmp/evil" }], ["browser_snapshot", { selector: "--auto-connect" }], ["browser_select", { ref: "@e1", values: ["--proxy-bypass=*"] }]] as const) expect((await f.call(name, args)).isError).toBe(true);
      expect(records(f.root)).toHaveLength(beforeInjection);
    } finally { await f.browser.shutdown(); }
  });
  test("mutations commit a pending effect before invoking the executable", async () => {
    const f = fixture();
    const original = f.browser.run.bind(f.browser);
    const spy = spyOn(f.browser, "run").mockImplementation(async (session, argv, options) => {
      if (argv[0] === "click") expect(f.ledger.effectByCall(f.direct.id, "effect-proof")?.state).toBe("pending");
      return original(session, argv, options);
    });
    try {
      await f.call("browser_click", { ref: "@e1" }, "pi-browser", "effect-proof");
      expect(f.ledger.effectByCall(f.direct.id, "effect-proof")?.state).toBe("done");
    } finally { spy.mockRestore(); await f.browser.shutdown(); }
  });
  test("vault fills enforce HTTPS origin; secrets never reach argv, results, journals or events", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "url"), "https://other.example/");
      expect((await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "password" })).isError).toBe(true); expect(f.reveals()).toBe(0);
      writeFileSync(join(f.root, "url"), "https://example.com/");
      const result = await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "password" });
      expect(result.isError).toBeFalsy(); expect(f.reveals()).toBe(1);
      const rows = [f.ledger.db.query("SELECT * FROM effects").all(), f.ledger.db.query("SELECT * FROM events").all(), f.ledger.db.query("SELECT * FROM decisions").all(), [...f.engine.submissions.values()]];
      expect(JSON.stringify([result, rows, records(f.root)])).not.toContain(SECRET);
      expect(commands(f.root).some((a) => a.join(" ") === "focus @e1")).toBe(true);
      expect(commands(f.root).some((a) => a.join(" ") === "eval --stdin")).toBe(true);
    } finally { await f.browser.shutdown(); }
  });
  test("the stdin script rechecks top-level origin and refuses frames or non-editable targets", async () => {
    for (const mode of ["origin", "frame", "target"] as const) {
      const f = fixture(); let stored = "";
      class Input {
        ownerDocument: unknown; disabled = false; readOnly = false; type = "password";
        set value(value: string) { stored = value; }
        dispatchEvent() {}
      }
      class Textarea {}
      const original = f.browser.run.bind(f.browser);
      const spy = spyOn(f.browser, "run").mockImplementation(async (session, argv, options) => {
        if (!options?.stdin) return original(session, argv, options);
        const input = new Input(); const document = { activeElement: mode === "target" ? {} : input }; input.ownerDocument = document;
        const window: { top?: unknown } = {}; window.top = mode === "frame" ? {} : window;
        const status = runInNewContext(options.stdin, { window, document, location: { origin: mode === "origin" ? "https://attacker.example" : "https://example.com" }, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, Event: class {} });
        return { ok: status === "filled", data: { status }, error: null };
      });
      try {
        const result = await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "password" });
        expect(result.isError).toBe(true); expect(stored).toBe(""); expect(JSON.stringify(result)).not.toContain(SECRET);
      } finally { spy.mockRestore(); await f.browser.shutdown(); }
    }
  });
  test("card fields require approval, preserve metadata only and re-check permission", async () => {
    const f = fixture(); f.item.kind = "card"; f.item.cardLast4 = "1234";
    try {
      await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "card_number" });
      expect(f.reveals()).toBe(0);
      const decision = f.ledger.pendingDecisions()[0]!; expect(JSON.stringify(decision)).toContain("1234"); expect(JSON.stringify(decision)).not.toContain(SECRET);
      await f.core.decisions.resolve(decision.id, { outcome: "approve" });
      expect(f.reveals()).toBe(1); expect(f.ledger.effect(decision.effectId!).state).toBe("done");
      await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "card_cvc" });
      const revoked = f.ledger.pendingDecisions()[0]!;
      f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, tools: [] }));
      await f.core.decisions.resolve(revoked.id, { outcome: "approve" });
      expect(f.reveals()).toBe(1);
    } finally { await f.browser.shutdown(); }
  });
  test("proposed click runs after approval and refuses changed URL or expired proposal", async () => {
    const f = fixture();
    try {
      await f.call("browser_propose", { ref: "@e1", title: "Submit", reason: "Send this" });
      let decision = f.ledger.pendingDecisions()[0]!;
      expect(commands(f.root).some((a) => a[0] === "click")).toBe(false);
      await f.core.decisions.resolve(decision.id, { outcome: "approve" }); expect(commands(f.root).filter((a) => a[0] === "click")).toHaveLength(1);
      await f.call("browser_propose", { ref: "@e1", title: "Submit again", reason: "Send this" });
      decision = f.ledger.pendingDecisions()[0]!;
      writeFileSync(join(f.root, "url"), "https://example.com/changed");
      await f.core.decisions.resolve(decision.id, { outcome: "approve" }); expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
      await f.call("browser_propose", { ref: "@e1", title: "Old", reason: "Send" });
      decision = f.ledger.pendingDecisions()[0]!;
      f.ledger.db.query("UPDATE effects SET created_at = ? WHERE id = ?").run(Date.now() - 86_400_001, decision.effectId!);
      await f.core.decisions.resolve(decision.id, { outcome: "approve" }); expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
      expect(commands(f.root).filter((a) => a[0] === "click")).toHaveLength(1);
    } finally { await f.browser.shutdown(); }
  });
  test("handoff opens a deterministic owner question; later commands lazily end headed mode", async () => {
    const f = fixture();
    try {
      await f.call("browser_handoff", { reason: "Complete SSO" });
      const decision = f.ledger.pendingDecisions()[0]!;
      expect(decision.kind).toBe("question"); expect(decision.proposal?.browserHandoff).toEqual({ url: "https://example.com/", reason: "Complete SSO" });
      expect(records(f.root).some((r) => r.argv.includes("--headed"))).toBe(true);
      expect((await f.call("browser_snapshot")).isError).toBe(true);
      await f.core.decisions.resolve(decision.id, { outcome: "answer", answer: "Done" });
      const before = commands(f.root).filter((a) => a[0] === "close").length;
      await f.call("browser_snapshot"); expect(commands(f.root).filter((a) => a[0] === "close")).toHaveLength(before + 1);
      const after = commands(f.root).filter((a) => a[0] === "close").length;
      await f.call("browser_snapshot"); expect(commands(f.root).filter((a) => a[0] === "close")).toHaveLength(after);
      await f.call("browser_close");
    } finally { await f.browser.shutdown(); }
  });
  test("uploads/downloads are work-only and reject traversal, symlinks and overwrites", async () => {
    const f = fixture();
    try {
      expect((await f.call("browser_upload", { ref: "@e1", path: "a" })).isError).toBe(true);
      const work = f.core.works.createRoot({ ghostId: f.ghost.id, originConversationId: f.direct.id, title: "Files", brief: "Files" });
      await f.core.idle();
      const running = f.ledger.work(work.id); expect(running.conversationId).not.toBeNull();
      f.ledger.setPiConversationId(running.conversationId!, "pi-work");
      writeFileSync(join(f.workspace, "good.txt"), "data"); symlinkSync(join(f.workspace, "good.txt"), join(f.workspace, "link"));
      mkdirSync(join(f.root, "outside")); symlinkSync(join(f.root, "outside"), join(f.workspace, "escape"));
      for (const path of ["../fake-browser", "link", "escape/nope"]) expect((await f.call("browser_upload", { ref: "@e1", path }, "pi-work")).isError).toBe(true);
      expect((await f.call("browser_upload", { ref: "@e1", path: "good.txt" }, "pi-work")).isError).toBeFalsy();
      expect((await f.call("browser_download", { ref: "@e1", name: "../outside" }, "pi-work")).isError).toBe(true);
      symlinkSync(join(f.root, "outside"), join(f.workspace, "downloads"));
      expect((await f.call("browser_download", { ref: "@e1", name: "file.txt" }, "pi-work")).isError).toBe(true);
      unlinkSync(join(f.workspace, "downloads"));
      expect((await f.call("browser_download", { ref: "@e1", name: "file.txt" }, "pi-work")).isError).toBeFalsy();
      expect(readFileSync(join(f.workspace, "downloads/file.txt"), "utf8")).toBe("downloaded");
      expect((await f.call("browser_download", { ref: "@e1", name: "file.txt" }, "pi-work")).isError).toBe(true);
    } finally { await f.browser.shutdown(); }
  });
});
