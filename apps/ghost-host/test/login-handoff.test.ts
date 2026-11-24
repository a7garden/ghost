import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserLoginShelf, LoginChoice, MailDiscovery, ShadeStatus } from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { startServer } from "../src/api/server.ts";
import type { CliResult, CliRunner } from "../src/integrations/cli.ts";
import { LocalAccounts } from "../src/integrations/local-accounts.ts";
import { LoginShelf } from "../src/integrations/login-shelf.ts";
import { discoverMail, type MailDiscoveryDeps } from "../src/integrations/mail-discovery.ts";
import type { BrowserCommandResult, BrowserLiveInput, BrowserPort, BrowserSessionRef } from "../src/integrations/ports.ts";
import { Shade } from "../src/integrations/shade.ts";
import { createVault } from "../src/stores/vault.ts";
import { harness, tempDir } from "./support.ts";

const ok = (stdout: unknown): CliResult => ({ code: 0, stdout: Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)), stderr: "" });
const fail = (): CliResult => ({ code: 1, stdout: Buffer.alloc(0), stderr: "" });
const envelope = (data: unknown) => ok({ api_version: 1, request_id: "r", status: "ok", data });
const READY = { initialized: true, unlocked: true, agent_access: true, agent_write_enabled: true };

interface Call { args: string[]; stdin?: string }
/** A scripted `shade`: each subcommand answers from `state`, every call is recorded without the secrets in argv. */
function fakeShade(state: { status?: Record<string, unknown>; items?: Record<string, unknown>[]; password?: string; putFails?: boolean }) {
  const calls: Call[] = [];
  const run: CliRunner = async (_program, args, options) => {
    calls.push({ args, ...(options?.stdin ? { stdin: Buffer.from(options.stdin).toString("utf8") } : {}) });
    if (args[0] === "status") return state.status ? envelope(state.status) : fail();
    if (args[0] === "items") return envelope({ items: state.items ?? [] });
    if (args[0] === "secret") return state.password ? ok(state.password) : fail();
    if (args[0] === "item") return state.putFails ? fail() : envelope({ item: { id: "11111111-1111-4111-8111-111111111111" } });
    return fail();
  };
  let saveLogins = true, clock = 0;
  const shade = new Shade({ program: "/fake/shade", run, now: () => clock, prefs: { saveLogins: () => saveLogins, setSaveLogins: (value) => { saveLogins = value; } } });
  return { shade, calls, advance: (ms: number) => { clock += ms; }, prefs: { set: (value: boolean) => { saveLogins = value; } } };
}
const SHADE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const shadeItem = (over: Record<string, unknown> = {}) => ({ id: SHADE_ID, title: "Example", username: "owner@example.com", origin: "https://app.example.com", revision: 1, pending_change: null, deleted: false, ...over });

describe("mail discovery", () => {
  const guard = async () => {};
  const xml = (imap: string, smtp: string) => `<clientConfig><emailProvider id="corp.example">${imap}${smtp}</emailProvider></clientConfig>`;
  const incoming = (type: string, host: string, port: number, socket: string) => `<incomingServer type="${type}"><hostname>${host}</hostname><port>${port}</port><socketType>${socket}</socketType></incomingServer>`;
  const outgoing = (host: string, port: number, socket: string) => `<outgoingServer type="smtp"><hostname>${host}</hostname><port>${port}</port><socketType>${socket}</socketType></outgoingServer>`;
  const respond = (body: string, status = 200) => async () => new Response(body, { status });

  test("known providers need no lookup and say how to sign in", async () => {
    const naver = await discoverMail("Owner@Naver.com", { guard: async () => { throw new Error("no network for known providers"); } });
    expect(naver).toMatchObject({ domain: "naver.com", provider: { id: "naver" }, imap: { host: "imap.naver.com", port: 993 }, auth: "app_password", source: "known" });
    expect((await discoverMail("someone@outlook.com")).auth).toBe("oauth");
    expect((await discoverMail("someone@hanmail.net")).provider?.id).toBe("daum");
  });

  test("a company domain's autoconfig supplies implicit-TLS IMAP and the best SMTP", async () => {
    const urls: string[] = [];
    const deps: MailDiscoveryDeps = { guard, resolveMx: async () => [], fetch: async (url) => {
      urls.push(url);
      return url.startsWith("https://autoconfig.corp.example/") ? new Response("", { status: 404 })
        : new Response(xml(incoming("imap", "imap.mail.corp.example", 143, "STARTTLS") + incoming("imap", "imap.mail.corp.example", 993, "SSL"), outgoing("smtp.mail.corp.example", 587, "STARTTLS") + outgoing("smtp.mail.corp.example", 465, "SSL")));
    } };
    const found: MailDiscovery = await discoverMail("me@corp.example", deps);
    expect(found).toMatchObject({ source: "autoconfig", provider: null, imap: { host: "imap.mail.corp.example", port: 993 }, smtp: { host: "smtp.mail.corp.example", port: 465, secure: true } });
    expect(urls[0]).toBe("https://autoconfig.corp.example/mail/config-v1.1.xml?emailaddress=me%40corp.example");
  });

  test("a config that only offers STARTTLS IMAP or a private server is not offered", async () => {
    const starttls = await discoverMail("me@corp.example", { guard, resolveMx: async () => [], fetch: respond(xml(incoming("imap", "imap.corp.example", 143, "STARTTLS"), "")) });
    expect(starttls.imap?.host).toBe("imap.corp.example"); // falls through to the guessed implicit-TLS server, never port 143
    expect(starttls.imap?.port).toBe(993);
    const privateHost = await discoverMail("me@corp.example", {
      resolveMx: async () => [], fetch: respond(xml(incoming("imap", "imap.corp.example", 993, "SSL"), "")),
      guard: async (url) => { if (url.includes("imap.corp.example")) throw new Error("private"); },
    });
    expect(privateHost).toMatchObject({ imap: null, source: "none" });
  });

  test("hosted business mail is recognised from MX records, and an unknown domain stays honest", async () => {
    const miss = respond("", 404);
    const google = await discoverMail("me@startup.example", { guard, fetch: miss, resolveMx: async () => [{ exchange: "alt1.aspmx.l.google.com", priority: 20 }, { exchange: "aspmx.l.google.com", priority: 1 }] });
    expect(google).toMatchObject({ source: "mx", provider: { id: "gmail", name: "Google Workspace" }, imap: { host: "imap.gmail.com" }, auth: "app_password" });
    const m365 = await discoverMail("me@firm.example", { guard, fetch: miss, resolveMx: async () => [{ exchange: "firm-example.mail.protection.outlook.com", priority: 0 }] });
    expect(m365).toMatchObject({ provider: { id: "outlook", name: "Microsoft 365" }, auth: "oauth" });
    const none = await discoverMail("me@nowhere.example", { fetch: miss, resolveMx: async () => { throw new Error("ENODATA"); }, guard: async () => { throw new Error("unresolvable"); } });
    expect(none).toMatchObject({ imap: null, smtp: null, source: "none" });
  });

  test("a malformed address is refused before any network use", async () => {
    await expect(discoverMail("not-an-address", { guard: async () => { throw new Error("must not run"); } })).rejects.toThrow("이메일 주소");
    await expect(discoverMail("a b@example.com")).rejects.toThrow("이메일 주소");
  });
});

describe("local accounts", () => {
  const status = (entries: unknown[]) => ok({ hosts: { "github.com": entries } });
  test("lists only signed-in github.com accounts with their scopes", async () => {
    const accounts = new LocalAccounts({ program: "/fake/gh", run: async () => status([
      { state: "success", active: true, host: "github.com", login: "a7garden", scopes: "admin:org, gist, repo" },
      { state: "error", login: "stale" }, { state: "success", login: "bad login;rm" },
    ]) });
    expect(await accounts.github()).toEqual([{ login: "a7garden", scopes: ["admin:org", "gist", "repo"] }]);
    expect(await new LocalAccounts({ program: null }).github()).toEqual([]);
    expect(await new LocalAccounts({ program: "/fake/gh", run: async () => fail() }).github()).toEqual([]);
  });
  test("a token is only taken for a valid login and a plausible token", async () => {
    const calls: string[][] = [];
    const accounts = new LocalAccounts({ program: "/fake/gh", run: async (_p, args) => { calls.push(args); return ok("gho_abcdefghijklmnopqrstuvwxyz0123456789\n"); } });
    expect(await accounts.githubToken("a7garden")).toBe("gho_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(calls[0]).toEqual(["auth", "token", "--hostname", "github.com", "--user", "a7garden"]);
    await expect(accounts.githubToken("--hostname")).rejects.toThrow();
    await expect(new LocalAccounts({ program: "/fake/gh", run: async () => ok("not a token\n") }).githubToken("a7garden")).rejects.toThrow();
  });
});

describe("Shade bridge", () => {
  test("reports why Shade cannot be used yet", async () => {
    expect((await fakeShade({}).shade.status()).state).toBe("unavailable");
    expect((await fakeShade({ status: { ...READY, initialized: false } }).shade.status()).state).toBe("unavailable");
    expect(await fakeShade({ status: { ...READY, unlocked: false } }).shade.status()).toMatchObject({ state: "locked", writable: false });
    expect((await fakeShade({ status: { ...READY, agent_access: false } }).shade.status()).state).toBe("agent_off");
    expect(await fakeShade({ status: READY }).shade.status()).toEqual({ state: "ready", writable: true, saveLogins: true });
    expect(await new Shade({ program: null, prefs: { saveLogins: () => true, setSaveLogins: () => {} } }).status()).toMatchObject({ state: "unavailable" });
  });

  test("status is shared between pollers for a few seconds", async () => {
    const f = fakeShade({ status: READY });
    await f.shade.status(); await f.shade.status();
    expect(f.calls.filter((call) => call.args[0] === "status")).toHaveLength(1);
    f.advance(4000); await f.shade.status();
    expect(f.calls.filter((call) => call.args[0] === "status")).toHaveLength(2);
  });

  test("find returns exact-origin, live, unambiguous logins only", async () => {
    const f = fakeShade({ status: READY, items: [
      shadeItem(), shadeItem({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", origin: "https://evil.example.com" }),
      shadeItem({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", deleted: true }), shadeItem({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", pending_change: { attempt: "x" } }), shadeItem({ id: "not-a-uuid" }),
    ] });
    expect(await f.shade.find("https://app.example.com")).toEqual([{ id: SHADE_ID, title: "Example", username: "owner@example.com", origin: "https://app.example.com" }]);
    expect(f.calls.find((call) => call.args[0] === "items")?.args).toEqual(["items", "find", "--origin", "https://app.example.com", "--json"]);
    expect(await fakeShade({ status: { ...READY, unlocked: false }, items: [shadeItem()] }).shade.find("https://app.example.com")).toEqual([]);
  });

  test("a password is read through stdout for Host code only, and failure never echoes output", async () => {
    expect(await fakeShade({ status: READY, password: "SYNTHETIC-shade-secret" }).shade.password(SHADE_ID)).toBe("SYNTHETIC-shade-secret");
    await expect(fakeShade({ status: READY }).shade.password(SHADE_ID)).rejects.toThrow("Shade에서 암호를 읽을 수 없습니다.");
    await expect(fakeShade({ status: READY, password: "x" }).shade.password("../etc")).rejects.toThrow();
  });

  test("a new login is mirrored once, only when Shade lets agents write and the owner kept mirroring on", async () => {
    const login = { origin: "https://app.example.com", username: "owner@example.com", password: "SYNTHETIC-pw", title: "Example" };
    const f = fakeShade({ status: READY });
    expect(await f.shade.saveLogin(login)).toBe(true);
    const put = f.calls.find((call) => call.args[0] === "item");
    expect(put?.args).toEqual(["item", "put", "--input-fd", "0", "--json"]);
    expect(JSON.parse(put!.stdin!)).toEqual({ title: "Example", username: "owner@example.com", origin: "https://app.example.com", password: "SYNTHETIC-pw", expected_revision: 0 });
    expect(JSON.stringify(f.calls.map((call) => call.args))).not.toContain("SYNTHETIC-pw");

    const same = fakeShade({ status: READY, items: [shadeItem()] });
    expect(await same.shade.saveLogin(login)).toBe(true);
    expect(same.calls.some((call) => call.args[0] === "item")).toBe(false);

    const readOnly = fakeShade({ status: { ...READY, agent_write_enabled: false } });
    expect(await readOnly.shade.saveLogin(login)).toBe(false);
    const off = fakeShade({ status: READY }); off.prefs.set(false);
    expect(await off.shade.saveLogin(login)).toBe(false);
    expect(await fakeShade({ status: READY, putFails: true }).shade.saveLogin(login)).toBe(false);
  });
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

class FakeBrowser implements BrowserPort {
  url: string | null = "https://app.example.com/login";
  inputs: BrowserLiveInput[] = [];
  constructor(readonly refs: BrowserSessionRef[]) {}
  sessions() { return this.refs.map((ref) => ({ ...ref, engine: "chrome" as const, headed: false })); }
  pageUrl() { return this.url; }
  async run(_ref: BrowserSessionRef, argv: string[]): Promise<BrowserCommandResult> { return argv[0] === "get" && argv[1] === "url" ? { ok: true, data: this.url, error: null } : { ok: false, data: null, error: "unsupported" }; }
  async input(_ref: BrowserSessionRef, input: BrowserLiveInput) { this.inputs.push(input); }
  async captureCredential(): Promise<string> { throw new Error("unused"); }
  async handoff() {}
  async live() { return () => {}; }
  async endHandoff() { return { fallback: false }; }
  async close() {}
  async shutdown() {}
}

function fixture(shadeState: Parameters<typeof fakeShade>[0] = { status: READY }) {
  const root = tempDir(), h = harness(join(root, "ledger.db")), vault = createVault(root);
  const ghost = h.core.createGhost({ name: "Login", persona: "" });
  const other = h.core.createGhost({ name: "Other", persona: "" });
  const ref: BrowserSessionRef = { ghostId: ghost.id, conversationId: ghost.directConversationId };
  const browser = new FakeBrowser([ref]);
  const shade = fakeShade(shadeState);
  const logins = new LoginShelf({ vault, shade: shade.shade, browser });
  const config: Config = { root, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: "owner-test", documents: null, skills: null, vault, browser, logins, shade: shade.shade, localAccounts: new LocalAccounts({ program: null }) });
  const base = `http://127.0.0.1:${server.port}`;
  cleanup.push(async () => { await server.stop(); vault.close(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method, headers: { authorization: "Bearer owner-test", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const session = `/api/browser/sessions/${encodeURIComponent(ref.conversationId)}`;
  return { ...h, vault, ghost, other, ref, browser, shade, logins, request, session };
}

describe("login shelf", () => {
  const SECRET = "SYNTHETIC-vault-password";
  test("lists this Ghost's logins for exactly this origin, plus Shade logins not yet imported", async () => {
    const f = fixture({ status: READY, items: [shadeItem(), shadeItem({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", username: "saved@example.com" })] });
    f.vault.create({ kind: "login", title: "Mine", origin: "https://app.example.com", username: "saved@example.com", password: SECRET, ghostIds: [f.ghost.id] });
    f.vault.create({ kind: "login", title: "Not granted", origin: "https://app.example.com", username: "x", password: SECRET, ghostIds: [f.other.id] });
    f.vault.create({ kind: "login", title: "Elsewhere", origin: "https://other.example.com", username: "y", password: SECRET, ghostIds: [f.ghost.id] });
    const response = await f.request(`${f.session}/login`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const shelf: BrowserLoginShelf = JSON.parse(text);
    expect(shelf.origin).toBe("https://app.example.com");
    expect(shelf.items.map((item) => item.title)).toEqual(["Mine"]);
    expect(shelf.shade.items.map((item) => item.username)).toEqual(["owner@example.com"]);
    expect(shelf.shade.status).toEqual({ state: "ready", writable: true, saveLogins: true });
    expect(shelf.saved).toBeNull();
  });

  test("a blank or non-https page offers nothing", async () => {
    const f = fixture();
    f.browser.url = null;
    expect(await (await f.request(`${f.session}/login`)).json()).toMatchObject({ origin: null, items: [], shade: { items: [] } });
    f.browser.url = "http://app.example.com/";
    const run = await (await f.request(`${f.session}/login`)).json() as BrowserLoginShelf;
    expect(run.origin).toBeNull();
  });

  test("filling types the saved value like the owner would, only on the right site and for a granted Ghost", async () => {
    const f = fixture();
    const mine = f.vault.create({ kind: "login", title: "Mine", origin: "https://app.example.com", username: "owner@example.com", password: SECRET, ghostIds: [f.ghost.id] });
    const ungranted = f.vault.create({ kind: "login", title: "Other's", origin: "https://app.example.com", username: "z", password: SECRET, ghostIds: [f.other.id] });
    const fill = (itemId: string, field: string) => f.request(`${f.session}/fill`, "POST", { itemId, field });

    expect((await fill(mine.id, "password")).status).toBe(200);
    expect((await fill(mine.id, "username")).status).toBe(200);
    expect(f.browser.inputs).toEqual([{ type: "text", text: SECRET }, { type: "text", text: "owner@example.com" }]);

    expect((await fill(mine.id, "totp")).status).toBe(404); // nothing saved for that field
    expect((await fill(ungranted.id, "password")).status).toBe(403);
    f.browser.url = "https://evil.example.com/login";
    expect((await fill(mine.id, "password")).status).toBe(403);
    expect((await f.request(`${f.session}/fill`, "POST", { itemId: mine.id, field: "card_number" })).status).toBe(400);
    expect(f.browser.inputs).toHaveLength(2);
  });

  test("importing a Shade login grants a copy to this Ghost and moves it out of the Shade list", async () => {
    const f = fixture({ status: READY, items: [shadeItem()], password: SECRET });
    const response = await f.request(`${f.session}/login/shade`, "POST", { shadeItemId: SHADE_ID });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const choice: LoginChoice = JSON.parse(text);
    expect(choice).toMatchObject({ title: "Example", username: "owner@example.com", hasPassword: true });
    expect(f.vault.reveal(f.ghost.id, choice.id, "password")).toBe(SECRET);
    expect(f.vault.itemFor(f.ghost.id, choice.id).hints).toBe("Shade에서 가져옴");
    const shelf: BrowserLoginShelf = await (await f.request(`${f.session}/login`)).json();
    expect(shelf.items.map((item) => item.id)).toEqual([choice.id]);
    expect(shelf.shade.items).toEqual([]);
    expect((await f.request(`${f.session}/login/shade`, "POST", { shadeItemId: "ffffffff-ffff-4fff-8fff-ffffffffffff" })).status).toBe(404);
    expect((await f.request(`${f.session}/login/shade`, "POST", { shadeItemId: SHADE_ID, extra: 1 })).status).toBe(400);
  });

  test("a login the owner completes is remembered for the card, mirrored to Shade, and aged out by the handoff start", async () => {
    const f = fixture({ status: READY });
    const login = { origin: "https://app.example.com", username: "owner@example.com", password: SECRET };
    const startedAt = Date.now();
    const item = f.vault.saveLogin(f.ghost.id, login);
    await f.logins.captured(f.ref, login, item, startedAt);
    const shelf: BrowserLoginShelf = await (await f.request(`${f.session}/login`)).json();
    expect(shelf.saved).toMatchObject({ itemId: item.id, username: "owner@example.com", created: true, shade: true });
    expect(f.shade.calls.some((call) => call.args[0] === "item")).toBe(true);
    // The same login used again is not "new".
    await f.logins.captured(f.ref, login, f.vault.saveLogin(f.ghost.id, login), Date.now() + 1);
    expect((await f.logins.shelf(f.ref, null)).saved?.created).toBe(false);
    // A handoff that began after the login does not claim it.
    expect((await f.logins.shelf(f.ref, Date.now() + 60_000)).saved).toBeNull();
  });
});

describe("owner routes", () => {
  test("Shade status and the mirroring preference", async () => {
    const f = fixture({ status: READY });
    expect(await (await f.request("/api/shade")).json()).toEqual({ state: "ready", writable: true, saveLogins: true });
    const off: ShadeStatus = await (await f.request("/api/shade", "PUT", { saveLogins: false })).json();
    expect(off.saveLogins).toBe(false);
    expect((await f.request("/api/shade", "PUT", { saveLogins: "yes" })).status).toBe(400);
  });

  test("an unreadable address is a 400 and a missing GitHub CLI lists no accounts", async () => {
    const f = fixture();
    expect((await f.request("/api/connect/mail?email=nope")).status).toBe(400);
    expect(await (await f.request("/api/connect/local")).json()).toEqual({ accounts: [] });
    expect((await f.request("/api/connect/local", "POST", { source: "gh", login: "a7garden" })).status).toBe(404);
    expect((await f.request("/api/connect/mail?email=a@naver.com")).status).toBe(200);
  });
});
