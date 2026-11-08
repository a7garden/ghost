import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivitySource, Connection } from "@ghost/contract";
import type { FetchQueryObject, ImapFlow, ImapFlowOptions, SearchObject } from "imapflow";
import type { MailComposerOptions } from "nodemailer";
import { SourceConnections, validateConnectionConfig, type ActivitySourceFetch } from "../src/integrations/activity-sources.ts";
import type { ActivitySmtpClient, ActivitySmtpOptions } from "../src/integrations/activity-mail.ts";
import { NoEffect } from "../src/core/effects.ts";

const TOKEN = "private-account-app-password-123";
const instant = "2026-11-08T10:00:00.000Z";
const github: Connection = { id: "github", name: "GitHub", config: { kind: "github", baseUrl: "https://api.github.com" }, hasCredential: true, credentialVersion: "account-v1", createdAt: Date.parse(instant), updatedAt: Date.parse(instant) };
const mail: Connection = { id: "mail", name: "Mail", config: { kind: "mail", host: "imap.example.com", port: 993, username: "owner@example.com", mailbox: "INBOX", smtpHost: "smtp.example.com", smtpPort: 587, smtpSecure: false }, hasCredential: true, credentialVersion: "account-v1", createdAt: Date.parse(instant), updatedAt: Date.parse(instant) };
const prSource: Extract<ActivitySource, { kind: "pull_request" }> = { kind: "pull_request", connectionId: github.id, repository: "garden/ghost", baseBranch: null, labels: [], includeDrafts: false, includeExisting: true, pollSeconds: 60 };
const mailSource: Extract<ActivitySource, { kind: "mail" }> = { kind: "mail", connectionId: mail.id, sender: null, subjectContains: null, unreadOnly: false, includeExisting: true, pollSeconds: 60 };
function pr(number: number) {
  return { number, title: `Change ${number}`, body: `Body ${number}`, state: "open", draft: false, updated_at: instant, head: { sha: `head-${number}` }, base: { ref: "main", sha: "base" }, labels: [{ name: "review" }], user: { login: "author" }, html_url: `https://github.com/garden/ghost/pull/${number}` };
}
function prAPI(records = [pr(1)], pageSize = 100) {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const writes: { path: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, init });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^(Bearer|token) /);
    if (url.pathname.endsWith("/user")) return Response.json({ id: 7, login: "owner" });
    if (init?.method === "POST") {
      writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return Response.json({ id: 9 }, { status: 201 });
    }
    if (url.pathname.endsWith("/comments")) return Response.json([]);
    const number = Number(url.pathname.match(/\/pulls\/(\d+)(?:\.diff)?$/)?.[1]);
    if (number) {
      if (new Headers(init?.headers).get("accept")?.includes("diff")) return new Response("diff --git a/file b/file\n+added\n");
      return Response.json(records.find(record => record.number === number));
    }
    if (url.pathname.endsWith("/pulls")) {
      const page = Number(url.searchParams.get("page"));
      return Response.json(records.slice((page - 1) * pageSize, page * pageSize));
    }
    throw new Error(`Unexpected fixture path ${url.pathname}`);
  }) as ActivitySourceFetch;
  return { fetcher, requests, writes, records };
}
async function fixture(options: { fetch?: ActivitySourceFetch; imap?: (options: ImapFlowOptions) => ImapFlow; smtp?: (options: ActivitySmtpOptions) => ActivitySmtpClient; currentConnection?: (id: string) => Connection | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ghost-activity-source-"));
  const sources = new SourceConnections({ root, ...options });
  await sources.setCredential(github.id, TOKEN, github.credentialVersion);
  await sources.setCredential(mail.id, TOKEN, mail.credentialVersion);
  return { root, sources, async close() { await sources.close(); rmSync(root, { recursive: true, force: true }); } };
}
function rawMail(uid: number, extra = "") {
  return Buffer.from(`From: Sender <sender@example.com>\r\nReply-To: replies@example.com\r\nTo: owner@example.com\r\nSubject: Task ${uid}\r\nMessage-ID: <source-${uid}@example.com>\r\nDate: Sun, 8 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n${extra}\r\nMessage body ${uid}`);
}
class MailboxFixture extends EventEmitter {
  readonly messages = new Map<number, Buffer>();
  readonly fetches: { uid: string; query: FetchQueryObject; options: unknown }[] = [];
  readonly searches: SearchObject[] = [];
  readonly opened: unknown[] = [];
  readonly settings: ImapFlowOptions[] = [];
  validity = 1n;
  closes = 0;
  seen = new Set<number>();
  constructor(count = 1) { super(); for (let uid = 1; uid <= count; uid++) this.messages.set(uid, rawMail(uid)); }
  connect = async () => {};
  mailboxOpen = async (_path: string, options: unknown) => {
    this.opened.push(options);
    return { uidValidity: this.validity, uidNext: Math.max(0, ...this.messages.keys()) + 1 };
  };
  search = async (query: SearchObject) => {
    this.searches.push(query);
    const [start, end] = String(query.uid).split(":").map(Number);
    return [...this.messages.keys()].filter(uid => uid >= start! && uid <= end! && (query.seen !== false || !this.seen.has(uid))).reverse();
  };
  fetchOne = async (uid: string, query: FetchQueryObject, options: unknown) => {
    this.fetches.push({ uid, query, options });
    const source = this.messages.get(Number(uid));
    return source ? { uid: Number(uid), seq: Number(uid), source, size: source.byteLength } : false;
  };
  close = () => { this.closes++; };
  factory = (options: ImapFlowOptions) => { this.settings.push(options); return this as unknown as ImapFlow; };
}
function smtpFixture() {
  const settings: ActivitySmtpOptions[] = [];
  const sent: MailComposerOptions[] = [];
  let verified = 0;
  let closed = 0;
  const factory = (options: ActivitySmtpOptions): ActivitySmtpClient => {
    settings.push(options);
    return { async verify() { verified++; }, async sendMail(message, authorize, writeStarted) { authorize(); writeStarted(); sent.push(message); return { accepted: ["replies@example.com"], rejected: [] }; }, close() { closed++; } };
  };
  return { factory, settings, sent, verified: () => verified, closed: () => closed };
}

test("connection secrets are hashed, private, atomic, durable and revocable", async () => {
  const f = await fixture();
  try {
    const id = "../../outside";
    await f.sources.setCredential(id, TOKEN, "outside-v1");
    const dir = join(f.root, "secrets", "connections");
    const file = join(dir, `${createHash("sha256").update(id).digest("hex")}.json`);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(TOKEN);
    expect(readdirSync(dir).every(name => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
    const reopened = new SourceConnections({ root: f.root });
    try { expect(reopened.credentialPresent(id)).toBe(true); } finally { await reopened.close(); }
    await f.sources.setCredential(id, null, null);
    expect(f.sources.credentialPresent(id)).toBe(false);
    await expect(f.sources.setCredential(id, "unsafe\npassword", "outside-v2")).rejects.toThrow("line breaks");
  } finally { await f.close(); }
});

test("owner configuration validation is synchronous and rejects credential-bearing or insecure URLs", () => {
  expect(() => validateConnectionConfig({ kind: "github", baseUrl: "http://api.github.com" })).toThrow("HTTPS");
  for (const baseUrl of ["https://secret@example.com/api", "https://example.com/api?token=secret", "https://example.com/api#secret", "file:///etc/passwd"]) {
    expect(() => validateConnectionConfig({ kind: "gitea", baseUrl })).toThrow();
  }
  expect(() => validateConnectionConfig({ kind: "gitea", baseUrl: "http://private-tailnet/api/v1" })).not.toThrow();
  expect(() => validateConnectionConfig({ ...mail.config, kind: "mail", host: "bad\r\nhost" } as Extract<Connection["config"], { kind: "mail" }>)).toThrow("IMAP TLS");
});

test("Gitea cap50 pagination observes every PR and an empty page ends the bounded scan", async () => {
  const api = prAPI(Array.from({ length: 51 }, (_, index) => pr(index + 1)), 50);
  const connection: Connection = { ...github, config: { kind: "gitea", baseUrl: "http://tailnet-git/api/v1" } };
  const f = await fixture({ fetch: api.fetcher });
  try {
    let cursor: string | null = null;
    const numbers: string[] = [];
    for (let batch = 0; batch < 3; batch++) {
      const result = await f.sources.poll(connection, prSource, cursor);
      cursor = result.cursor;
      numbers.push(...result.items.map(item => item.target.number!));
      expect(result.exclusions).toEqual([]);
    }
    expect(new Set(numbers).size).toBe(51);
    expect(numbers).toContain("51");
    expect(api.requests.map(request => request.url.searchParams.get("page"))).toEqual(["1", "2", "3", "1", "2", "3", "1", "2", "3"]);
  } finally { await f.close(); }
});

test("PR observation admits metadata independently of an explicitly failing bound enrichment read", async () => {
  const api = prAPI([pr(1), pr(2)]);
  const f = await fixture({ fetch: (async (input, init) => {
    if (String(input).endsWith("/pulls/1") && new Headers(init?.headers).get("accept")?.includes("diff")) return new Response("private failure body", { status: 500 });
    return api.fetcher(input, init);
  }) as ActivitySourceFetch });
  try {
    const result = await f.sources.poll(github, prSource, null);
    expect(result.items.map(item => item.target.number)).toEqual(["1", "2"]);
    expect(api.requests.every(request => request.url.pathname.endsWith("/pulls"))).toBe(true);
    await expect(f.sources.read(github, result.items[0]!)).rejects.toThrow("HTTP 500");
    expect((await f.sources.read(github, result.items[1]!)).text).toContain("Diff:");
    expect((await f.sources.poll(github, prSource, result.cursor)).items).toEqual([]);
  } finally { await f.close(); }
});

test("oversized mail produces a stable exclusion and later normal UID advances without fetching oversized bytes", async () => {
  const box = new MailboxFixture(2);
  box.messages.set(1, Buffer.alloc(2 * 1024 * 1024 + 1));
  const f = await fixture({ imap: box.factory });
  try {
    const result = await f.sources.poll(mail, mailSource, null);
    expect(result.items.map(item => item.target.uid)).toEqual(["2"]);
    expect(result.exclusions).toMatchObject([{ id: expect.stringContaining(":1:1"), title: null, reason: expect.stringContaining("Mail UID 1:") }]);
    expect(JSON.parse(result.cursor!).uid).toBe(2);
    expect(box.fetches.filter(fetch => fetch.uid === "1").every(fetch => !fetch.query.source)).toBe(true);
    expect((await f.sources.poll(mail, mailSource, null)).exclusions).toEqual(result.exclusions);
    expect((await f.sources.poll(mail, mailSource, result.cursor)).exclusions).toEqual([]);
    const baseline = await f.sources.poll(mail, { ...mailSource, includeExisting: false }, null);
    expect(baseline).toMatchObject({ items: [], exclusions: [] });
  } finally { await f.close(); }
});

test("PR polling preserves all same-timestamp items beyond its 20-item delivery batch", async () => {
  const api = prAPI(Array.from({ length: 27 }, (_, index) => pr(index + 1)));
  const f = await fixture({ fetch: api.fetcher });
  try {
    const first = await f.sources.poll(github, prSource, null);
    expect(first.items).toHaveLength(20);
    expect(Object.keys(JSON.parse(first.cursor!).seen)).toHaveLength(20);
    const second = await f.sources.poll(github, prSource, first.cursor);
    expect(second.items).toHaveLength(7);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(27);
    expect((await f.sources.poll(github, prSource, second.cursor)).items).toEqual([]);
  } finally { await f.close(); }
});

test("PR baselines cover every API page and trigger only later versions or new PRs", async () => {
  const api = prAPI(Array.from({ length: 105 }, (_, index) => pr(index + 1)));
  const f = await fixture({ fetch: api.fetcher });
  try {
    const source = { ...prSource, includeExisting: false };
    const baseline = await f.sources.poll(github, source, null);
    expect(baseline.items).toEqual([]);
    expect(api.requests.filter(request => request.url.pathname.endsWith("/pulls")).map(request => request.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(api.requests.every(request => !request.url.pathname.match(/\/pulls\/\d/))).toBe(true);
    expect((await f.sources.poll(github, source, baseline.cursor)).items).toEqual([]);
    api.records[0]!.head.sha = "changed";
    api.records.push(pr(106));
    const changed = await f.sources.poll(github, source, baseline.cursor);
    expect(changed.items.map(item => item.target.number)).toEqual(["1", "106"]);
    // The original cursor remains reusable for dry runs; the connector has no hidden poll state.
    expect((await f.sources.poll(github, source, baseline.cursor)).items.map(item => item.id)).toEqual(changed.items.map(item => item.id));
  } finally { await f.close(); }
});

test("PR filters advance only handled versions, and source/account cursor mismatches are rejected", async () => {
  const api = prAPI([pr(1), { ...pr(2), draft: true }, { ...pr(3), base: { ref: "other", sha: "base" } }, { ...pr(4), labels: [] }]);
  const f = await fixture({ fetch: api.fetcher });
  try {
    const source = { ...prSource, labels: ["review"], baseBranch: "main" };
    const result = await f.sources.poll(github, source, null);
    expect(result.items.map(item => item.target.number)).toEqual(["1"]);
    expect((await f.sources.poll(github, source, result.cursor)).items).toEqual([]);
    await expect(f.sources.poll(github, { ...source, repository: "other/repo" }, result.cursor)).rejects.toThrow("different source");
    await f.sources.setCredential(github.id, TOKEN, github.credentialVersion);
    await expect(f.sources.poll(github, source, result.cursor)).rejects.toThrow("old account");
  } finally { await f.close(); }
});

test("Gitea uses its configured API subpath, pagination and diff endpoint without GitHub-only sort", async () => {
  const api = prAPI();
  const f = await fixture({ fetch: api.fetcher });
  const connection: Connection = { ...github, config: { kind: "gitea", baseUrl: "http://tailnet-git/api/v1" } };
  try {
    await f.sources.test(connection);
    const result = await f.sources.poll(connection, prSource, null);
    expect(result.items).toHaveLength(1);
    expect(api.requests.some(request => request.url.pathname.endsWith(".diff"))).toBe(false);
    await f.sources.read(connection, result.items[0]!);
    expect(api.requests.every(request => request.url.origin === "http://tailnet-git" && request.url.pathname.startsWith("/api/v1/"))).toBe(true);
    expect(api.requests.find(request => request.url.pathname.endsWith("/pulls"))?.url.searchParams.get("sort")).toBe("leastupdate");
    expect(api.requests.some(request => request.url.pathname.endsWith("/pulls/1.diff"))).toBe(true);
  } finally { await f.close(); }
});

test("PR reads and real API comment writes bind provider, repository, account and immutable version", async () => {
  const api = prAPI();
  const f = await fixture({ fetch: api.fetcher });
  try {
    const item = (await f.sources.poll(github, prSource, null)).items[0]!;
    await expect(f.sources.act(github, { ...item, target: { ...item.target, repository: "victim/repo" } }, { kind: "pr_comment", body: "wrong" })).rejects.toThrow("invalid");
    await expect(f.sources.act(github, { ...item, version: "forged" }, { kind: "pr_comment", body: "wrong" })).rejects.toThrow("invalid");
    await expect(f.sources.act(github, item, { kind: "mail_reply", body: "wrong" })).rejects.toThrow("Only a pull request comment");
    api.records[0]!.head.sha = "new-head";
    await expect(f.sources.act(github, item, { kind: "pr_comment", body: "stale" })).rejects.toThrow("changed since this run");
    expect(api.writes).toHaveLength(0);
    const fresh = await f.sources.read(github, item);
    expect(fresh.version).not.toBe(item.version);
    await f.sources.act(github, fresh, { kind: "pr_comment", body: "approved comment" });
    expect(api.writes).toEqual([{ path: "/repos/garden/ghost/issues/1/comments", body: { body: "approved comment" } }]);
    await f.sources.setCredential(github.id, "replacement-token", github.credentialVersion);
    await expect(f.sources.act(github, fresh, { kind: "pr_comment", body: "revoked" })).rejects.toThrow("account/configuration changed");
    await expect(f.sources.read({ ...github, config: { kind: "github", baseUrl: "https://other-api.example.com" } }, fresh)).rejects.toThrow("account/configuration changed");
    expect(api.writes).toHaveLength(1);
  } finally { await f.close(); }
});

test("API errors and provider echoes cannot disclose tokens; response and diff output are bounded", async () => {
  const api = prAPI([{ ...pr(1), body: `echo ${TOKEN}`, title: TOKEN }]);
  let mode = "normal";
  const f = await fixture({ fetch: (async (input, init) => {
    if (mode === "error") return new Response(`provider secret ${TOKEN}`, { status: 401 });
    if (mode === "large") return new Response("x", { headers: { "content-length": String(3 * 1024 * 1024) } });
    if (mode === "stream") return new Response("x".repeat(2 * 1024 * 1024 + 1));
    if (new Headers(init?.headers).get("accept")?.includes("diff")) return new Response("d".repeat(20000));
    return api.fetcher(input, init);
  }) as ActivitySourceFetch });
  try {
    const item = (await f.sources.poll(github, prSource, null)).items[0]!;
    expect(JSON.stringify(item)).not.toContain(TOKEN);
    expect(item.text).toContain("[redacted]");
    expect(item.text).not.toContain("Diff:");
    const enriched = await f.sources.read(github, item);
    expect(enriched.text).toContain("[diff truncated]");
    expect(enriched.text.length).toBeLessThanOrEqual(32768);
    mode = "error";
    await expect(f.sources.test(github)).rejects.toThrow("authentication or permission denied");
    mode = "large";
    await expect(f.sources.test(github)).rejects.toThrow("2 MiB");
    mode = "stream";
    await expect(f.sources.test(github)).rejects.toThrow("2 MiB");
  } finally { await f.close(); }
});

test("credential-forwarding redirects are never followed, including owner-configured HTTP Gitea", async () => {
  let forwarded = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { forwarded++; return Response.json({ id: 1 }); } });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response(null, { status: 302, headers: { location: `${destination.url}user` } }); } });
  const f = await fixture();
  try {
    await expect(f.sources.test({ ...github, config: { kind: "gitea", baseUrl: String(origin.url) } })).rejects.toThrow();
    expect(forwarded).toBe(0);
  } finally { await f.close(); await origin.stop(true); await destination.stop(true); }
});

test("mail polling is TLS/read-only/UID-based and retains the rest of batches over 20", async () => {
  const box = new MailboxFixture(27);
  const smtp = smtpFixture();
  const f = await fixture({ imap: box.factory, smtp: smtp.factory });
  try {
    const first = await f.sources.poll(mail, mailSource, null);
    expect(first.items).toHaveLength(20);
    expect(JSON.parse(first.cursor!).uid).toBe(20);
    const second = await f.sources.poll(mail, mailSource, first.cursor);
    expect(second.items.map(item => item.target.uid)).toEqual(["21", "22", "23", "24", "25", "26", "27"]);
    expect((await f.sources.poll(mail, mailSource, second.cursor)).items).toEqual([]);
    expect(box.settings.every(options => options.secure && options.tls?.rejectUnauthorized && options.logger === false)).toBe(true);
    expect(box.opened.every(options => JSON.stringify(options) === JSON.stringify({ readOnly: true }))).toBe(true);
    expect(box.fetches.every(fetch => fetch.query.size && JSON.stringify(fetch.options) === JSON.stringify({ uid: true }))).toBe(true);
    expect(box.fetches.filter(fetch => fetch.query.source)).toHaveLength(27);
    expect(box.seen.size).toBe(0);
    expect(smtp.sent).toHaveLength(0);
  } finally { await f.close(); }
});

test("mail baselines use UIDNEXT across the complete mailbox; UIDVALIDITY is never reused", async () => {
  const box = new MailboxFixture(1300);
  const f = await fixture({ imap: box.factory });
  try {
    const source = { ...mailSource, includeExisting: false };
    const baseline = await f.sources.poll(mail, source, null);
    expect(baseline.items).toEqual([]);
    expect(JSON.parse(baseline.cursor!).uid).toBe(1300);
    expect(box.searches).toHaveLength(0);
    expect(box.fetches).toHaveLength(0);
    box.messages.set(1301, rawMail(1301));
    const next = await f.sources.poll(mail, source, baseline.cursor);
    expect(next.items.map(item => item.target.uid)).toEqual(["1301"]);
    box.validity = 2n;
    await expect(f.sources.read(mail, next.items[0]!)).rejects.toThrow("UIDVALIDITY changed");
    const reset = await f.sources.poll(mail, source, next.cursor);
    expect(reset.items).toEqual([]);
    expect(JSON.parse(reset.cursor!).validity).toBe("2");
  } finally { await f.close(); }
});

test("mail filters do not consume undelivered matches and empty UID windows make bounded progress", async () => {
  const box = new MailboxFixture(30);
  box.seen.add(1);
  box.messages.set(2, Buffer.from(rawMail(2).toString().replace("sender@example.com", "another@example.com")));
  const f = await fixture({ imap: box.factory });
  try {
    const result = await f.sources.poll(mail, { ...mailSource, sender: "sender@example.com", subjectContains: "Task", unreadOnly: true }, null);
    expect(result.items).toHaveLength(20);
    expect(result.items[0]!.target.uid).toBe("3");
    expect(JSON.parse(result.cursor!).uid).toBe(22);
    expect(box.searches[0]).toMatchObject({ from: "sender@example.com", subject: "Task", seen: false });
    box.messages.clear();
    box.messages.set(10000, rawMail(10000));
    const sparse = await f.sources.poll(mail, mailSource, null);
    expect(sparse.items).toEqual([]);
    expect(JSON.parse(sparse.cursor!).uid).toBe(5000);
    const eventual = await f.sources.poll(mail, mailSource, sparse.cursor);
    expect(eventual.items[0]!.target.uid).toBe("10000");
  } finally { await f.close(); }
});

test("mail test verifies TLS SMTP without sends; replies derive the sole recipient from fresh source", async () => {
  const box = new MailboxFixture();
  const smtp = smtpFixture();
  const f = await fixture({ imap: box.factory, smtp: smtp.factory });
  try {
    expect((await f.sources.test(mail)).summary).toContain("No message was sent");
    expect(smtp.verified()).toBe(1);
    expect(smtp.sent).toHaveLength(0);
    const item = (await f.sources.poll(mail, mailSource, null)).items[0]!;
    await expect(f.sources.act(mail, { ...item, target: { ...item.target, uid: "2" } }, { kind: "mail_reply", body: "forged" })).rejects.toThrow("invalid");
    await expect(f.sources.act(mail, item, { kind: "pr_comment", body: "wrong action" })).rejects.toThrow("Only a mail reply");
    await f.sources.act(mail, item, { kind: "mail_reply", body: "Approved plain-text reply" });
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ envelope: { from: "owner@example.com", to: ["replies@example.com"] }, to: [{ address: "replies@example.com", name: "" }], text: "Approved plain-text reply", inReplyTo: "<source-1@example.com>", references: "<source-1@example.com>", disableFileAccess: true, disableUrlAccess: true });
    expect(smtp.settings.every(options => options.requireTLS && options.opportunisticTLS === false && options.tls?.rejectUnauthorized)).toBe(true);
    box.messages.set(1, rawMail(1, "X-Source-Changed: yes\r\n"));
    await expect(f.sources.act(mail, item, { kind: "mail_reply", body: "stale" })).rejects.toThrow("Source email changed");
    expect(smtp.sent).toHaveLength(1);
    const fresh = await f.sources.read(mail, item);
    await f.sources.setCredential(mail.id, "replacement-password", mail.credentialVersion);
    await expect(f.sources.act(mail, fresh, { kind: "mail_reply", body: "revoked" })).rejects.toThrow("account/configuration changed");
  } finally { await f.close(); }
});

test("SMTP is explicitly optional, ambiguous reply headers and oversized mail cannot become writes", async () => {
  const box = new MailboxFixture();
  const smtp = smtpFixture();
  const f = await fixture({ imap: box.factory, smtp: smtp.factory });
  try {
    const noSmtp: Connection = { ...mail, config: { ...mail.config, kind: "mail", smtpHost: null } as Extract<Connection["config"], { kind: "mail" }> };
    expect((await f.sources.test(noSmtp)).summary).toContain("replies are unavailable");
    const item = (await f.sources.poll(noSmtp, mailSource, null)).items[0]!;
    await expect(f.sources.act(noSmtp, item, { kind: "mail_reply", body: "cannot send" })).rejects.toThrow("configure SMTP");
    box.messages.set(1, Buffer.from(rawMail(1).toString().replace("Reply-To: replies@example.com", "Reply-To: first@example.com, second@example.com")));
    const ambiguous = (await f.sources.poll(mail, mailSource, null)).items[0]!;
    await expect(f.sources.act(mail, ambiguous, { kind: "mail_reply", body: "cannot choose" })).rejects.toThrow("unambiguous");
    box.messages.set(1, Buffer.alloc(2 * 1024 * 1024 + 1));
    const excluded = await f.sources.poll(mail, mailSource, null);
    expect(excluded.items).toEqual([]);
    expect(excluded.exclusions).toMatchObject([{ id: expect.stringContaining(":1:1"), reason: expect.stringContaining("2 MiB") }]);
    expect(smtp.sent).toHaveLength(0);
  } finally { await f.close(); }
});

test("real SMTP client refuses AUTH when STARTTLS is not available", async () => {
  const sockets = new Set<Socket>();
  const received: string[] = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.write("220 local SMTP fixture\r\n");
    socket.on("data", chunk => {
      const text = chunk.toString(); received.push(text);
      if (/EHLO/i.test(text)) socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (/STARTTLS/i.test(text)) socket.write("454 TLS unavailable\r\n");
      else socket.write("500 Unexpected command\r\n");
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server address unavailable");
  const box = new MailboxFixture();
  const f = await fixture({ imap: box.factory });
  try {
    const connection: Connection = { ...mail, config: { ...mail.config, kind: "mail", smtpHost: "127.0.0.1", smtpPort: address.port, smtpSecure: false } as Extract<Connection["config"], { kind: "mail" }> };
    await expect(f.sources.test(connection)).rejects.toThrow();
    expect(received.join("")).not.toContain(TOKEN);
    expect(received.join("")).not.toMatch(/AUTH (?:PLAIN|LOGIN) /);
    expect(received.join("")).toContain("STARTTLS");
  } finally { await f.close(); for (const socket of sockets) socket.destroy(); server.close(); }
});

test("source close aborts and drains pending API IO and refuses new calls", async () => {
  const started = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  let aborted = false;
  const f = await fixture({ fetch: (async (_input, init) => {
    const stopped = Promise.withResolvers<never>();
    const abort = () => { aborted = true; drained.resolve(); stopped.reject(new Error("aborted")); };
    if (init!.signal!.aborted) abort();
    else init!.signal!.addEventListener("abort", abort, { once: true });
    started.resolve();
    return stopped.promise;
  }) as ActivitySourceFetch });
  try {
    const pending = f.sources.test(github);
    const outcome = pending.catch(error => error);
    await started.promise;
    await f.sources.close();
    await drained.promise;
    expect(await outcome).toBeInstanceOf(Error);
    expect(aborted).toBe(true);
    await expect(f.sources.poll(github, prSource, null)).rejects.toThrow("closed");
  } finally { await f.close(); }
});

test("credential replacement while a version read is pending cannot post with revoked authority", async () => {
  const api = prAPI();
  let block = false;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await fixture({ fetch: (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (block && url.pathname.endsWith("/pulls/1")) { started.resolve(); await release.promise; }
    return api.fetcher(input, init);
  }) as ActivitySourceFetch });
  try {
    const item = (await f.sources.poll(github, prSource, null)).items[0]!;
    block = true;
    const sending = f.sources.act(github, item, { kind: "pr_comment", body: "must not post" });
    const outcome = sending.catch(error => error);
    await started.promise;
    await f.sources.setCredential(github.id, "replacement-token", github.credentialVersion);
    release.resolve();
    expect((await outcome).message).toContain("credential changed");
    expect(api.writes).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
});

test("credential versions and live ledger metadata fail closed across interrupted replacement and deletion", async () => {
  const api = prAPI();
  let current: Connection | null = { ...github };
  const f = await fixture({ fetch: api.fetcher, currentConnection: id => id === github.id ? current : null });
  try {
    const item = (await f.sources.poll(github, prSource, null)).items[0]!;
    const before = api.requests.length;
    current = { ...github, hasCredential: false, credentialVersion: "account-v2" };
    expect(f.sources.credentialPresent(github.id)).toBe(false);
    await expect(f.sources.test(github)).rejects.toThrow("revoked");
    await f.sources.setCredential(github.id, "new-account-token", "account-v2");
    await expect(f.sources.test(github)).rejects.toThrow("revoked");
    expect(api.requests).toHaveLength(before);
    current = { ...current, hasCredential: true };
    expect(f.sources.credentialPresent(github.id)).toBe(true);
    await expect(f.sources.test(github)).rejects.toThrow("changed");
    await f.sources.test(current);
    expect(new Headers(api.requests.at(-1)!.init?.headers).get("authorization")).toBe("Bearer new-account-token");
    await expect(f.sources.read(current, item)).rejects.toThrow("invalid");
    current = null;
    expect(f.sources.credentialPresent(github.id)).toBe(false);
    await expect(f.sources.act(github, item, { kind: "pr_comment", body: "deleted" })).rejects.toThrow("revoked");
    expect(api.writes).toHaveLength(0);
  } finally { await f.close(); }
});

test("metadata revocation after the asynchronous PR version check forbids the final comment request", async () => {
  const api = prAPI();
  let current: Connection = { ...github };
  let revoke = false;
  const f = await fixture({
    currentConnection: id => id === github.id ? current : null,
    fetch: (async (input, init) => {
      const result = await api.fetcher(input, init);
      if (revoke && String(input).endsWith("/pulls/1")) current = { ...current, hasCredential: false, credentialVersion: "account-v2" };
      return result;
    }) as ActivitySourceFetch,
  });
  try {
    const item = (await f.sources.poll(github, prSource, null)).items[0]!;
    revoke = true;
    await expect(f.sources.act(github, item, { kind: "pr_comment", body: "revoked" })).rejects.toThrow("revoked");
    expect(api.writes).toHaveLength(0);
  } finally { await f.close(); }
});

test("SMTP must reauthorize after asynchronous account authentication and before message delivery", async () => {
  const box = new MailboxFixture();
  let current: Connection = { ...mail };
  let attemptedDelivery = false;
  const f = await fixture({
    imap: box.factory,
    currentConnection: id => id === mail.id ? current : null,
    smtp: () => ({
      async verify() {},
      async sendMail(_message, authorize) {
        await Promise.resolve();
        current = { ...current, hasCredential: false, credentialVersion: "account-v2" };
        authorize();
        attemptedDelivery = true;
        return { accepted: ["replies@example.com"], rejected: [] };
      },
      close() {},
    }),
  });
  try {
    const item = (await f.sources.poll(mail, mailSource, null)).items[0]!;
    await expect(f.sources.act(mail, item, { kind: "mail_reply", body: "revoked during SMTP authentication" })).rejects.toThrow("revoked");
    expect(attemptedDelivery).toBe(false);
  } finally { await f.close(); }
});

test("source snapshots expose epoch-millisecond times and the sealed actual Reply-To mailbox", async () => {
  const box = new MailboxFixture();
  const api = prAPI();
  const f = await fixture({ imap: box.factory, fetch: api.fetcher });
  try {
    const prItem = (await f.sources.poll(github, prSource, null)).items[0]!;
    const mailItem = (await f.sources.poll(mail, mailSource, null)).items[0]!;
    expect(prItem.occurredAt).toBe(Date.parse(instant));
    expect(mailItem.occurredAt).toBe(Date.parse(instant));
    expect(mailItem.author).toBe("sender@example.com");
    expect(mailItem.target.replyTo).toBe("replies@example.com");
    await expect(f.sources.act(mail, { ...mailItem, target: { ...mailItem.target, replyTo: "victim@example.com" } }, { kind: "mail_reply", body: "forged recipient" })).rejects.toBeInstanceOf(NoEffect);
    box.messages.set(1, Buffer.from(rawMail(1).toString().replace("Reply-To: replies@example.com", "Reply-To: first@example.com, second@example.com")));
    expect((await f.sources.poll(mail, mailSource, null)).items[0]!.target.replyTo).toBe("");
  } finally { await f.close(); }
});

test("own PR comments advance detection time without changing the stable source version", async () => {
  const api = prAPI();
  const f = await fixture({ fetch: (async (input, init) => {
    const response = await api.fetcher(input, init);
    if (init?.method === "POST") api.records[0]!.updated_at = "2026-11-08T10:01:00.000Z";
    return response;
  }) as ActivitySourceFetch });
  try {
    const first = await f.sources.poll(github, prSource, null);
    const item = first.items[0]!;
    await f.sources.act(github, item, { kind: "pr_comment", body: "Approved comment" });
    const observed = await f.sources.poll(github, prSource, first.cursor);
    expect(observed.items[0]!.version).toBe(item.version);
    expect(observed.items[0]!.id).toBe(item.id);
    expect(observed.cursor).not.toBe(first.cursor);
    expect((await f.sources.read(github, item)).version).toBe(item.version);
    expect((await f.sources.poll(github, prSource, observed.cursor)).items).toEqual([]);
    api.records[0]!.head.sha = "meaningful-new-head";
    expect((await f.sources.poll(github, prSource, observed.cursor)).items[0]!.version).not.toBe(item.version);
  } finally { await f.close(); }
});

test("action preflight and read failures are NoEffect, but a started API write remains uncertain", async () => {
  const api = prAPI();
  let mode = "normal";
  const f = await fixture({ fetch: (async (input, init) => {
    if (mode === "read-failure" || (mode === "post-failure" && init?.method === "POST")) throw new Error(`untrusted provider echo ${TOKEN}`);
    return api.fetcher(input, init);
  }) as ActivitySourceFetch });
  try {
    const item = (await f.sources.poll(github, prSource, null)).items[0]!;
    api.records[0]!.head.sha = "stale-head";
    await expect(f.sources.act(github, item, { kind: "pr_comment", body: "stale" })).rejects.toBeInstanceOf(NoEffect);
    api.records[0]!.head.sha = "head-1";
    mode = "read-failure";
    await expect(f.sources.act(github, item, { kind: "pr_comment", body: "read failed" })).rejects.toBeInstanceOf(NoEffect);
    mode = "post-failure";
    const error = await f.sources.act(github, item, { kind: "pr_comment", body: "uncertain" }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoEffect);
    expect(error.message).not.toContain(TOKEN);
  } finally { await f.close(); }
});

test("SMTP failure before DATA is NoEffect; failure after DATA begins stays uncertain", async () => {
  const box = new MailboxFixture();
  let startData = false;
  const f = await fixture({ imap: box.factory, smtp: () => ({
    async verify() {},
    async sendMail(_message, authorize, writeStarted) {
      authorize();
      if (startData) writeStarted();
      throw new Error(`provider echo ${TOKEN}`);
    },
    close() {},
  }) });
  try {
    const item = (await f.sources.poll(mail, mailSource, null)).items[0]!;
    await expect(f.sources.act(mail, item, { kind: "mail_reply", body: "before DATA" })).rejects.toBeInstanceOf(NoEffect);
    startData = true;
    const error = await f.sources.act(mail, item, { kind: "mail_reply", body: "after DATA" }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NoEffect);
    expect(error.message).not.toContain(TOKEN);
  } finally { await f.close(); }
});
