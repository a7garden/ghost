import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { BROWSER_TOOLS, VaultItem, parse } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AgentBrowser, createBrowser } from "../src/integrations/browser.ts";
import { serveBrowser } from "../src/api/browser.ts";
import { startObscura } from "../src/integrations/obscura.ts";
import { createEgressProxy } from "../src/integrations/egress-proxy.ts";
import type { BrowserPort, BrowserSessionRef, SandboxEnvFactory, VaultPort } from "../src/integrations/ports.ts";
import { createBrowserTools } from "../src/tools/browser.ts";
import { createVaultTools } from "../src/tools/vault.ts";
import { LoginCapture, type LoginPage, type LoginField } from "../src/integrations/login-capture.ts";
import { createVault } from "../src/stores/vault.ts";
import { loadConfig } from "../src/config.ts";
import { harness, tempDir } from "./support.ts";

const SECRET = "never-return-this-credential-9823";
function snapshotFixture(role: string, name: string) {
  const prefix = `- ${role} `;
  const quotedName = JSON.stringify(name);
  const annotation = "[ref=e1]";
  const snapshot = `${prefix}${quotedName} ${annotation}`;
  return {
    snapshot, refs: { e1: { role, name } },
    snapshotAttribution: { version: 1, spans: [
      { start: 0, end: prefix.length },
      { start: prefix.length + quotedName.length + 1, end: snapshot.length },
    ] },
  };
}
function fakeExecutable(root: string) {
  const path = join(root, "fake-browser");
  writeFileSync(path, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, truncateSync } from "node:fs";
const root = ${JSON.stringify(root)};
const argv = process.argv.slice(2);
const i = argv.indexOf("--json");
const command = argv.slice(i + 1);
appendFileSync(root + "/calls", JSON.stringify({ argv, env: { HOME: process.env.HOME, PATH: process.env.PATH, OWNER_SECRET: process.env.OWNER_SECRET, keyLength: process.env.AGENT_BROWSER_ENCRYPTION_KEY?.length } }) + "\\n");
let data = {};
if (command[0] === "stream") data = { port: Number(readFileSync(root + "/stream-port", "utf8")) };
if (command[0] === "batch") { await Bun.stdin.text(); process.stdout.write(JSON.stringify([{ error: null }])); process.exit(0); }
if (command[0] === "hang") { writeFileSync(root + "/child-pid", String(process.pid)); setInterval(() => {}, 10000); await new Promise(() => {}); }
if (command[0] === "flood") { process.stdout.write("x".repeat(2 * 1024 * 1024)); process.exit(0); }
if (command[0] === "hold") { await fetch(command[1]); writeFileSync(root + "/hold-finished", "1"); }
if (command[0] === "after-hold" && !existsSync(root + "/hold-finished")) process.exit(1);
if (command[0] === "close" && !command.includes("--all") && existsSync(root + "/close-fail-once")) { rmSync(root + "/close-fail-once"); process.exit(1); }
if (command[0] === "grow-count" || command[0] === "grow-bytes") {
  const downloads = argv[argv.indexOf("--download-path") + 1];
  if (command[0] === "grow-count") for (let n = 0; n < 33; n++) writeFileSync(downloads + "/" + n, "");
  else { writeFileSync(downloads + "/large", ""); truncateSync(downloads + "/large", 65 * 1024 * 1024); }
}
if (command[0] === "open") {
  if (!argv.includes("--headed") && existsSync(root + "/open-fail-once")) { rmSync(root + "/open-fail-once"); process.exit(1); }
  writeFileSync(root + "/url", command[1]);
  data = { url: command[1], title: "Example Domain", lifecycle: { noise: "must-not-reach-model" } };
}
if (command[0] === "tab" && command[1] === "list") data = { tabs: [{ active: true, targetId: existsSync(root + "/tab-id") ? readFileSync(root + "/tab-id", "utf8") : "tab1", url: existsSync(root + "/url") ? readFileSync(root + "/url", "utf8") : "https://example.com/" }] };
if (command[0] === "get" && command[1] === "title") data = { title: "Example Domain" };
if (command[0] === "get" && command[1] === "url") data = { url: existsSync(root + "/url") ? readFileSync(root + "/url", "utf8") : "https://example.com/" };
if (command[0] === "get" && command[1] === "url" && argv.includes("--headed") && existsSync(root + "/headed-url-fail")) process.exit(1);
if (command[0] === "get" && command[1] === "text") data = { text: existsSync(root + "/page-text") ? readFileSync(root + "/page-text", "utf8") : "Submit" };
if (command[0] === "snapshot") data = existsSync(root + "/snapshot") ? JSON.parse(readFileSync(root + "/snapshot", "utf8")) : ${JSON.stringify({ origin: "https://example.com/", title: "Example Domain", ...snapshotFixture("link", "More information"), lifecycle: { noise: "must-not-reach-model" } })};
if (command[0] === "screenshot") { writeFileSync(command[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=", "base64")); data = { path: command[1] }; }
if (command[0] === "eval" && command[1] !== "--stdin") {
  // Host-authored reads: the viewport for the owner's live view, otherwise the page facts (checkout, total).
  data = { result: command[1].includes("innerWidth") ? JSON.stringify({ w: 1280, h: 720, url: existsSync(root + "/url") ? readFileSync(root + "/url", "utf8") : "https://example.com/", title: "Example Domain" })
    : existsSync(root + "/facts") ? readFileSync(root + "/facts", "utf8") : JSON.stringify({ origin: "https://example.com", checkout: false, signal: null, amount: null, currency: null }) };
} else if (command[0] === "eval") {
  const script = await Bun.stdin.text();
  if (existsSync(root + "/fail-secret")) { process.stderr.write(script); process.stdout.write(script); process.exit(1); }
  if (!script.includes('window.top !== window') || !script.includes('location.origin !==') || !script.includes('Object.getOwnPropertyDescriptor')) throw new Error("missing fill guard");
  // Simulate a compromised child response: the host must discard everything but the fixed status.
  data = { result: existsSync(root + "/refuse-secret") ? readFileSync(root + "/refuse-secret", "utf8") : "filled", echoed: script };
}
if (command[0] === "upload" || command[0] === "download") {
  if (existsSync(root + "/swap")) {
    const swap = JSON.parse(readFileSync(root + "/swap", "utf8"));
    rmSync(swap.path, { recursive: true, force: true }); symlinkSync(swap.target, swap.path);
  }
  if (command[0] === "upload") appendFileSync(root + "/uploads", JSON.stringify({ path: command[2], text: readFileSync(command[2], "utf8") }) + "\\n");
  else writeFileSync(command[2], "downloaded");
}
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
function installFakeOwnerObserver(browser: AgentBrowser, root: string) {
  type ObserverSession = { loginObserver?: { snapshot: () => Promise<LoginPage>; close: () => void } };
  const owner = browser as unknown as { ensureLogin(session: ObserverSession): Promise<void> };
  spyOn(owner, "ensureLogin").mockImplementation(async session => {
    session.loginObserver ??= {
      snapshot: async () => {
        const path = join(root, "url");
        const url = existsSync(path) ? readFileSync(path, "utf8") : "about:blank";
        return { targetId: "tab1", documentId: `fixture:${url}`, url, origin: new URL(url).origin, fields: [], focused: null, clicked: null };
      },
      close: () => {},
    };
  });
}
const sandbox = (workspace: string): SandboxEnvFactory => ({ workspacePath: () => workspace, envFor: async () => { throw new Error("unused"); }, stageInputs: async () => {}, release: async () => {} });
function fixture(config?: ConstructorParameters<typeof AgentBrowser>[0]) {
  const root = tempDir(); const workspace = join(root, "workspace"); mkdirSync(workspace);
  const browser = new AgentBrowser(config ?? { executable: fakeExecutable(root) }, root);
  if (!config) installFakeOwnerObserver(browser, root);
  const h = harness();
  const ghost = h.core.createGhost({ name: "Browser", persona: "Careful" });
  h.ledger.tx(() => h.ledger.putGhost({ ...ghost, tools: [...BROWSER_TOOLS] }));
  const direct = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(direct.id, "pi-browser");
  const item: VaultItem = { id: "login1", kind: "login", title: "Example", origin: "https://example.com", username: null, cardLast4: null, cardExpiry: null, contact: null, hints: "", ghostIds: [ghost.id], hasPassword: true, hasTotp: false, createdAt: 0, updatedAt: 0, expiresAt: null };
  let reveals = 0;
  const vault: VaultPort = { listFor: () => [item], itemFor: (_g, id) => { if (id !== item.id) throw new Error("wrong item"); return item; }, reveal: (_ghost, _id, field) => { reveals++; return field === "card_expiry" ? "12/29" : SECRET; }, generateLogin: () => item };
  const extension = createBrowserTools(h.core, browser, { vault, sandbox: sandbox(workspace) });
  let seq = 0;
  const call = (name: string, args: unknown = {}, pi = "pi-browser", callId = `call-${++seq}`) => {
    const tool = extension.tools!.find((t) => t.name === name)!;
    return tool.execute(args as never, { conversationId: pi, callId } as unknown as ToolExecutionApi, { abortSignal: undefined } as Context);
  };
  return { ...h, root, workspace, browser, ghost, direct, item, call, extension, reveals: () => reveals };
}

describe("isolated browser port", () => {
  test("Obscura config accepts exact HTTPS origins only", () => {
    const root = tempDir();
    const config = { browser: { executable: "/test/agent-browser", obscura: { executable: "/test/obscura", loginOrigins: ["https://example.com"] } } };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    expect(loadConfig({}, root).browser).toEqual(config.browser);
    for (const origin of ["http://example.com", "https://example.com/", "https://user@example.com", "https://example.com/login", "https://*.example.com"]) {
      config.browser.obscura.loginOrigins = [origin];
      writeFileSync(join(root, "config.json"), JSON.stringify(config));
      expect(() => loadConfig({}, root)).toThrow("invalid Obscura");
    }
  });
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
      expect(record.argv).toContain("--init-script");
      const init = readFileSync(record.argv[record.argv.indexOf("--init-script") + 1]!, "utf8");
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate"]) expect(init).toContain(name);
      expect(init).toContain("configurable: false");
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
  test("session redaction covers card grouping; card screenshots remain locked across origins until close", async () => {
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
      await expect(browser.run(session, ["screenshot"])).rejects.toThrow("close the browser session to reset");
      await browser.close(session);
      const fresh = await browser.run(session, ["get", "text"]); expect(JSON.stringify(fresh.data)).toContain("4111");
    } finally { await browser.shutdown(); }
  });
  test("encoded secret forms are redacted before any page text reaches the caller", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    const value = 'p a<&"\\\n';
    const forms = [value, encodeURIComponent(value), encodeURIComponent(value).replaceAll("%20", "+"), 'p a&lt;&amp;&quot;\\\n', JSON.stringify(value).slice(1, -1)];
    try {
      await browser.run(session, ["eval", "--stdin"], { stdin: "window.top !== window; location.origin !== ''; Object.getOwnPropertyDescriptor", sensitive: { value, field: "value", origin: "https://example.com" } });
      writeFileSync(join(root, "page-text"), forms.join(" | "));
      expect((await browser.run(session, ["get", "text"])).data).toEqual({ text: forms.map(() => "[redacted]").join(" | ") });
    } finally { await browser.shutdown(); }
  });
  test("password screenshot lock is scoped to its stable tab identity and clears only after its URL changes", async () => {
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    try {
      await browser.run(session, ["eval", "--stdin"], { stdin: "window.top !== window; location.origin !== ''; Object.getOwnPropertyDescriptor", sensitive: { value: SECRET, field: "password", origin: "https://example.com" } });
      await expect(browser.run(session, ["screenshot"])).rejects.toThrow("until that tab's URL changes");
      writeFileSync(join(root, "tab-id"), "other-tab");
      expect((await browser.run(session, ["screenshot"])).ok).toBe(true);
      writeFileSync(join(root, "tab-id"), "tab1");
      await expect(browser.run(session, ["screenshot"])).rejects.toThrow("until that tab's URL changes");
      writeFileSync(join(root, "url"), "https://example.com/next");
      expect((await browser.run(session, ["screenshot"])).ok).toBe(true);
      const downloads = records(root)[0]!.argv;
      const path = downloads[downloads.indexOf("--download-path") + 1]!;
      expect(readdirSync(path).filter((name) => name.endsWith(".png"))).toHaveLength(0);
    } finally { await browser.shutdown(); }
  });
  test("download quotas close the session and remove private files; shutdown retries only sessions that failed to close", async () => {
    for (const command of ["grow-count", "grow-bytes"]) {
      const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
      try {
        await expect(browser.run(session, [command])).rejects.toThrow("download limit exceeded");
        const args = records(root)[0]!.argv;
        expect(existsSync(args[args.indexOf("--download-path") + 1]!)).toBe(false);
      } finally { await browser.shutdown(); }
    }
    const root = tempDir(); const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
    try {
      await browser.run(session, ["snapshot"]);
      await browser.run({ ...session, conversationId: "second" }, ["snapshot"]);
      writeFileSync(join(root, "close-fail-once"), "1");
      await expect(browser.shutdown()).rejects.toThrow("Browser command failed");
      expect(commands(root).filter((argv) => argv[0] === "close" && argv.length === 1)).toHaveLength(2);
      await browser.shutdown();
      expect(commands(root).filter((argv) => argv[0] === "close" && argv.length === 1)).toHaveLength(3);
      await browser.shutdown();
      expect(commands(root).filter((argv) => argv[0] === "close" && argv.length === 1)).toHaveLength(3);
    } finally { await browser.shutdown(); }
  });
});

const obscuraExecutable = process.env.GHOST_TEST_OBSCURA;
const agentBrowserExecutable = process.env.GHOST_TEST_AGENT_BROWSER;
const chromeExecutable = process.env.GHOST_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const obscuraTest = obscuraExecutable && agentBrowserExecutable && process.platform === "darwin" ? test : test.skip;
obscuraTest("isolated Obscura: CDP discovery and the WebSocket both require the token", async () => {
  const proxy = await createEgressProxy();
  try {
    const engine = await startObscura(obscuraExecutable!, proxy.url, tempDir());
    try {
      expect((await fetch(`${engine.endpoint}/json/list`)).status).toBe(401);
      const socket = new WebSocket(engine.websocket);
      try {
        const refused = await new Promise<boolean>((resolve) => {
          socket.addEventListener("open", () => resolve(false), { once: true });
          socket.addEventListener("error", () => resolve(true), { once: true });
        });
        expect(refused).toBe(true);
      } finally { socket.close(); }
    } finally { await engine.stop(); }
  } finally { await proxy.close(); }
}, 10_000);

(existsSync(chromeExecutable) ? obscuraTest : test.skip)(
  "isolated Obscura: vault restrictions, egress refusal and secure Chrome live takeover",
  async () => {
    const f = fixture({ executable: agentBrowserExecutable!, chrome: chromeExecutable,
      obscura: { executable: obscuraExecutable!, loginOrigins: ["https://example.com"] } });
    const ref = { ghostId: f.ghost.id, conversationId: f.direct.id };
    let localHits = 0;
    const local = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { localHits++; return new Response("fixture"); } });
    try {
      expect((await f.call("browser_open", { url: "https://example.com", engine: "obscura" })).isError).toBeFalsy();
      await expect(f.browser.run(ref, ["open", "https://example.com"], { engine: "chrome" })).rejects.toThrow("Close the browser session");
      const blocked = await f.browser.run(ref, ["eval", `fetch("http://127.0.0.1:${local.port}/").then(()=>"unsafe").catch(()=>"blocked")`]);
      expect(blocked.data).toMatchObject({ result: "blocked" }); expect(localHits).toBe(0);
      expect(() => f.browser.assertVaultFill(ref, "password", "https://www.iana.org")).toThrow("unavailable");
      expect(() => f.browser.assertVaultFill(ref, "card_number", "https://example.com")).toThrow("unavailable");
      expect((await f.browser.run(ref, ["eval", `document.body.insertAdjacentHTML("afterbegin", '<label for="probe">Probe password</label><input type="password" id="probe">'); "ready"`])).ok).toBe(true);
      const snapshot = await f.browser.run(ref, ["snapshot", "-i"]);
      const refs = (snapshot.data as { refs: Record<string, { name: string }> }).refs;
      const field = Object.entries(refs).find(([, entry]) => entry.name === "Probe password")?.[0];
      expect(field).toBeDefined();
      const fill = await f.call("browser_fill_secret", { ref: `@${field}`, item_id: f.item.id, field: "password" });
      expect(fill.isError).toBeFalsy();
      expect(JSON.stringify([fill, f.ledger.db.query("SELECT * FROM effects").all()])).not.toContain(SECRET);
      expect((await f.browser.run(ref, ["eval", 'document.querySelector("#probe").value'])).data).toMatchObject({ result: "[redacted]" });
      await expect(f.browser.run(ref, ["screenshot"])).rejects.toThrow("until that tab's URL changes");
      expect((await f.call("browser_handoff", { reason: "Test owner input" })).isError).toBeFalsy();
      expect(f.browser.sessions()[0]).toMatchObject({engine:"chrome",headed:false});
      // A renderer transition carries cookies, not the former renderer's live DOM.
      expect((await f.browser.run(ref, ["eval", `document.body.insertAdjacentHTML("afterbegin", "<input id=owner style=position:fixed;left:20px;top:20px>"); "ready"`])).ok).toBe(true);
      const position = await f.browser.run(ref, ["eval", `(() => { const r = document.querySelector("#owner").getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`]);
      const decision = f.ledger.pendingDecisions()[0]!;
      expect((await f.call("browser_snapshot")).isError).toBe(true);
      const handoff = (action: "live" | "input", input?: object, signal?: AbortSignal) => {
        const url = new URL(`http://localhost/api/browser/sessions/${ref.conversationId}/${action}`);
        return serveBrowser(new Request(url, action === "live" ? { signal } : { method: "POST", body: JSON.stringify(input ?? {}) }), url, f.core, f.browser);
      };
      const abort = new AbortController();
      const response = await handoff("live", undefined, abort.signal);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let frame: { data: string } | undefined;
      while (!frame) {
        const value = await reader.read();
        if (value.done) throw new Error("Stream ended before a frame");
        for (const line of new TextDecoder().decode(value.value).trim().split("\n")) { const event = JSON.parse(line); if (event.type === "frame") frame = event; }
      }
      expect(Buffer.from(frame.data, "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
      const coordinates = (position.data as { result: { x: number; y: number } }).result;
      expect((await handoff("input", { type: "mouse", event: "down", ...coordinates })).ok).toBe(true);
      expect((await handoff("input", { type: "mouse", event: "up", ...coordinates })).ok).toBe(true);
      expect((await handoff("input", { type: "text", text: "한글 test" })).ok).toBe(true);
      abort.abort(); await reader.cancel();
      await f.core.decisions.resolve(decision.id, { outcome: "answer", answer: "Done" });
      expect((await f.call("browser_snapshot")).isError).toBeFalsy();
      expect((await f.browser.run(ref, ["eval", 'document.querySelector("#owner").value'])).data).toMatchObject({ result: "한글 test" });
      expect((await f.browser.run(ref, ["eval", 'localStorage.setItem("ephemeral", "yes"); "stored"'])).ok).toBe(true);
      await f.browser.close(ref);
      expect((await f.call("browser_open", { url: "https://example.com", engine: "obscura" })).isError).toBeFalsy();
      expect((await f.browser.run(ref, ["eval", 'localStorage.getItem("ephemeral")'])).data).toMatchObject({ result: null });
    } finally {
      await f.browser.shutdown();
      await local.stop(true);
      f.core.stop();
      f.ledger.close();
    }
  }, 45_000,
);

(agentBrowserExecutable && process.platform === "darwin" && existsSync(chromeExecutable) ? test : test.skip)(
  "real Chrome: vault contacts survive same-loader form replacement and input targets retain focus",
  async () => {
    const f = fixture({ executable: agentBrowserExecutable!, chrome: chromeExecutable });
    const vault = createVault(f.root);
    const ref = { ghostId: f.ghost.id, conversationId: f.direct.id };
    f.ledger.tx(() => f.ledger.putGhost({ ...f.ghost, tools: [...BROWSER_TOOLS, "vault_list"] }));
    const browserTools = createBrowserTools(f.core, f.browser, { vault, sandbox: sandbox(f.workspace) });
    const vaultTools = createVaultTools(f.core, vault);
    let seq = 0;
    const call = (name: string, args: unknown = {}) => [...browserTools.tools!, ...vaultTools.tools!].find((tool) => tool.name === name)!
      .execute(args as never, { conversationId: "pi-browser", callId: `native-${++seq}` } as unknown as ToolExecutionApi, { abortSignal: undefined } as Context);
    const evaluate = async (script: string) => {
      const result = await f.browser.run(ref, ["eval", script]);
      expect(result.ok).toBe(true);
      if (!result.data || typeof result.data !== "object" || !("result" in result.data)) throw new Error("Missing evaluation result");
      return result.data.result;
    };
    const snapshot = async () => {
      expect((await call("browser_snapshot", { interactive: true })).isError).toBeFalsy();
      const result = await f.browser.run(ref, ["snapshot", "-i"]);
      expect(result.ok).toBe(true);
      if (!result.data || typeof result.data !== "object" || !("refs" in result.data) ||
          !result.data.refs || typeof result.data.refs !== "object") throw new Error("Missing snapshot refs");
      const refs: Record<string, { name: string }> = {};
      for (const [key, value] of Object.entries(result.data.refs)) {
        if (value && typeof value === "object" && "name" in value && typeof value.name === "string") refs[key] = { name: value.name };
      }
      return refs;
    };
    const field = (refs: Record<string, { name: string }>, label: string) => {
      const entry = Object.entries(refs).find(([, value]) => value.name === label);
      expect(entry).toBeDefined();
      return `@${entry![0]}`;
    };
    try {
      const contact = { name: "수용 사용자", phone: "010-0000-0000", email: "owner@ghost.test", address: "수용 테스트 주소", addressDetail: "검증동 101호", postalCode: "00000" };
      const person = vault.create({ kind: "contact", title: "Native contact fixture", contact, ghostIds: [f.ghost.id] });
      const card = vault.create({ kind: "card", title: "Native card fixture", origin: "https://example.com", card: { number: "4242424242424242", expiry: "12/29", cvc: "679", name: "수용 전용" }, ghostIds: [f.ghost.id] });
      const listed = await call("vault_list", { kind: "contact" });
      expect(listed.isError).toBeFalsy();
      const metadata = listed.content!.flatMap((entry) => entry.type === "text" ? entry.text.split("\n").map((line) => parse(VaultItem, JSON.parse(line))) : []);
      const shared = metadata.find((item) => item.id === person.id)!.contact!;
      expect(shared).toEqual(contact);
      expect((await call("browser_open", { url: "https://example.com", engine: "chrome" })).isError).toBeFalsy();
      await evaluate(`document.body.innerHTML = '<p>총 결제 금액: ₩39,000</p><form><label>Card number<input id=number autocomplete=cc-number></label><label>Month<select id=month autocomplete=cc-exp-month><option value=""></option><option value=12>12</option></select></label><label>Year<select id=year autocomplete=cc-exp-year><option value=""></option><option value=2029>2029</option></select></label><label>CVC<input id=cvc autocomplete=cc-csc></label><label>Cardholder<input id=name autocomplete=cc-name></label><button>결제</button></form>'; window.nativeSubmits = 0; document.querySelector('form').onsubmit = e => { e.preventDefault(); window.nativeSubmits++; }; 'ready'`);
      const cardRefs = await snapshot();
      expect((await call("browser_fill_card", { item_id: card.id, number_ref: field(cardRefs, "Card number"), expiry_month_ref: field(cardRefs, "Month"), expiry_year_ref: field(cardRefs, "Year"), cvc_ref: field(cardRefs, "CVC"), name_ref: field(cardRefs, "Cardholder") })).isError).toBeFalsy();
      const decision = f.ledger.pendingDecisions()[0]!;
      expect(decision).toBeDefined();
      await f.core.decisions.resolve(decision.id, { outcome: "approve" });
      expect(f.ledger.effect(decision.effectId!).state).toBe("done");
      expect(await evaluate(`(() => { const expected = {number:'4242424242424242',month:'12',year:'2029',cvc:'679',name:'수용 전용'}; return Object.entries(expected).every(([id,value]) => document.getElementById(id).value === value); })()`)).toBe(true);
      expect(await evaluate("window.nativeSubmits")).toBe(0);
      // Replacing body is not a navigation: the daemon's document/loader identity
      // and earlier remote handles survive. Always obtain fresh refs afterward.
      const labels = { name: "이름", phone: "전화", email: "메일", address: "주소", addressDetail: "상세주소", postalCode: "우편번호" };
      await evaluate(`document.body.innerHTML = ${JSON.stringify(Object.entries(labels).map(([id, label]) => `<label>${label}<input id="${id}"></label>`).join("") + '<input id="untouched" aria-label="Untouched" value="leave me">')}; 'ready'`);
      const refs = await snapshot();
      const expected: Record<string, string> = { ...Object.fromEntries(Object.keys(labels).map((key) => [key, ""])), untouched: "leave me" };
      for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
        const value = shared[key];
        if (typeof value !== "string") throw new Error(`Vault contact lacks ${key}`);
        const filled = await call("browser_fill", { ref: field(refs, labels[key]), text: value });
        expect(filled.isError, `contact field ${key}: ${JSON.stringify(filled.content)}`).toBeFalsy();
        expected[key] = value;
        // Every insertion must leave all other fields (including earlier fills) exact.
        expect(await evaluate(`Object.fromEntries([...document.querySelectorAll('input')].map(e => [e.id,e.value]))`)).toEqual(expected);
      }
      await evaluate(`document.body.innerHTML = '<input id=prior value=unchanged><input id=target aria-label="Detaching target">'; document.querySelector('#prior').focus(); document.querySelector('#target').onfocus = function() { this.remove(); document.querySelector('#prior').focus(); }; 'ready'`);
      const detachedRefs = await snapshot();
      expect((await call("browser_fill", { ref: field(detachedRefs, "Detaching target"), text: "must not insert" })).isError).toBe(true);
      expect(await evaluate("document.querySelector('#prior').value")).toBe("unchanged");
      // A connected target that redirects focus must also fail for secret-fill's
      // focus/clear primitives, not merely for public fill/type.
      for (const command of ["focus", "clear", "type"] as const) {
        await evaluate(`document.querySelector('#prior').insertAdjacentHTML('afterend', '<input id=target aria-label="Redirecting target">'); document.querySelector('#target').onfocus = () => document.querySelector('#prior').focus(); 'ready'`);
        const redirectRefs = await snapshot();
        await expect(f.browser.run(ref, [command, field(redirectRefs, "Redirecting target"), ...(command === "type" ? ["must not insert"] : [])]))
          .rejects.toMatchObject({ code: "unavailable" });
        expect(await evaluate("document.querySelector('#prior').value")).toBe("unchanged");
        await evaluate("document.querySelector('#target').remove(); 'ready'");
      }
      await evaluate(`(async () => {
        document.body.innerHTML = '<div id=host></div><iframe id=frame></iframe><div contenteditable=true role=textbox aria-label="Editor"><span id=descendant>old</span></div>';
        const outer = document.querySelector('#host').attachShadow({mode:'closed'});
        outer.innerHTML = '<div id=nested></div>';
        const inner = outer.querySelector('#nested').attachShadow({mode:'closed'});
        inner.innerHTML = '<input aria-label="Nested closed shadow">';
        window.nativeShadowInput = inner.querySelector('input');
        const openHost = document.createElement('div'); document.body.append(openHost);
        window.nativeOpenInput = openHost.attachShadow({mode:'open'}).appendChild(document.createElement('input'));
        window.nativeOpenInput.setAttribute('aria-label', 'Open shadow');
        const frame = document.querySelector('#frame');
        const loaded = Promise.withResolvers();
        frame.onload = loaded.resolve;
        frame.srcdoc = '<input aria-label="Frame input">';
        await loaded.promise;
        return 'ready';
      })()`);
      const shadowRefs = await snapshot();
      // hasFocus includes browser-window activation and is page-overridable.
      // A false report must not block real CDP fills with correct DOM ownership.
      await evaluate(`Object.defineProperty(document, 'hasFocus', {value: () => false, configurable: true}); false`);
      for (const label of ["Nested closed shadow", "Open shadow", "Frame input", "Editor"]) {
        expect((await call("browser_fill", { ref: field(shadowRefs, label), text: label })).isError).toBeFalsy();
      }
      expect(await evaluate(`({closed: window.nativeShadowInput.value, open: window.nativeOpenInput.value, frame: document.querySelector('#frame').contentDocument.querySelector('input').value, editor: document.querySelector('[contenteditable]').textContent})`))
        .toEqual({ closed: "Nested closed shadow", open: "Open shadow", frame: "Frame input", editor: "Editor" });
      await evaluate(`delete document.hasFocus; document.body.insertAdjacentHTML('beforeend', '<input id=framePrior value=unchanged>'); document.querySelector('#frame').contentDocument.querySelector('input').onfocus = () => document.querySelector('#framePrior').focus(); 'ready'`);
      expect((await call("browser_fill", { ref: field(shadowRefs, "Frame input"), text: "must not insert" })).isError).toBe(true);
      expect(await evaluate("document.querySelector('#framePrior').value")).toBe("unchanged");
      expect(await evaluate("document.querySelector('#frame').contentDocument.querySelector('input').value")).toBe("Frame input");
      await evaluate(`document.querySelector('[contenteditable]').innerHTML = '<span id=descendant>old</span>'; 'ready'`);
      expect((await f.browser.run(ref, ["type", "#descendant", " + descendant"])).ok).toBe(true);
      expect(await evaluate("document.querySelector('[contenteditable]').textContent")).toBe("old + descendant");
    } finally {
      await f.browser.shutdown();
      vault.close();
      f.core.stop();
      f.ledger.close();
    }
  }, 60_000,
);

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
      const localService = await f.call("browser_open", { url: "http://127.0.0.1" });
      expect(localService.isError).toBe(true);
      expect(JSON.stringify(localService)).toContain("local services are not reachable by design");
      const localFile = await f.call("browser_tabs", { action: "new", url: "file:///etc/passwd" });
      expect(localFile.isError).toBe(true);
      expect(JSON.stringify(localFile)).toContain("host_read");
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
      expect(JSON.stringify(await f.call("browser_fill_secret", { ref: "@e1", item_id: "not-granted", field: "password" }))).toContain("Secret fill refused (not_granted)");
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
    for (const mode of ["origin", "frame", "target", "password"] as const) {
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
        if (mode === "password") input.type = "text";
        const window: { top?: unknown } = {}; window.top = mode === "frame" ? {} : window;
        const status = runInNewContext(options.stdin, { window, document, location: { origin: mode === "origin" ? "https://attacker.example" : "https://example.com" }, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, Event: class {} });
        return { ok: status === "filled", data: status === "filled" ? { status } : { status: "refused", reason: String(status).replace("refused:", "") }, error: null };
      });
      try {
        const result = await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "password" });
        expect(result.isError).toBe(true); expect(stored).toBe(""); expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).toContain(mode === "origin" ? "origin_mismatch" : mode === "target" ? "not_editable" : mode === "password" ? "not_password_field" : "frame");
      } finally { spy.mockRestore(); await f.browser.shutdown(); }
    }
  });
  test("card fields require approval, preserve metadata only and re-check permission", async () => {
    const f = fixture(); f.item.kind = "card"; f.item.cardLast4 = "1234";
    try {
      expect((await f.call("browser_fill_secret", { ref: "@e1", item_id: f.item.id, field: "card_number" })).isError).toBe(true);
      expect(f.ledger.pendingDecisions()).toHaveLength(0);
      await f.call("browser_fill_card", { number_ref: "@e1", item_id: f.item.id });
      expect(f.reveals()).toBe(0);
      const decision = f.ledger.pendingDecisions()[0]!; expect(JSON.stringify(decision)).toContain("1234"); expect(JSON.stringify(decision)).not.toContain(SECRET);
      await f.core.decisions.resolve(decision.id, { outcome: "approve" });
      expect(f.reveals()).toBe(1); expect(f.ledger.effect(decision.effectId!).state).toBe("done");
      await f.call("browser_fill_card", { number_ref: "@e1", cvc_ref: "@e2", item_id: f.item.id });
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
  test("handoff opens a live owner question; a Mac window opens only on the owner's request and ends lazily", async () => {
    const f = fixture();
    try {
      await f.call("browser_handoff", { reason: "Complete SSO" });
      const decision = f.ledger.pendingDecisions()[0]!;
      expect(decision.kind).toBe("question"); expect(decision.proposal?.browserHandoff).toEqual({ url: "https://example.com/", reason: "Complete SSO", live: true });
      expect(decision.title).toBe("브라우저에서 직접 처리해 주세요"); expect(decision.options).toEqual([]);
      expect(records(f.root).some((r) => r.argv.includes("--headed"))).toBe(false);
      expect((await f.call("browser_snapshot")).isError).toBe(true);
      await f.browser.handoff({ ghostId: f.ghost.id, conversationId: f.direct.id }, "https://example.com/");
      expect(records(f.root).some((r) => r.argv.includes("--headed"))).toBe(true);
      await f.core.decisions.resolve(decision.id, { outcome: "answer", answer: "Done" });
      writeFileSync(join(f.root, "url"), "https://example.com/owner-finished");
      const before = commands(f.root).filter((a) => a[0] === "close").length;
      await f.call("browser_snapshot"); expect(commands(f.root).filter((a) => a[0] === "close")).toHaveLength(before + 1);
      const resumed = records(f.root).filter((record) => !record.argv.includes("--headed") && record.argv.at(-2) === "open").at(-1)!;
      expect(resumed.argv.at(-1)).toBe("https://example.com/owner-finished");
      const after = commands(f.root).filter((a) => a[0] === "close").length;
      await f.call("browser_snapshot"); expect(commands(f.root).filter((a) => a[0] === "close")).toHaveLength(after);
      await f.call("browser_close");
    } finally { await f.browser.shutdown(); }
  });
  test("a failed headed URL read resumes at about:blank and reports the fallback even when the pending action fails", async () => {
    for (const pending of ["browser_snapshot", "browser_click"]) {
      const f = fixture();
      try {
        await f.call("browser_handoff", { reason: "Finish SSO" });
        const decision = f.ledger.pendingDecisions()[0]!;
        await f.browser.handoff({ ghostId: f.ghost.id, conversationId: f.direct.id }, "https://example.com/");
        await f.core.decisions.resolve(decision.id, { outcome: "answer", answer: "다 했어요" });
        writeFileSync(join(f.root, "headed-url-fail"), "1");
        if (pending === "browser_click") writeFileSync(join(f.root, "snapshot"), JSON.stringify({ snapshot: "blank page", refs: {}, snapshotAttribution: { version: 1, spans: [] } }));
        const result = await f.call(pending, pending === "browser_click" ? { ref: "@e1" } : {});
        expect(JSON.stringify(result)).toContain("the browser resumed at about:blank");
        expect(result.isError === true).toBe(pending === "browser_click");
        expect(commands(f.root).some((argv) => argv[0] === "open" && argv[1] === "about:blank")).toBe(true);
        expect(JSON.stringify(await f.call("browser_snapshot"))).not.toContain("the browser resumed at about:blank");
      } finally { await f.browser.shutdown(); }
    }
  });
  test("a failed headless reopen retains the owner's captured URL for an explicit retry", async () => {
    const f = fixture();
    try {
      await f.call("browser_handoff", { reason: "Finish identity check" });
      const decision = f.ledger.pendingDecisions()[0]!;
      await f.browser.handoff({ ghostId: f.ghost.id, conversationId: f.direct.id }, "https://example.com/");
      await f.core.decisions.resolve(decision.id, { outcome: "answer", answer: "다 했어요" });
      const completed = "https://example.com/completed";
      writeFileSync(join(f.root, "url"), completed);
      writeFileSync(join(f.root, "open-fail-once"), "1");
      expect((await f.call("browser_snapshot")).isError).toBe(true);
      writeFileSync(join(f.root, "url"), "about:blank");
      expect((await f.call("browser_snapshot")).isError).toBeFalsy();
      expect(commands(f.root).filter((argv) => argv[0] === "open").at(-1)).toEqual(["open", completed]);
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
  test("dangerous names require a proposal for click or focused Enter/Space", async () => {
    const f = fixture();
    try {
      expect((await f.call("browser_open", { url: "https://example.com/" })).isError).toBeFalsy();
      expect((await f.call("browser_snapshot")).isError).toBeFalsy();
      for (const name of ["Pay now", "Buy", "Purchase", "Order", "Checkout", "Delete item", "Remove", "Send", "Transfer", "Submit", "Unsubscribe", "결제하기", "구매", "주문", "삭제", "송금", "이체", "전송", "보내기", "제출", "탈퇴", "해지"]) {
        writeFileSync(join(f.root, "snapshot"), JSON.stringify(snapshotFixture("button", name)));
        await f.call("browser_snapshot");
        expect((await f.call("browser_click", { ref: "@e1" })).isError).toBe(true);
      }
      await f.call("browser_fill", { ref: "@e1", text: "message" });
      await f.call("browser_tabs", { action: "list" });
      for (const key of ["Enter", "Space", "Control+Enter", "Shift+Space"]) expect((await f.call("browser_press", { key })).isError).toBe(true);
      writeFileSync(join(f.root, "snapshot"), JSON.stringify(snapshotFixture("textbox", "Comment")));
      await f.call("browser_snapshot"); await f.call("browser_fill", { ref: "@e1", text: "message" });
      writeFileSync(join(f.root, "snapshot"), JSON.stringify(snapshotFixture("textbox", "Send")));
      await f.call("browser_snapshot");
      expect((await f.call("browser_press", { key: "Enter" })).isError).toBe(true);
      expect(commands(f.root).some((argv) => argv[0] === "click" || argv[0] === "press")).toBe(false);
    } finally { await f.browser.shutdown(); }
  });
  test("approved proposals re-read role/name and refused approved fills are denied, not unknown", async () => {
    const f = fixture();
    try {
      await f.call("browser_propose", { ref: "@e1", title: "Proceed", reason: "Reviewed action" });
      const proposal = f.ledger.pendingDecisions()[0]!;
      expect(proposal.proposal?.element).toEqual({ role: "link", name: "More information" });
      writeFileSync(join(f.root, "snapshot"), JSON.stringify(snapshotFixture("button", "Other")));
      await f.core.decisions.resolve(proposal.id, { outcome: "approve" });
      expect(f.ledger.effect(proposal.effectId!).state).toBe("denied");
      expect(commands(f.root).some((argv) => argv[0] === "click")).toBe(false);
      f.item.kind = "card";
      await f.call("browser_fill_card", { number_ref: "@e1", item_id: f.item.id });
      const card = f.ledger.pendingDecisions()[0]!;
      writeFileSync(join(f.root, "refuse-secret"), "refused:frame");
      await f.core.decisions.resolve(card.id, { outcome: "approve" });
      expect(f.ledger.effect(card.effectId!).state).toBe("denied");
      expect(f.ledger.effect(card.effectId!).result).toContain("Secret fill refused (frame)");
      expect(f.ledger.effectsInState("unknown")).toHaveLength(0);
      expect((await f.call("browser_fill", { ref: "@e1", text: "still usable" })).isError).toBeFalsy();
    } finally { await f.browser.shutdown(); }
  });
  test("upload staging survives source replacement and download commit refuses directory/leaf swaps without touching outside files", async () => {
    const f = fixture();
    try {
      const work = f.core.works.createRoot({ ghostId: f.ghost.id, originConversationId: f.direct.id, title: "Race files", brief: "Transfer files" });
      await f.core.idle(); f.ledger.setPiConversationId(f.ledger.work(work.id).conversationId!, "pi-work");
      const source = join(f.workspace, "upload.txt"); const outside = join(f.root, "outside.txt");
      writeFileSync(source, "safe upload"); writeFileSync(outside, "outside data");
      writeFileSync(join(f.root, "swap"), JSON.stringify({ path: source, target: outside }));
      expect((await f.call("browser_upload", { ref: "@e1", path: "upload.txt" }, "pi-work")).isError).toBeFalsy();
      const uploaded = JSON.parse(readFileSync(join(f.root, "uploads"), "utf8").trim());
      expect(uploaded.text).toBe("safe upload"); expect(uploaded.path).toContain("/browser/staging/"); expect(existsSync(uploaded.path)).toBe(false);
      const outsideDir = join(f.root, "outside-dir"); mkdirSync(outsideDir);
      writeFileSync(join(f.root, "swap"), JSON.stringify({ path: join(f.workspace, "downloads"), target: outsideDir }));
      expect((await f.call("browser_download", { ref: "@e1", name: "race.txt" }, "pi-work")).isError).toBe(true);
      expect(existsSync(join(outsideDir, "race.txt"))).toBe(false);
      unlinkSync(join(f.workspace, "downloads")); mkdirSync(join(f.workspace, "downloads"));
      writeFileSync(join(f.root, "swap"), JSON.stringify({ path: join(f.workspace, "downloads/race.txt"), target: outside }));
      expect((await f.call("browser_download", { ref: "@e1", name: "race.txt" }, "pi-work")).isError).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe("outside data");
      const transferCalls = commands(f.root).filter((argv) => argv[0] === "upload" || argv[0] === "download");
      expect(transferCalls.every((argv) => argv[2]?.includes("/browser/staging/") && !existsSync(argv[2]!))).toBe(true);
      expect(f.ledger.effectsInState("unknown")).toHaveLength(0);
    } finally { await f.browser.shutdown(); }
  });
});

describe("owner login capture", () => {
  test("only owner edits supply credentials; completion cannot manufacture or update a password", async () => {
    const saved: unknown[] = [], redacted: string[] = [];
    const capture = new LoginCapture(async login => { saved.push({...login}); },value => redacted.push(value));
    const username: LoginField = {id:"user",form:"login",kind:"username",length:0,start:0,end:0,score:100};
    const password: LoginField = {id:"pass",form:"login",kind:"password",length:0,start:0,end:0,score:0};
    const empty: LoginPage = {targetId:"tab1",documentId:"doc1",origin:"https://example.com",url:"https://example.com/login",fields:[username,password],focused:"user",clicked:null};
    const typed: LoginPage = {...empty,fields:[{...username,length:5,start:5,end:5},{...password,length:SECRET.length,start:SECRET.length,end:SECRET.length}]};
    const enter = () => { capture.edit(empty,username,{type:"insert",text:"owner"}); capture.edit(empty,password,{type:"insert",text:SECRET}); };
    capture.edit(empty,username,{type:"insert",text:"owner"});
    await capture.observe({...empty,password:SECRET,username:"owner",submitted:true} as unknown as LoginPage,true);
    capture.submit({...empty,fields:typed.fields},"login"); // A populated DOM password is not an owner edit.
    await capture.observe({...empty,url:"https://example.com/account",fields:[]});
    expect(saved).toHaveLength(0);
    capture.clear(); enter();
    expect(redacted).toContain(SECRET);
    await capture.observe({...typed,url:"https://example.com/elsewhere"});
    expect(saved).toHaveLength(0); // navigation without a genuine submit is not enough
    capture.clear(); enter(); capture.submit(typed,"login");
    await capture.observe(typed);
    expect(saved).toHaveLength(0); // failed submit, unchanged password field
    await capture.observe({...typed,url:"https://example.com/account",fields:[]});
    expect(saved).toEqual([{origin:empty.origin,username:"owner",password:SECRET}]);
    enter(); await capture.observe(typed); await capture.observe(null,true);
    expect(saved).toHaveLength(2);
    enter(); capture.clear(); await capture.observe(null,true);
    expect(saved).toHaveLength(2);
    enter(); await capture.observe(typed); await capture.observe({...typed,fields:[]});
    expect(saved).toHaveLength(2); // an ordinary script-driven transition is not an owner submission
    await capture.observe({...typed,fields:[]},true);
    expect(saved).toHaveLength(3); // explicit owner completion may confirm the last genuinely typed pair
    enter(); await capture.observe(typed);
    capture.edit(typed,typed.fields[1]!,{type:"unknown"});
    await capture.observe(null,true);
    expect(saved).toHaveLength(3);
  });
  test("unknown/model edits, other forms, targets and origins never acquire owner authority", async () => {
    const saved: unknown[] = [];
    const capture = new LoginCapture(async login => { saved.push({...login}); },()=>{},value => value === "model-password");
    const user: LoginField = {id:"u",form:"login",kind:"username",length:0,start:0,end:0,score:100};
    const pass: LoginField = {id:"p",form:"login",kind:"password",length:0,start:0,end:0,score:0};
    const base: LoginPage = {targetId:"one",documentId:"doc",url:"https://example.com/",origin:"https://example.com",fields:[user,pass],focused:"u",clicked:null};
    for (const other of [{...base,targetId:"two"},{...base,documentId:"other"},{...base,origin:"https://other.example",url:"https://other.example/"},{...base,fields:[user,{...pass,form:"other"}]}]) {
      capture.edit(base,user,{type:"insert",text:"owner"});
      capture.edit(other,other.fields[1]!,{type:"insert",text:SECRET});
      capture.submit({...base,fields:[{...user,length:5},{...pass,length:SECRET.length}]},"login");
      await capture.observe({...base,fields:[]});
      expect(saved).toHaveLength(0); capture.clear();
    }
    capture.edit(base,user,{type:"insert",text:"owner"});
    capture.edit(base,pass,{type:"insert",text:"model-password"},false);
    await capture.observe(null,true);
    expect(saved).toHaveLength(0);
    capture.clear();
    capture.edit(base,user,{type:"insert",text:"owner"});
    capture.edit(base,pass,{type:"insert",text:"model-password"});
    capture.submit({...base,fields:[{...user,length:5},{...pass,length:14}]},"login");
    await capture.observe({...base,fields:[]});
    expect(saved).toHaveLength(0);
  });
  test("owner deletion follows Unicode grapheme boundaries without manufacturing password bytes", async () => {
    const saved: unknown[] = [];
    const capture = new LoginCapture(async login => {saved.push({...login});},()=>{});
    const user: LoginField = {id:"u",form:"login",kind:"username",length:0,start:0,end:0,score:100};
    const pass: LoginField = {id:"p",form:"login",kind:"password",length:0,start:0,end:0,score:0};
    const page: LoginPage = {targetId:"one",documentId:"doc",url:"https://example.com/",origin:"https://example.com",fields:[user,pass],focused:"p",clicked:null};
    capture.edit(page,user,{type:"insert",text:"owner"});
    capture.edit(page,pass,{type:"insert",text:"비밀😀"});
    const populated = {...page,fields:[{...user,length:5},{...pass,length:4,start:4,end:4}]};
    await capture.observe(populated);
    capture.edit(populated,populated.fields[1]!,{type:"backspace"});
    capture.submit({...populated,fields:[populated.fields[0]!,{...pass,length:2,start:2,end:2}]},"login");
    await capture.observe({...page,fields:[]});
    expect(saved).toEqual([{origin:page.origin,username:"owner",password:"비밀"}]);
  });
  test("saveLogin merges canonical origin/username, keeps history and grants without duplicate versions", () => {
    const vault = createVault(tempDir());
    try {
      const first = vault.saveLogin("g1", { origin: "https://EXAMPLE.com:443/", username: "owner", password: SECRET });
      expect(first).toMatchObject({ kind: "login", title: "example.com", origin: "https://example.com", ghostIds: ["g1"], hints: "소유자가 브라우저에서 직접 로그인" });
      expect(vault.saveLogin("g1", { origin: first.origin!, username: "owner", password: SECRET }).id).toBe(first.id);
      expect(vault.history(first.id)).toHaveLength(1);
      expect(vault.saveLogin("g2", { origin: first.origin!, username: "owner", password: SECRET }).ghostIds).toEqual(["g1", "g2"]);
      const updated = vault.saveLogin("g2", { origin: first.origin!, username: "owner", password: "new-password-456" });
      expect(updated.id).toBe(first.id);
      expect(vault.history(first.id)).toHaveLength(3);
      expect(vault.reveal("g1", first.id, "password")).toBe("new-password-456");
      expect(vault.saveLogin("g1", { origin: "https://other.example", username: "owner", password: SECRET }).id).not.toBe(first.id);
      expect(vault.saveLogin("g1", { origin: first.origin!, username: "other", password: SECRET }).id).not.toBe(first.id);
      expect(() => vault.saveLogin("g1", { origin: "http://example.com", username: "owner", password: SECRET })).toThrow();
    } finally { vault.close(); }
  });
});

describe("whole-card approval", () => {
  test("one decision fills number, month/year selects and cvc; changed totals fill nothing", async () => {
    const f = fixture(); f.item.kind = "card";
    const original = f.browser.run.bind(f.browser);
    const values: Record<string, string> = {}; let focused = "";
    class Input {
      ownerDocument: unknown; disabled = false; readOnly = false; type = "text"; tagName = "INPUT"; maxLength = 255;
      set value(value: string) { values[focused] = value; }
      dispatchEvent() {}
    }
    class Select extends Input {
      override tagName = "SELECT";
      options = [{ value: "12", text: "12", disabled: false }, { value: "2029", text: "2029", disabled: false }];
      override set value(value: string) { values[focused] = value; }
    }
    const spy = spyOn(f.browser, "run").mockImplementation(async (ref, argv, options) => {
      if (argv[0] === "focus") focused = argv[1]!;
      if (!options?.stdin) return original(ref, argv, options);
      const element = ["@e2", "@e3"].includes(focused) ? new Select() : new Input();
      const document = { activeElement: element }; element.ownerDocument = document;
      const window: { top?: unknown } = {}; window.top = window;
      const result = runInNewContext(options.stdin, { window, document, location: { origin: "https://example.com" }, HTMLInputElement: Input, HTMLSelectElement: Select, HTMLTextAreaElement: class {}, Event: class {} });
      return { ok: result === "filled", data: { status: result }, error: null };
    });
    const args = { item_id: f.item.id, number_ref: "@e1", expiry_month_ref: "@e2", expiry_year_ref: "@e3", cvc_ref: "@e4" };
    try {
      writeFileSync(join(f.root, "facts"), JSON.stringify({ origin: "https://example.com", checkout: true, amount: "1000", currency: "KRW" }));
      await f.call("browser_fill_card", args);
      expect(f.ledger.pendingDecisions()).toHaveLength(1);
      const decision = f.ledger.pendingDecisions()[0]!;
      expect(decision.proposal).toMatchObject({ merchant: "example.com", total: "1,000원", fields: ["card_number", "card_expiry_month", "card_expiry_year", "card_cvc"] });
      expect(values).toEqual({});
      await f.core.decisions.resolve(decision.id, { outcome: "approve" });
      expect(values).toEqual({ "@e1": SECRET, "@e2": "12", "@e3": "2029", "@e4": SECRET });
      expect(f.ledger.effect(decision.effectId!).state).toBe("done");
      await f.call("browser_fill_card", args);
      const changed = f.ledger.pendingDecisions()[0]!;
      writeFileSync(join(f.root, "facts"), JSON.stringify({ origin: "https://example.com", checkout: true, amount: "9900", currency: "KRW" }));
      const before = f.reveals();
      await f.core.decisions.resolve(changed.id, { outcome: "approve" });
      expect(f.reveals()).toBe(before);
      expect(f.ledger.effect(changed.effectId!).state).toBe("denied");
    } finally { spy.mockRestore(); await f.browser.shutdown(); }
  });
});

test("legacy per-field card approvals are denied on extension startup and followed up without filling", async () => {
  const f = fixture();
  try {
    f.core.effects.onApproved("browser_fill_secret", async () => { throw new Error("Retired executor must not run"); });
    const effect = f.core.effects.propose({ conversationId: f.direct.id, callId: "legacy-card", tool: "browser_fill_secret", input: { ref: "@e1", item_id: f.item.id, field: "card_number", url: "https://example.com/" }, summary: "Old card fill", title: "카드 번호", detail: "", proposal: {} });
    createBrowserTools(f.core, f.browser, { vault: null, sandbox: sandbox(f.workspace) });
    expect(f.ledger.effect(effect.id).state).toBe("denied");
    expect(f.ledger.effect(effect.id).result).toContain("browser_fill_card");
    expect(f.ledger.pendingDecisions()).toHaveLength(0);
    await f.core.decisions.recover();
    expect(JSON.stringify([...f.engine.submissions.values()])).toContain("browser_fill_card");
    expect(f.reveals()).toBe(0);
  } finally { await f.browser.shutdown(); }
});

test("captured service credentials remain protected across owner handoff and return", async () => {
  const root = tempDir();
  const browser = new AgentBrowser({ executable: fakeExecutable(root) }, root);
  installFakeOwnerObserver(browser, root);
  try {
    await browser.run(session, ["open", "https://example.com"]);
    writeFileSync(join(root, "facts"), SECRET);
    writeFileSync(join(root, "page-text"), SECRET);
    expect(await browser.captureCredential(session, { origin: "https://example.com", selector: "#key" })).toBe(SECRET);
    await browser.handoff(session, "https://example.com");
    await expect(browser.run(session, ["screenshot"])).rejects.toThrow();
    await browser.endHandoff(session);
    expect((await browser.run(session, ["get", "text"])).data).toEqual({ text: "[redacted]" });
    await expect(browser.run(session, ["screenshot"])).rejects.toThrow();
    expect(await browser.captureCredential(session, { origin: "https://example.com", selector: "#key" })).toBe(SECRET);
  } finally { await browser.shutdown(); }
});
