import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { ActivityAction, ActivitySource, ActivitySourceItem, Connection, ConnectionConfig } from "@ghost/contract";
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from "imapflow";
import PostalMime, { type Email } from "postal-mime";
import { activitySmtp, type ActivitySmtpClient, type ActivitySmtpOptions } from "./activity-mail.ts";
import { NoEffect } from "../core/effects.ts";

export interface ActivitySourceExclusion {
  id: string;
  title: string | null;
  reason: string;
}
export interface ActivitySourcePoll {
  items: ActivitySourceItem[];
  exclusions: ActivitySourceExclusion[];
  cursor: string | null;
}

export interface ActivitySourcePort {
  credentialPresent(id: string): boolean;
  setCredential(id: string, value: string | null, version: string | null): Promise<void>;
  test(connection: Connection): Promise<{ summary: string }>;
  poll(connection: Connection, source: Exclude<ActivitySource, { kind: "schedule" }>, cursor: string | null, options?: { baseline?: boolean }): Promise<ActivitySourcePoll>;
  read(connection: Connection, item: ActivitySourceItem): Promise<ActivitySourceItem>;
  act(connection: Connection, item: ActivitySourceItem, action: ActivityAction): Promise<{ summary: string }>;
  close(): Promise<void>;
}

type MailConfig = Extract<Connection["config"], { kind: "mail" }>;
type Source = Exclude<ActivitySource, { kind: "schedule" }>;
type PRSource = Extract<Source, { kind: "pull_request" }>;
type MailSource = Extract<Source, { kind: "mail" }>;
type ImapClient = Pick<ImapFlow, "connect" | "mailboxOpen" | "search" | "fetchOne" | "close" | "on">;
export type ActivitySourceFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
interface Options {
  root: string;
  currentConnection?: (id: string) => Connection | null;
  /** Explicit dependency injection for isolated protocol/API tests; TLS policy is not relaxed. */
  fetch?: ActivitySourceFetch;
  imap?: (options: ImapFlowOptions) => ImapClient;
  smtp?: (options: ActivitySmtpOptions) => ActivitySmtpClient;
}
interface Secret { credential: string; key: string; version: string }
interface PRCursor { kind: "pr"; scope: string; at: string; seen: Record<string, string> }
interface MailCursor { kind: "mail"; scope: string; validity: string; uid: number }
type JsonObject = Record<string, unknown>;
const LIMIT = 20;
const MAX_API = 2 * 1024 * 1024;
const MAX_MAIL = 2 * 1024 * 1024;
const TIMEOUT = 60_000;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const str = (value: unknown) => typeof value === "string" ? value : "";
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 24)}\n[content truncated]` : value;
function fail(message: string): never { throw new SourceError(message); }
const clean = (value: string, max: number, secret: Secret) => clip(value.split(secret.credential).join("[redacted]"), max);
class SourceError extends Error {}
class OversizedMail extends SourceError {}
function timestamp(value: unknown): string {
  const text = str(value);
  if (!text || !Number.isFinite(Date.parse(text))) return fail("Provider returned an invalid update timestamp.");
  return new Date(text).toISOString();
}
function safeUrl(value: unknown): string | null {
  try {
    const url = new URL(str(value));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
function apiRoot(config: ConnectionConfig): URL {
  if (config.kind === "mail") return fail("This connection is not a pull request account.");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return fail("Set a valid absolute API URL (GitHub: https://api.github.com; Gitea: https://your-server/api/v1)."); }
  if (url.username || url.password || url.search || url.hash || !["https:", ...(config.kind === "gitea" ? ["http:"] : [])].includes(url.protocol)) {
    return fail("API URL must not contain credentials, query parameters or fragments; GitHub requires HTTPS.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}
function validateMail(config: MailConfig): void {
  const host = (value: string) => value.length <= 253 && (isIP(value) !== 0 || /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/.test(value));
  const port = (value: number) => integer(value) && value <= 65535;
  if (!host(config.host) || !port(config.port) || !config.username || /[\r\n\0]/.test(config.username) || !config.mailbox || /[\r\n\0]/.test(config.mailbox)) {
    fail("Set a valid IMAP TLS hostname, port, username and mailbox (usually port 993 and INBOX).");
  }
  if (config.smtpHost !== null && (!host(config.smtpHost) || !port(config.smtpPort))) fail("Set a valid SMTP hostname and port (465 TLS or 587 STARTTLS).");
}
/** Synchronous owner setup validation; never authenticates or writes credentials. */
export function validateConnectionConfig(config: ConnectionConfig): void {
  if (config.kind === "mail") validateMail(config);
  else apiRoot(config);
}

function prVersion(pr: JsonObject): string {
  const head = object(pr.head) ? pr.head : {};
  const base = object(pr.base) ? pr.base : {};
  const labels = Array.isArray(pr.labels) ? pr.labels.map(label => object(label) ? str(label.name) : str(label)).sort() : [];
  return hash(JSON.stringify([str(head.sha), str(base.sha), str(pr.title), str(pr.body), str(pr.state), Boolean(pr.draft), labels]));
}
function repositoryPath(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some(part => part === "." || part === "..")) fail("Set a repository as owner/name.");
  return repository.split("/").map(encodeURIComponent).join("/");
}
function mailboxAddress(value: string | undefined): string | null {
  return value && value.length <= 320 && /^[^\s<>@,;:\r\n]+@[^\s<>@,;:\r\n]+$/.test(value) ? value : null;
}
function replyRecipient(email: Email): string {
  const addresses = email.replyTo?.length ? email.replyTo : email.from ? [email.from] : [];
  if (addresses.length !== 1 || !addresses[0] || !("address" in addresses[0])) return fail("The source message must have one unambiguous From or Reply-To mailbox to reply.");
  return mailboxAddress(addresses[0].address) ?? fail("The source message has no safe reply mailbox.");
}
function messageId(value: string | undefined): string | undefined {
  return value && value.length <= 998 && /^<[^<>\s\r\n]+@[^<>\s\r\n]+>$/.test(value) ? value : undefined;
}

/** Account secrets and transport authority stay here, never in source snapshots or prompts. */
export class SourceConnections implements ActivitySourcePort {
  private readonly dir: string;
  private readonly options: Options;
  private readonly active = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: Options) {
    this.options = options;
    this.dir = join(options.root, "secrets", "connections");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(join(options.root, "secrets"), 0o700);
    chmodSync(this.dir, 0o700);
  }
  private file(id: string): string { return join(this.dir, `${hash(id)}.json`); }
  private secret(id: string): Secret | null {
    try {
      const value: unknown = JSON.parse(readFileSync(this.file(id), "utf8"));
      return object(value) && typeof value.credential === "string" && value.credential.length > 0 && typeof value.key === "string" && /^[a-f0-9]{64}$/.test(value.key) && typeof value.version === "string" && value.version.length > 0
        ? { credential: value.credential, key: value.key, version: value.version } : null;
    } catch { return null; }
  }
  credentialPresent(id: string): boolean {
    const secret = this.secret(id);
    if (!secret) return false;
    if (!this.options.currentConnection) return true;
    const current = this.options.currentConnection(id);
    return Boolean(current?.hasCredential && current.credentialVersion === secret.version);
  }
  async setCredential(id: string, value: string | null, version: string | null): Promise<void> {
    if (this.closed) fail("Source connections are closed.");
    const file = this.file(id);
    if (value === null) { if (existsSync(file)) unlinkSync(file); return; }
    if (!value || value.length > 16384 || /[\r\n\0]/.test(value)) fail("Enter a non-empty token or app password without line breaks (maximum 16384 characters).");
    if (!version || version.length > 128 || /[\r\n\0]/.test(version)) fail("Credential replacement requires a fresh non-empty account version.");
    const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ credential: value, key: randomBytes(32).toString("hex"), version }), { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private authorized(connection: Connection, expected?: Secret): Secret {
    const current = this.options.currentConnection ? this.options.currentConnection(connection.id) : connection;
    if (!current?.hasCredential || !connection.hasCredential || !connection.credentialVersion || current.credentialVersion !== connection.credentialVersion || JSON.stringify(current.config) !== JSON.stringify(connection.config)) {
      fail("Connection account/configuration changed or was revoked; obtain a fresh source item after reconnecting.");
    }
    const secret = this.secret(connection.id) ?? fail("Add this account's token or app password in connection settings before testing or polling.");
    if (secret.version !== connection.credentialVersion || (expected && secret.key !== expected.key)) fail("Connection credential changed or its update is incomplete; reconnect before polling or writing.");
    return secret;
  }
  private scope(connection: Connection, secret: Secret): string {
    return createHmac("sha256", secret.key).update(JSON.stringify([connection.id, connection.credentialVersion, connection.config])).digest("hex");
  }
  private seal(target: Record<string, string>, version: string, secret: Secret): string {
    return createHmac("sha256", secret.key).update(JSON.stringify([Object.entries(target).filter(([key]) => key !== "seal").sort(([a], [b]) => a.localeCompare(b)), version])).digest("hex");
  }
  private target(connection: Connection, secret: Secret, version: string, fields: Record<string, string>): Record<string, string> {
    const target = { ...fields, connectionId: connection.id, scope: this.scope(connection, secret) };
    return { ...target, seal: this.seal(target, version, secret) };
  }
  private bound(connection: Connection, secret: Secret, item: ActivitySourceItem): void {
    const target = item.target;
    const expected = this.seal(target, item.version, secret);
    if (target.connectionId !== connection.id || target.scope !== this.scope(connection, secret) || !/^[a-f0-9]{64}$/.test(target.seal ?? "") || !timingSafeEqual(Buffer.from(expected), Buffer.from(target.seal!))) {
      fail("Source target is invalid or its account/configuration changed; obtain a fresh source item.");
    }
    if (target.kind === "pr" && connection.config.kind !== "mail") {
      repositoryPath(target.repository ?? "");
      if (!/^[1-9][0-9]{0,9}$/.test(target.number ?? "") || item.id !== `pr:${connection.id}:${target.repository}:${target.number}`) fail("Pull request target does not match this source item.");
    } else if (target.kind === "mail" && connection.config.kind === "mail") {
      if (target.mailbox !== connection.config.mailbox || !/^[1-9][0-9]{0,19}$/.test(target.validity ?? "") || !/^[1-9][0-9]{0,9}$/.test(target.uid ?? "") || item.id !== `mail:${connection.id}:${hash(target.mailbox).slice(0, 16)}:${target.validity}:${target.uid}`) fail("Mail target does not match this source item.");
    } else fail("Source provider does not match this connection.");
  }
  private async operation<T>(connection: Connection, run: (secret: Secret, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) fail("Source connections are closed.");
    const secret = this.authorized(connection);
    validateConnectionConfig(connection.config);
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    const stopped = Promise.withResolvers<never>();
    const abort = () => stopped.reject(new SourceError("Source operation timed out or was closed; check the account endpoint. A write may have completed; do not blindly retry it."));
    controller.signal.addEventListener("abort", abort, { once: true });
    const running = run(secret, controller.signal);
    this.pending.add(running);
    void running.finally(() => { this.pending.delete(running); }).catch(() => {});
    try {
      const result = await Promise.race([running, stopped.promise]);
      if (this.closed || controller.signal.aborted) fail("Source operation was closed before its result could be used.");
      this.authorized(connection, secret);
      return result;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      const code = object(error) ? str(error.code) : "";
      if (/AUTH|EAUTH|LOGIN|Authentication/i.test(code)) fail("Account authentication failed. Check the username and token/app password and enable IMAP/SMTP access for this account.");
      if (/CERT|TLS|SSL|SELF_SIGNED|ALTNAME/i.test(code)) fail("TLS verification failed. Use the server's certificate hostname and a trusted, unexpired certificate; insecure authentication is not supported.");
      fail("Source connection failed. Check the endpoint, network, account permissions and app password. No provider error body is exposed.");
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }
  private async api(connection: Connection, secret: Secret, path: string, signal: AbortSignal, options: { body?: string; textLimit?: number; beforeWrite?: () => void } = {}): Promise<unknown> {
    if (signal.aborted) fail("Source operation was closed before the API request.");
    this.authorized(connection, secret);
    const root = apiRoot(connection.config);
    const url = new URL(path, root);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) fail("API request escaped its configured origin.");
    const request: RequestInit = {
      method: options.body === undefined ? "GET" : "POST", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { Authorization: `${connection.config.kind === "gitea" ? "token" : "Bearer"} ${secret.credential}`, Accept: options.textLimit === undefined ? "application/json" : "application/vnd.github.diff", "User-Agent": "Ghost-Activity-Source", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: options.body }),
    };
    if (options.body !== undefined) options.beforeWrite?.();
    const response = await (this.options.fetch ?? fetch)(url, request);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) fail("API authentication or permission denied. Check token access to this repository (read pull requests; write issues for approved comments), SSO authorization and rate limits.");
      if (response.status === 404) fail("Repository or pull request not found. Check owner/name, API base URL and private-repository token access.");
      fail(`Source API returned HTTP ${response.status}; no provider error body is exposed.`);
    }
    if (!response.body) return options.textLimit === undefined ? null : "";
    const max = options.textLimit ?? MAX_API;
    if (options.textLimit === undefined && Number(response.headers.get("content-length")) > max) { await response.body.cancel(); fail("Source API response exceeds the 2 MiB safety limit; narrow the repository/source."); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > max) {
          if (options.textLimit === undefined) fail("Source API response exceeds the 2 MiB safety limit; narrow the repository/source.");
          chunks.push(value.subarray(0, max - size)); size = max; truncated = true; break;
        }
        chunks.push(value); size += value.byteLength;
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const text = Buffer.concat(chunks, size).toString("utf8");
    return options.textLimit === undefined ? JSON.parse(text) as unknown : `${text}${truncated ? "\n[diff truncated]" : ""}`;
  }
  private async mail<T>(connection: Connection, secret: Secret, signal: AbortSignal, run: (client: ImapClient, mailbox: MailboxObject) => Promise<T>): Promise<T> {
    this.authorized(connection, secret);
    const config = connection.config as MailConfig;
    const options: ImapFlowOptions = {
      host: config.host, port: config.port, secure: true, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: { user: config.username, pass: secret.credential }, logger: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000,
      maxLiteralSize: MAX_MAIL + 65536, maxResponseSize: MAX_MAIL + 131072, maxLineLength: 65536, maxResponseTokens: 20000,
    };
    const client = this.options.imap?.(options) ?? new ImapFlow(options);
    // ImapFlow emits errors as well as rejecting active commands; never print credential-bearing errors.
    client.on("error", () => {});
    const abort = () => client.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) fail("Source operation was closed.");
      await client.connect();
      this.authorized(connection, secret);
      const mailbox = await client.mailboxOpen(config.mailbox, { readOnly: true });
      if (!mailbox.uidValidity || !integer(mailbox.uidNext)) fail("IMAP server did not supply valid UIDVALIDITY and UIDNEXT metadata.");
      return await run(client, mailbox);
    } finally { signal.removeEventListener("abort", abort); client.close(); }
  }
  private smtp(config: MailConfig, secret: Secret): ActivitySmtpClient {
    if (!config.smtpHost) fail("Replies are unavailable: configure SMTP host, port and TLS/STARTTLS in this connection first.");
    const options: ActivitySmtpOptions = {
      host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure, requireTLS: true, opportunisticTLS: false,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" }, auth: { user: config.username, pass: secret.credential },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000, dnsTimeout: 15_000,
      logger: false, debug: false, transactionLog: false, maxResponseSize: 65536,
    };
    return this.options.smtp?.(options) ?? activitySmtp(options);
  }
  async test(connection: Connection): Promise<{ summary: string }> {
    return this.operation(connection, async (secret, signal) => {
      if (connection.config.kind !== "mail") {
        const account = await this.api(connection, secret, "user", signal);
        if (!object(account) || (!integer(account.id) && !str(account.login))) fail("API URL did not return a valid authenticated user. Use the API endpoint, not the website URL.");
        return { summary: "API authentication succeeded. Repository permissions are checked when polling." };
      }
      const config = connection.config;
      await this.mail(connection, secret, signal, async () => {});
      if (!config.smtpHost) return { summary: "IMAP TLS authentication and read-only mailbox access succeeded. SMTP is not configured; replies are unavailable." };
      const transport = this.smtp(config, secret);
      const abort = () => transport.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) fail("Source operation was closed before SMTP authentication.");
        this.authorized(connection, secret);
        await transport.verify();
      } finally { signal.removeEventListener("abort", abort); transport.close(); }
      return { summary: "IMAP read-only mailbox access and SMTP TLS authentication succeeded. No message was sent." };
    });
  }
  async poll(connection: Connection, source: Source, cursor: string | null, options?: { baseline?: boolean }): Promise<ActivitySourcePoll> {
    return this.operation(connection, async (secret, signal) => {
      if (source.connectionId !== connection.id) fail("Activity source belongs to a different connection.");
      const baseline = options?.baseline ?? (cursor === null && !source.includeExisting);
      if (cursor && cursor.length > 262144) fail("Source cursor exceeds its safety limit; reset the activity source baseline.");
      const scope = hash(JSON.stringify([this.scope(connection, secret), source]));
      let parsed: unknown = null;
      if (cursor) { try { parsed = JSON.parse(cursor); } catch { fail("Source cursor is invalid; reset the activity source baseline."); } }
      if (parsed !== null && (!object(parsed) || parsed.scope !== scope)) fail("Source cursor belongs to an old account or different source; reset the activity source baseline.");
      if (source.kind === "pull_request") {
        if (connection.config.kind === "mail") fail("Pull request activities require a GitHub or Gitea connection.");
        return this.pollPR(connection, secret, source, parsed, scope, baseline, signal);
      }
      if (connection.config.kind !== "mail") fail("Mail activities require an IMAP connection.");
      return this.pollMail(connection, secret, source, parsed, scope, baseline, signal);
    });
  }
  private async pollPR(connection: Connection, secret: Secret, source: PRSource, parsed: unknown, scope: string, baseline: boolean, signal: AbortSignal): Promise<ActivitySourcePoll> {
    const repository = repositoryPath(source.repository);
    let cursor: PRCursor = { kind: "pr", scope, at: "1970-01-01T00:00:00.000Z", seen: {} };
    if (parsed !== null) {
      if (!object(parsed) || parsed.kind !== "pr" || typeof parsed.at !== "string" || !object(parsed.seen) || Object.values(parsed.seen).some(value => typeof value !== "string")) fail("Pull request cursor is invalid; reset the activity source baseline.");
      cursor = parsed as unknown as PRCursor;
      timestamp(cursor.at);
    }
    const records: JsonObject[] = [];
    // Complete the bounded scan or fail without advancing a partial baseline/cursor.
    for (let page = 1; ; page++) {
      if (page > 50) fail("Repository scan exceeds the 50-page safety limit; narrow the repository/source before enabling this activity.");
      const query = new URLSearchParams({ state: "all", sort: connection.config.kind === "gitea" ? "leastupdate" : "updated", direction: "asc", page: String(page), limit: "100", per_page: "100" });
      const list = await this.api(connection, secret, `repos/${repository}/pulls?${query}`, signal);
      if (!Array.isArray(list) || list.length > 100 || list.some(pr => !object(pr) || !integer(pr.number))) fail("Provider returned an invalid pull request page.");
      records.push(...list as JsonObject[]);
      if (list.length === 0) break;
    }
    records.sort((a, b) => timestamp(a.updated_at).localeCompare(timestamp(b.updated_at)) || Number(a.number) - Number(b.number));
    const items: ActivitySourceItem[] = [];
    for (const pr of records) {
      const at = timestamp(pr.updated_at);
      const number = String(pr.number);
      const version = prVersion(pr);
      if (at < cursor.at || (at === cursor.at && cursor.seen[number] === version)) continue;
      if (items.length === LIMIT) break;
      const base = object(pr.base) ? str(pr.base.ref) : "";
      const labels = Array.isArray(pr.labels) ? pr.labels.map(label => object(label) ? str(label.name) : str(label)) : [];
      const matches = (pr.state === "open" || pr.state === "closed") && (!source.baseBranch || source.baseBranch === base) && (source.includeDrafts || !pr.draft) && source.labels.every(label => labels.includes(label));
      if (!baseline && matches) items.push(this.prSnapshot(connection, secret, source.repository, number, pr));
      if (at > cursor.at) { cursor.at = at; cursor.seen = {}; }
      cursor.seen[number] = version;
    }
    const encoded = JSON.stringify(cursor);
    if (encoded.length > 262144) fail("Too many pull requests share one update timestamp; narrow this source.");
    return { items, exclusions: [], cursor: encoded };
  }
  private prSnapshot(connection: Connection, secret: Secret, repository: string, number: string, pr: JsonObject): ActivitySourceItem {
    const version = prVersion(pr);
    const author = object(pr.user) ? str(pr.user.login) : "";
    return {
      id: `pr:${connection.id}:${repository}:${number}`, version,
      title: clean(str(pr.title), 512, secret),
      text: clean(`Pull request #${number} (${str(pr.state)})\n${clip(str(pr.body), 7000)}\n\nCall activity_read for the current diff and comments before reviewing.`, 32768, secret),
      url: str(pr.html_url).includes(secret.credential) ? null : safeUrl(pr.html_url), author: author ? clean(author, 320, secret) : null, occurredAt: Date.parse(timestamp(pr.updated_at)),
      target: this.target(connection, secret, version, { kind: "pr", repository, number }),
    };
  }
  private async prItem(connection: Connection, secret: Secret, repository: string, number: string, signal: AbortSignal): Promise<ActivitySourceItem> {
    const path = `repos/${repositoryPath(repository)}`;
    const pr = await this.api(connection, secret, `${path}/pulls/${number}`, signal);
    if (!object(pr) || String(pr.number) !== number || !integer(pr.number)) fail("Provider returned a different pull request than requested.");
    const item = this.prSnapshot(connection, secret, repository, number, pr);
    const diffPath = connection.config.kind === "gitea" ? `${path}/pulls/${number}.diff` : `${path}/pulls/${number}`;
    const diff = str(await this.api(connection, secret, diffPath, signal, { textLimit: 16000 }));
    const comments = await this.api(connection, secret, `${path}/issues/${number}/comments?per_page=100&limit=100&page=1`, signal);
    if (!Array.isArray(comments) || comments.some(comment => !object(comment))) fail("Provider returned invalid pull request comments.");
    const commentText = clip(comments.map(comment => `${object(comment.user) ? str(comment.user.login) : ""}: ${str(comment.body)}`).join("\n\n"), 8000);
    return { ...item, text: clean(`Pull request #${number} (${str(pr.state)})\n${clip(str(pr.body), 7000)}\n\nDiff:\n${diff}\n\nComments (first 100${comments.length >= 100 ? "; further comments omitted" : ""}):\n${commentText}`, 32768, secret) };
  }
  private async mailItem(connection: Connection, secret: Secret, client: ImapClient, mailbox: MailboxObject, uid: number): Promise<{ item: ActivitySourceItem; email: Email }> {
    this.authorized(connection, secret);
    const metadata = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
    if (!metadata || metadata.uid !== uid) fail("The source email is no longer available in this mailbox.");
    if ((metadata.size ?? 0) > MAX_MAIL) throw new OversizedMail("Source email exceeds the 2 MiB safety limit (including attachments); use a mailbox rule to route oversized messages for manual review.");
    const message = await client.fetchOne(String(uid), { uid: true, size: true, source: { start: 0, maxLength: MAX_MAIL + 1 } }, { uid: true });
    if (!message || message.uid !== uid || !message.source) fail("The source email is no longer available in this mailbox.");
    if ((message.size ?? 0) > MAX_MAIL || message.source.byteLength > MAX_MAIL) throw new OversizedMail("Source email exceeds the 2 MiB safety limit (including attachments); use a mailbox rule to route oversized messages for manual review.");
    const email = await PostalMime.parse(message.source, { maxNestingDepth: 32, maxHeadersSize: 65536, maxPartCount: 256, maxRfc822NestingDepth: 0, maxForwardedAddresses: 128 });
    const version = hash(message.source);
    const config = connection.config as MailConfig;
    const validity = String(mailbox.uidValidity);
    const author = email.from && "address" in email.from ? mailboxAddress(email.from.address) : null;
    let replyTo = "";
    try { replyTo = replyRecipient(email); } catch { /* Malformed reply headers never prevent read-only triage. */ }
    if (replyTo.includes(secret.credential)) replyTo = "";
    const item: ActivitySourceItem = {
      id: `mail:${connection.id}:${hash(config.mailbox).slice(0, 16)}:${validity}:${uid}`, version,
      title: clean(email.subject ?? "(no subject)", 512, secret),
      text: clean(`${email.text ?? email.html ?? "(no text body)"}${email.attachments.length ? `\n\n[${email.attachments.length} attachment(s) omitted]` : ""}`, 32768, secret),
      url: null, author: author ? clean(author, 320, secret) : null, occurredAt: email.date && Number.isFinite(Date.parse(email.date)) ? Date.parse(email.date) : null,
      target: this.target(connection, secret, version, { kind: "mail", mailbox: config.mailbox, validity, uid: String(uid), replyTo }),
    };
    return { item, email };
  }
  private async pollMail(connection: Connection, secret: Secret, source: MailSource, parsed: unknown, scope: string, baseline: boolean, signal: AbortSignal): Promise<ActivitySourcePoll> {
    return this.mail(connection, secret, signal, async (client, mailbox) => {
      const validity = String(mailbox.uidValidity);
      let cursor: MailCursor = { kind: "mail", scope, validity, uid: 0 };
      if (parsed !== null) {
        if (!object(parsed) || parsed.kind !== "mail" || typeof parsed.validity !== "string" || typeof parsed.uid !== "number" || !Number.isSafeInteger(parsed.uid) || parsed.uid < 0) fail("Mail cursor is invalid; reset the activity source baseline.");
        cursor = parsed as unknown as MailCursor;
        if (cursor.validity !== validity) cursor = { kind: "mail", scope, validity, uid: source.includeExisting ? 0 : mailbox.uidNext - 1 };
      }
      if (baseline) { cursor.uid = mailbox.uidNext - 1; cursor.validity = validity; return { items: [], exclusions: [], cursor: JSON.stringify(cursor) }; }
      const items: ActivitySourceItem[] = [];
      const exclusions: ActivitySourceExclusion[] = [];
      const last = mailbox.uidNext - 1;
      for (let window = 0; window < 10 && cursor.uid < last && items.length + exclusions.length < LIMIT; window++) {
        const start = cursor.uid + 1;
        const end = Math.min(start + 499, last);
        this.authorized(connection, secret);
        const found = await client.search({ uid: `${start}:${end}`, ...(source.unreadOnly ? { seen: false } : {}), ...(source.sender ? { from: source.sender } : {}), ...(source.subjectContains ? { subject: source.subjectContains } : {}) }, { uid: true });
        if (!Array.isArray(found) || found.length > 500 || found.some(uid => !integer(uid) || uid < start || uid > end)) fail("IMAP returned an invalid UID search result.");
        const uids = [...new Set(found)].sort((a, b) => a - b);
        for (const uid of uids) {
          if (items.length + exclusions.length === LIMIT) break;
          let fetched: { item: ActivitySourceItem; email: Email };
          try { fetched = await this.mailItem(connection, secret, client, mailbox, uid); }
          catch (error) {
            if (!(error instanceof OversizedMail)) throw error;
            exclusions.push({ id: `mail:${connection.id}:${hash((connection.config as MailConfig).mailbox).slice(0, 16)}:${validity}:${uid}`, title: null, reason: `Mail UID ${uid}: ${error.message}` });
            cursor.uid = uid;
            continue;
          }
          const { item, email } = fetched;
          const author = email.from && "address" in email.from ? email.from.address?.toLowerCase() : null;
          const matchesSender = !source.sender || (source.sender.includes("@") ? author === source.sender.toLowerCase() : author?.includes(source.sender.toLowerCase()));
          if (matchesSender && (!source.subjectContains || (email.subject ?? "").toLowerCase().includes(source.subjectContains.toLowerCase()))) items.push(item);
          cursor.uid = uid;
        }
        if (items.length + exclusions.length < LIMIT || uids.at(-1) === cursor.uid) cursor.uid = end;
      }
      return { items, exclusions, cursor: JSON.stringify(cursor) };
    });
  }
  async read(connection: Connection, item: ActivitySourceItem): Promise<ActivitySourceItem> {
    return this.operation(connection, async (secret, signal) => {
      this.bound(connection, secret, item);
      if (item.target.kind === "pr") return this.prItem(connection, secret, item.target.repository!, item.target.number!, signal);
      return this.mail(connection, secret, signal, async (client, mailbox) => {
        if (String(mailbox.uidValidity) !== item.target.validity) fail("Mailbox UIDVALIDITY changed; this source email cannot be safely resolved. Poll again.");
        return (await this.mailItem(connection, secret, client, mailbox, Number(item.target.uid))).item;
      });
    });
  }
  async act(connection: Connection, item: ActivitySourceItem, action: ActivityAction): Promise<{ summary: string }> {
    let writeStarted = false;
    return this.operation(connection, async (secret, signal) => {
      this.bound(connection, secret, item);
      if (!action.body.trim() || action.body.length > 16384) fail("Action body must contain 1–16384 characters.");
      if (item.target.kind === "pr") {
        if (action.kind !== "pr_comment") fail("Only a pull request comment is allowed for this source.");
        const path = `repos/${repositoryPath(item.target.repository!)}`;
        const current = await this.api(connection, secret, `${path}/pulls/${item.target.number}`, signal);
        if (!object(current) || String(current.number) !== item.target.number || prVersion(current) !== item.version) fail("Pull request changed since this run. Read the current source and obtain fresh authorization before commenting.");
        this.authorized(connection, secret);
        await this.api(connection, secret, `${path}/issues/${item.target.number}/comments`, signal, { body: JSON.stringify({ body: action.body }), beforeWrite: () => { writeStarted = true; } });
        return { summary: "Comment posted to the bound pull request." };
      }
      if (action.kind !== "mail_reply") fail("Only a mail reply is allowed for this source.");
      const config = connection.config as MailConfig;
      if (!config.smtpHost) fail("Replies are unavailable: configure SMTP for this connection first.");
      const fresh = await this.mail(connection, secret, signal, async (client, mailbox) => {
        if (String(mailbox.uidValidity) !== item.target.validity) fail("Mailbox UIDVALIDITY changed; reply authority is stale.");
        return this.mailItem(connection, secret, client, mailbox, Number(item.target.uid));
      });
      if (fresh.item.version !== item.version) fail("Source email changed; read the current source and obtain fresh authorization before replying.");
      const to = replyRecipient(fresh.email);
      if (!item.target.replyTo || to !== item.target.replyTo) fail("The approved reply mailbox does not match the current source; obtain fresh authorization.");
      const from = mailboxAddress(config.username) ?? fail("SMTP replies require the connection username to be a valid sender email address.");
      const transport = this.smtp(config, secret);
      const abort = () => transport.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) fail("Source operation was closed before sending.");
        this.authorized(connection, secret);
        const originalId = messageId(fresh.email.messageId);
        const result = await transport.sendMail({
          from: { address: from, name: "" }, to: [{ address: to, name: "" }], envelope: { from, to: [to] },
          subject: clip(/^re:/i.test(fresh.email.subject ?? "") ? fresh.email.subject! : `Re: ${fresh.email.subject ?? "(no subject)"}`, 512).replace(/[\r\n\0]/g, " "),
          text: action.body, ...(originalId ? { inReplyTo: originalId, references: originalId } : {}), disableFileAccess: true, disableUrlAccess: true,
        }, () => {
          if (signal.aborted) fail("Source operation was closed before SMTP delivery.");
          this.authorized(connection, secret);
        }, () => { writeStarted = true; });
        if (!result.accepted?.length || result.rejected?.length) fail("SMTP did not confirm acceptance of the bound recipient. Delivery status may be uncertain; do not blindly retry.");
      } finally { signal.removeEventListener("abort", abort); transport.close(); }
      return { summary: "Reply accepted by SMTP for the source message's reply mailbox. Final delivery is controlled by the mail server." };
    }).catch(error => {
      if (writeStarted) throw error;
      throw new NoEffect(error instanceof SourceError ? error.message : "Source action was refused before any external write.");
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
