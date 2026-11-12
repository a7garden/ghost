import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { ActivityAction, ActivitySource, ActivitySourceItem, Connection, ConnectionConfig } from "@ghost/contract";
import { ImapFlow, type ImapFlowOptions, type MailboxObject } from "imapflow";
import PostalMime, { type Email } from "postal-mime";
import { activitySmtp, type ActivitySmtpClient, type ActivitySmtpOptions } from "./activity-mail.ts";
import XOAuth2 from "nodemailer/lib/xoauth2";
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
  /** Rotate OAuth access under the same account epoch, preserving cursor and target seals. */
  rotateCredential?(id: string, value: string, version: string): Promise<void>;
  /** Host-only OAuth: run before every operation; null clears it. Implementations must not swallow refresh errors. */
  setOAuthRefresher?(refresh: ((connection: Connection) => Promise<void>) | null): void;
  mcpAuthority?(connection: Connection): Promise<{ headers: Record<string, string>; authorize(): void; redact(text: string): string }>;
  test(connection: Connection): Promise<{ summary: string }>;
  poll(connection: Connection, source: Exclude<ActivitySource, { kind: "schedule" | "commit" }>, cursor: string | null, options?: { baseline?: boolean }): Promise<ActivitySourcePoll>;
  read(connection: Connection, item: ActivitySourceItem): Promise<ActivitySourceItem>;
  act(connection: Connection, item: ActivitySourceItem, action: ActivityAction): Promise<{ summary: string }>;
  /** One bounded authenticated REST exchange against an api-kind connection; responses are sanitized. Absent on minimal ports. */
  apiRequest?(connection: Connection, input: ApiRequestInput): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** Model-supplied REST input: a relative path on the configured origin. Headers are never accepted. */
export interface ApiRequestInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path (and optional query) inside the configured base origin/path boundary. */
  path: string;
  body?: string;
  /** Host-only live authority check, after refresh and immediately before transport. */
  authorize?: () => void;
}

export interface ApiResponse {
  status: number;
  contentType: string | null;
  /** Sanitized body: every credential-bearing value is replaced before this leaves the port. */
  body: string;
  truncated: boolean;
  /** Parsed JSON body, or undefined when the body is not JSON. */
  json: unknown;
  nextPath?: string;
}

type MailConfig = Extract<Connection["config"], { kind: "mail" }>;
type ApiConfig = Extract<Connection["config"], { kind: "api" }>;
type Source = Exclude<ActivitySource, { kind: "schedule" | "commit" }>;
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
export class SourceError extends Error {}
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
  if (config.kind !== "github" && config.kind !== "gitea") return fail("This connection is not a GitHub or Gitea API source.");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return fail("Set a valid absolute API URL (GitHub: https://api.github.com; Gitea: https://your-server/api/v1)."); }
  if (url.username || url.password || url.search || url.hash || !["https:", ...(config.kind === "gitea" ? ["http:"] : [])].includes(url.protocol)) {
    return fail("API URL must not contain credentials, query parameters or fragments; GitHub requires HTTPS.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/** Headers that carry credentials on their own; an API key belongs in the configured credential header instead. */
const FORBIDDEN_HEADERS: Record<string, true> = { authorization: true, "proxy-authorization": true, cookie: true, "set-cookie": true, host: true, connection: true, "content-length": true, "transfer-encoding": true, upgrade: true };
/** The configured origin of an api connection: owner-trusted, so private and plain-HTTP endpoints stay usable. */
function apiEndpoint(config: ApiConfig): URL {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return fail("Set a valid absolute API base URL."); }
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) {
    return fail("API base URL must be http or https, without embedded credentials, query parameters or fragments.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}
function relativePath(value: string, what: string): string {
  const path = value.trim();
  if (!path || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("#") || /[\s\\\r\n\0]/.test(path) || path.length > 2048) {
    fail(`Set ${what} as a relative API path, without a URL, scheme or fragment.`);
  }
  return path;
}
export function connectionRequestUrl(config: ApiConfig, path: string): URL {
  const root = apiEndpoint(config);
  const relative = relativePath(path, "the request path");
  const url = new URL(relative.startsWith(root.pathname) ? relative : relative.replace(/^\//, ""), root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) fail("The request path escaped the configured API origin.");
  return url;
}

// Slack's GET endpoints are RPC methods: HTTP GET alone does not make them reads.
const SLACK_READ_METHODS = new Set(["api.test", "auth.test", "team.info", "team.profile.get", "users.list", "users.info", "users.lookupByEmail", "users.getPresence", "users.profile.get", "conversations.list", "conversations.info", "conversations.history", "conversations.replies", "conversations.members", "search.all", "search.messages", "search.files", "files.list", "files.info", "emoji.list", "reactions.get", "stars.list", "pins.list", "usergroups.list", "usergroups.users.list"]);
export function connectionRequestIsReadOnly(connection: Connection, method: ApiRequestInput["method"], path: string): boolean {
  if (connection.config.kind !== "api") return false;
  const url = connectionRequestUrl(connection.config, path);
  const relative = url.pathname.slice(apiEndpoint(connection.config).pathname.length).replace(/^\//, "");
  const readPaths = connection.config.readPaths ?? [];
  if (readPaths.some((entry) => entry.method === method && boundedGlob(entry.path.replace(/^\//, ""), relative))) return true;
  if (method !== "GET") return false;
  const slack = connection.serviceId === "slack" || /(^|\.)slack(?:-gov)?\.com$/.test(url.hostname);
  return !slack || SLACK_READ_METHODS.has(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
}

function boundedGlob(pattern: string, value: string): boolean {
  if (pattern.length > 4096 || value.length > 8192) return false;
  const parts = pattern.split("*");
  let offset = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!part) continue;
    const found = value.indexOf(part, offset);
    if (found < 0 || (index === 0 && found !== 0)) return false;
    offset = found + part.length;
  }
  return pattern.endsWith("*") || offset === value.length;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) fail("Invalid JSON pointer.");
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) fail("JSON pointer does not exist in the poll response.");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function validateApi(config: ApiConfig): void {
  apiEndpoint(config);
  if (!HEADER_NAME.test(config.authHeader) || config.authHeader.toLowerCase() !== "authorization" && FORBIDDEN_HEADERS[config.authHeader.toLowerCase()]) {
    fail("Set a valid credential header name (for example Authorization or X-Api-Key); cookies and response headers are not credentials.");
  }
  if (/[\r\n\0]/.test(config.authPrefix)) fail("The credential prefix must not contain control characters.");
  relativePath(config.testPath, "the identity endpoint testPath");
  for (const [name, value] of Object.entries(config.headers)) {
    if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(value)) fail("Static header names and values must be valid header content without control characters.");
    if (FORBIDDEN_HEADERS[name.toLowerCase()] || /(?:auth|token|api[-_]?key|secret|cookie)/i.test(name) || name.toLowerCase() === config.authHeader.toLowerCase()) {
      fail(`Static headers must stay metadata: "${name}" carries credentials or overrides the credential header; put keys in the credential header instead.`);
    }
  }
}
/**
 * The authenticated identity a test endpoint must expose. HTTP status alone is not proof:
 * Slack returns HTTP 200 with `{ok:false,error:"invalid_auth"}`, which must fail.
 */
function assertIdentity(json: unknown): string {
  if (json === undefined) fail("The identity endpoint did not return JSON. Check testPath (identity probes return JSON, such as /v1/users/me, /2/users/me or /api/auth.test).");
  if (!object(json)) fail("The identity endpoint returned a non-object JSON body.");
  if (json.ok === false) {
    const error = str(json.error).replace(/[\r\n\0]/g, " ").trim().slice(0, 64);
    fail(`The provider rejected this credential${error ? ` (${error})` : ""}. Check the token and its scopes.`);
  }
  const identified = (value: unknown) => typeof value === "number" || value === true || str(value).length > 0;
  const identityKeys = ["id", "login", "sub", "user", "user_id", "username", "email", "account_id", "self"];
  const data = object(json.data) ? json.data : null;
  if (json.ok === true || identityKeys.some((key) => identified(json[key])) || (data !== null && identityKeys.some((key) => identified(data[key])))) {
    return "an authenticated identity";
  }
  fail("The identity endpoint returned no authenticated identity. Check the credential, its scopes and testPath.");
}
/** JWT expiry for honest OAuth messaging; null when the credential carries no parseable `exp`. */
function tokenExpiry(credential: string): string | null {
  const parts = credential.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? new Date(payload.exp * 1000).toISOString() : null;
  } catch { return null; }
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
  else if (config.kind === "api") validateApi(config);
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
  /** Host-registered OAuth access-token refresher; runs before every operation. */
  private refresher: ((connection: Connection) => Promise<void>) | null = null;
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
  /** Host mail transport only: never return this authority through an API or model tool. */
  async mailAuthority(connection: Connection): Promise<{ credential: string; authorize(): void }> {
    if (this.closed || connection.config.kind !== "mail") fail("Mail account is unavailable.");
    validateMail(connection.config);
    if (this.refresher) {
      try { await this.refresher(connection); }
      catch { fail("OAuth access token could not be refreshed; reconnect this account."); }
    }
    const secret = this.authorized(connection);
    return { credential: secret.credential, authorize: () => {
      if (this.closed) fail("Source connections are closed.");
      this.authorized(connection, secret);
    } };
  }
  async mcpAuthority(connection: Connection): Promise<{ headers: Record<string, string>; authorize(): void; redact(text: string): string }> {
    if (this.closed || connection.config.kind !== "api") fail("MCP authentication requires an available API connection.");
    validateApi(connection.config);
    if (this.refresher) {
      try { await this.refresher(connection); }
      catch { fail("OAuth access token could not be refreshed; reconnect this account."); }
    }
    const secret = this.authorized(connection);
    const config = connection.config;
    const secrets = [secret.credential, JSON.stringify(secret.credential).slice(1, -1), encodeURIComponent(secret.credential)];
    return {
      headers: { ...config.headers, [config.authHeader]: config.authPrefix ? `${config.authPrefix} ${secret.credential}` : secret.credential },
      authorize: () => {
        if (this.closed) fail("Source connections are closed.");
        if (this.authorized(connection, secret).credential !== secret.credential) fail("The authentication token rotated; obtain fresh request headers.");
      },
      redact: (text) => secrets.reduce((value, credential) => value.split(credential).join("[redacted]"), text),
    };
  }
  async setCredential(id: string, value: string | null, version: string | null): Promise<void> {
    this.storeCredential(id, value, version);
  }
  async rotateCredential(id: string, value: string, version: string): Promise<void> {
    const existing = this.secret(id);
    if (!existing || existing.version !== version) fail("The OAuth account authority changed before token rotation.");
    this.storeCredential(id, value, version, existing.key);
  }
  private storeCredential(id: string, value: string | null, version: string | null, key?: string): void {
    if (this.closed) fail("Source connections are closed.");
    const file = this.file(id);
    if (value === null) { if (existsSync(file)) unlinkSync(file); return; }
    if (!value || value.length > 16384 || /[\r\n\0]/.test(value)) fail("Enter a non-empty token or app password without line breaks (maximum 16384 characters).");
    if (!version || version.length > 128 || /[\r\n\0]/.test(version)) fail("Credential replacement requires a fresh non-empty account version.");
    const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ credential: value, key: key ?? randomBytes(32).toString("hex"), version }), { mode: 0o600, flag: "wx" });
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
    if (target.kind === "pr") {
      if (connection.config.kind !== "github" && connection.config.kind !== "gitea") fail("Pull request targets require a GitHub or Gitea connection.");
      repositoryPath(target.repository ?? "");
      if (!/^[1-9][0-9]{0,9}$/.test(target.number ?? "") || item.id !== `pr:${connection.id}:${target.repository}:${target.number}`) fail("Pull request target does not match this source item.");
    } else if (target.kind === "mail" && connection.config.kind === "mail") {
      if (target.mailbox !== connection.config.mailbox || !/^[1-9][0-9]{0,19}$/.test(target.validity ?? "") || !/^[1-9][0-9]{0,9}$/.test(target.uid ?? "") || item.id !== `mail:${connection.id}:${hash(target.mailbox).slice(0, 16)}:${target.validity}:${target.uid}`) fail("Mail target does not match this source item.");
    } else if (target.kind === "poll" && connection.config.kind === "api") {
      if (!target.path || target.itemsPointer === undefined || target.idPointer === undefined || !target.itemId) fail("Poll target metadata is invalid.");
      if (target.itemType !== "string" && target.itemType !== "number") fail("Poll item identity type is invalid.");
      const rawId = target.itemType === "number" ? Number(target.itemId) : target.itemId;
      if (typeof rawId === "number" && !Number.isSafeInteger(rawId)) fail("Poll item identity is invalid.");
      const identity = hash(JSON.stringify([target.itemType, rawId]));
      if (item.id !== `poll:${connection.id}:${identity}` || item.version !== identity) fail("Poll target does not match this source item.");
      connectionRequestUrl(connection.config, target.path);
    } else fail("Source provider does not match this connection.");
  }
  /** Register the host's OAuth refresher; it must fail loudly so stale tokens are never used silently. */
  setOAuthRefresher(refresh: ((connection: Connection) => Promise<void>) | null): void {
    this.refresher = refresh;
  }
  private async operation<T>(connection: Connection, run: (secret: Secret, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) fail("Source connections are closed.");
    if (this.refresher) {
      try { await this.refresher(connection); }
      catch {
        fail("OAuth access token could not be refreshed; reconnect this account.");
      }
    }
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
      if (error instanceof SourceError || error instanceof NoEffect) throw error;
      const code = object(error) ? str(error.code) : "";
      if (/AUTH|EAUTH|LOGIN|Authentication/i.test(code)) {
        if (connection.config.kind === "mail" && connection.config.authType === "oauth2") {
          fail("OAuth access token rejected by the mail server. It has most likely expired or been revoked; reconnect or refresh this account's token.");
        }
        fail("Account authentication failed. Check the username and token/app password and enable IMAP/SMTP access for this account.");
      }
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
  /** One bounded authenticated REST exchange on the configured origin. Headers come only from the configuration. */
  private async requestApi(connection: Connection, secret: Secret, input: ApiRequestInput, signal: AbortSignal): Promise<ApiResponse> {
    if (connection.config.kind !== "api") fail("REST requests run only against api-kind connections.");
    const config = connection.config as ApiConfig;
    this.authorized(connection, secret);
    if (input.body !== undefined && (input.body.length === 0 || input.body.length > 65536)) fail("A request body must contain 1–65536 characters.");
    const url = connectionRequestUrl(config, input.path);
    // Only the credential (raw and prefixed) is secret; static headers are metadata that may safely appear.
    const secretValues = [secret.credential, JSON.stringify(secret.credential).slice(1, -1), encodeURIComponent(secret.credential)]
      .filter(value => value.length > 0);
    const redact = (text: string) => secretValues.reduce((out, value) => out.split(value).join("[redacted]"), text);
    const headers: Record<string, string> = {
      Accept: "application/json", "User-Agent": "Ghost-Connection",
      ...config.headers,
      [config.authHeader]: config.authPrefix ? `${config.authPrefix} ${secret.credential}` : secret.credential,
    };
    if (input.body !== undefined && !Object.keys(config.headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      input.authorize?.();
      response = await (this.options.fetch ?? fetch)(url, {
        method: input.method, redirect: "error", headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        ...(input.body === undefined ? {} : { body: input.body }),
      });
    } catch (error) {
      if (signal.aborted) fail("Source operation was closed before the API request.");
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) fail("API authentication or permission denied (HTTP 401/403). Check the credential, its scopes and the configured header form. No provider error body is exposed.");
      fail(`API returned HTTP ${response.status}; no provider error body is exposed.`);
    }
    if (!response.body) return { status: response.status, contentType: redact(response.headers.get("content-type") ?? ""), body: "", truncated: false, json: undefined };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > MAX_API) { chunks.push(value.subarray(0, MAX_API - size)); size = MAX_API; truncated = true; break; }
        chunks.push(value); size += value.byteLength;
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const body = redact(Buffer.concat(chunks, size).toString("utf8"));
    let json: unknown;
    try { json = JSON.parse(body) as unknown; } catch { json = undefined; }
    const link = [...(response.headers.get("link") ?? "").matchAll(/<([^>]+)>\s*([^<>]*)/g)].find((entry) => {
      const relation = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(entry[2]!);
      return (relation?.[1] ?? relation?.[2] ?? "").split(/\s+/).includes("next");
    })?.[1];
    let nextPath: string | undefined;
    if (link) {
      const next = new URL(link, url);
      const root = apiEndpoint(config);
      if (next.origin !== root.origin || !next.pathname.startsWith(root.pathname) || next.username || next.password || next.hash) fail("Pagination escaped the configured API origin.");
      nextPath = `${next.pathname}${next.search}`;
    }
    return { status: response.status, contentType: redact(response.headers.get("content-type") ?? "").slice(0, 128), body: `${body}${truncated ? "\n[body truncated]" : ""}`, truncated, json, ...(nextPath ? { nextPath } : {}) };
  }
  /** Model-facing REST entry: bounded, sanitized, and re-authorized around the exchange. */
  async apiRequest(connection: Connection, input: ApiRequestInput): Promise<ApiResponse> {
    return this.operation(connection, (secret, signal) => this.requestApi(connection, secret, input, signal));
  }
  private async mail<T>(connection: Connection, secret: Secret, signal: AbortSignal, run: (client: ImapClient, mailbox: MailboxObject) => Promise<T>): Promise<T> {
    this.authorized(connection, secret);
    const config = connection.config as MailConfig;
    const options: ImapFlowOptions = {
      host: config.host, port: config.port, secure: true, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: config.authType === "oauth2"
        ? { user: config.username, accessToken: secret.credential }
        : { user: config.username, pass: secret.credential },
      logger: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
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
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: config.authType === "oauth2"
        ? { user: config.username, method: "XOAUTH2", oauth2: new XOAuth2({ user: config.username, accessToken: secret.credential }) }
        : { user: config.username, pass: secret.credential },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000, dnsTimeout: 15_000,
      logger: false, debug: false, transactionLog: false, maxResponseSize: 65536,
    };
    return this.options.smtp?.(options) ?? activitySmtp(options);
  }
  async test(connection: Connection): Promise<{ summary: string }> {
    return this.operation(connection, async (secret, signal) => {
      if (connection.config.kind === "api") {
        const config = connection.config as ApiConfig;
        if (!connectionRequestIsReadOnly(connection, "GET", config.testPath)) fail("The identity endpoint must be a read-only API method.");
        const response = await this.requestApi(connection, secret, { method: "GET", path: config.testPath }, signal);
        const identity = assertIdentity(response.json);
        return { summary: `API authentication succeeded: HTTP ${response.status} returned ${identity}. Scoped permissions are checked when the Ghost requests.` };
      }
      if (connection.config.kind === "github" || connection.config.kind === "gitea") {
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
      const expiry = config.authType === "oauth2" ? tokenExpiry(secret.credential) : null;
      const tokenNote = config.authType === "oauth2"
        ? ` The access token expires ${expiry ? `at ${expiry}` : "at an unknown time; reconnect when authentication is rejected"}.`
        : "";
      return { summary: `IMAP read-only mailbox access and SMTP TLS authentication succeeded. No message was sent.${tokenNote}` };
    });
  }
  async poll(connection: Connection, source: Source, cursor: string | null, options?: { baseline?: boolean }): Promise<ActivitySourcePoll> {
    return this.operation(connection, async (secret, signal) => {
      if (source.connectionId !== connection.id) fail("Activity source belongs to a different connection.");
      const baseline = options?.baseline ?? (cursor === null && ("includeExisting" in source) && !source.includeExisting);
      if (cursor && cursor.length > 262144) fail("Source cursor exceeds its safety limit; reset the activity source baseline.");
      const scope = hash(JSON.stringify([this.scope(connection, secret), source]));
      let parsed: unknown = null;
      if (cursor) { try { parsed = JSON.parse(cursor); } catch { fail("Source cursor is invalid; reset the activity source baseline."); } }
      if (parsed !== null && (!object(parsed) || parsed.scope !== scope)) fail("Source cursor belongs to an old account or different source; reset the activity source baseline.");
      if (source.kind === "poll") return this.pollGeneric(connection, secret, source, parsed, scope, baseline, signal);
      if (source.kind === "pull_request") {
        if (connection.config.kind !== "github" && connection.config.kind !== "gitea") fail("Pull request activities require a GitHub or Gitea connection.");
        return this.pollPR(connection, secret, source, parsed, scope, baseline, signal);
      }
      if (connection.config.kind !== "mail") fail("Mail activities require an IMAP connection.");
      return this.pollMail(connection, secret, source, parsed, scope, baseline, signal);
    });
  }
  private async pollGeneric(connection: Connection, secret: Secret, source: Extract<Source, { kind: "poll" }>, parsed: unknown, scope: string, baseline: boolean, signal: AbortSignal): Promise<ActivitySourcePoll> {
    if (connection.config.kind !== "api") fail("Polling requires an API connection.");
    let seen: string[] = [];
    if (parsed !== null) {
      if (!object(parsed) || parsed.kind !== "poll" || !Array.isArray(parsed.seen) || parsed.seen.some((id) => typeof id !== "string")) fail("Poll cursor is invalid.");
      seen = parsed.seen as string[];
    }
    const known = new Set(seen);
    const responseIds = new Set<string>();
    const items: ActivitySourceItem[] = [];
    const pages = new Set<string>();
    let path: string | undefined = source.path;
    while (path !== undefined) {
      if (pages.size >= 50 || pages.has(path)) fail("Poll pagination is cyclic or exceeds 50 pages; no cursor advanced.");
      pages.add(path);
      if (!connectionRequestIsReadOnly(connection, "GET", path)) fail("Poll endpoint must be owner-marked read-only.");
      const response = await this.requestApi(connection, secret, { method: "GET", path }, signal);
      if (response.truncated || response.json === undefined) fail("Poll response is empty, malformed JSON or too large; no cursor advanced.");
      const records = jsonPointer(response.json, source.itemsPointer);
      if (!Array.isArray(records)) fail("Poll itemsPointer must identify an array; no cursor advanced.");
      for (const record of records) {
        const rawId = jsonPointer(record, source.idPointer);
        if ((typeof rawId !== "string" && typeof rawId !== "number") || String(rawId).length === 0 || String(rawId).length > 256 || (typeof rawId === "number" && !Number.isSafeInteger(rawId))) fail("Poll item idPointer must identify a bounded string or safe integer; no cursor advanced.");
        const id = hash(JSON.stringify([typeof rawId, rawId]));
        if (responseIds.has(id)) continue;
        responseIds.add(id);
        if (known.has(id)) continue;
        const body = JSON.stringify(record);
        if (body.length > 32768) fail("Poll item exceeds 32768 characters; narrow the endpoint. No item was discarded.");
        known.add(id);
        if (!baseline) items.push({ id: `poll:${connection.id}:${id}`, version: id, title: String(rawId).slice(0, 512), text: body, url: null, author: null, occurredAt: null,
          target: this.target(connection, secret, id, { kind: "poll", path: source.path, itemsPointer: source.itemsPointer, idPointer: source.idPointer, itemId: String(rawId), itemType: typeof rawId }) });
      }
      path = response.nextPath;
    }
    const cursor = JSON.stringify({ kind: "poll", scope, seen: [...responseIds].sort() });
    if (cursor.length > 262144) fail("Poll response identity set exceeds its safety limit; narrow the endpoint. No cursor advanced.");
    return { items, exclusions: [], cursor };
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
      if (item.target.kind === "poll") {
        const source = { kind: "poll" as const, connectionId: connection.id, path: item.target.path!, itemsPointer: item.target.itemsPointer!, idPointer: item.target.idPointer!, pollSeconds: 60 };
        const result = await this.pollGeneric(connection, secret, source, null, hash(JSON.stringify(source)), false, signal);
        const current = result.items.find((candidate) => candidate.id === item.id);
        if (!current) fail("The bound poll item is no longer available.");
        return current;
      }
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
      if (item.target.kind === "poll") fail("Generic poll sources do not grant source actions; use an explicitly authorized connection tool.");
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
