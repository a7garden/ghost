import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { basename, extname, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import {
  ArtifactRef,
  type ProviderQuota,
  Id,
  CommandRequest,
  ContractError,
  PairingClaim,
  type CommandResponse,
  type Conversation,
  type Decision,
  type Device,
  type Effect,
  type Ghost,
  type Notification,
  type Work,
  type ConversationPage,
  type ErrorCode,
  type LedgerEvent,
  type PairingResult,
  type StreamFrame,
  type PageSummary,
  type PageView,
  type NextMessageSuggestions,
  CodingSessionCreate,
  CodingThinking,
  CodingPrompt,
  CodingDialogAnswer,
  type CodingEvent,
  type SkillCatalog,
  parse,
} from "@ghost/contract";
import type { Config } from "../config.ts";
import type { BrowserPort, DocumentsPort, SkillsPort } from "../integrations/ports.ts";
import { listFolders } from "./folders.ts";
import { PairingLimiter } from "./pairing-limit.ts";
import { OAuthLogins } from "./oauth.ts";
import { serveLocalAuth } from "./local-auth.ts";
import { LocalAuth } from "../integrations/local-auth.ts";
import { ProviderQuotas } from "../integrations/provider-quota.ts";
import { ConnectionOAuth } from "./connection-oauth.ts";
import { serveConnect } from "./connect.ts";
import { serveShade } from "./shade.ts";
import type { LocalAccounts } from "../integrations/local-accounts.ts";
import type { LoginShelf } from "../integrations/login-shelf.ts";
import type { Shade } from "../integrations/shade.ts";
import { CloudflareAccessVerifier } from "./cloudflare-access.ts";
import { goPage, TailscaleIdentity } from "./tailscale-identity.ts";
import { Access } from "../core/access.ts";
import { execute, hashSecret } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { CommandError, invalid, notFound } from "../core/errors.ts";
import { PiInstall, PiPackageFlags, PiPackageOverrides, PiSessionConfigUpdate, PiSettings } from "@ghost/contract";
import { CodingSessions } from "../coding/index.ts";
import { CodingModels } from "../coding/models.ts";
import { serveOrchestration } from "../orchestration/routes.ts";
import { readRegular as readCodingFile } from "../coding/workspace.ts";
import type { Terminals } from "../terminal/index.ts";
import { serveTerminals, terminalStreamBearer, terminalWebSocket, type TerminalSocket } from "../terminal/routes.ts";
import { newId } from "../core/ids.ts";
import { HOST_VERSION, snapshot, workDetail } from "../core/state.ts";
import { Suggestions } from "../core/suggestions.ts";
import { readMetrics } from "../core/metrics.ts";
import type { ConfigRevision } from "@ghost/contract";
import { NotFound } from "../ledger/ledger.ts";
import type { Vault } from "../stores/vault.ts";
import type { MemoryStore } from "../stores/memory.ts";
import { serveVault } from "./vault.ts";
import { serveMemory } from "./memory.ts";
import { serveBrowser } from "./browser.ts";
import { isIosTokenRoute, serveIosUpdate, serveUpdate } from "../update/api.ts";
import type { Updater } from "../update/index.ts";
import type { MailService } from "../integrations/mail.ts";
import { serveMail } from "./mail.ts";
import { serveWorkbench } from "../workbench/http.ts";
import type { Workbench } from "../workbench/service.ts";

const HTTP_STATUS: Record<ErrorCode, number> = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };
const DIGEST = /^[0-9a-f]{64}$/;
const AFTER = /^\d+$/;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9a-z-]+=(?:[!#$%&'*+.^_`|~0-9a-z-]+|"[^"\\\r\n]*"))*$/i;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** Loopback peers only: the owner token is never injected for a request from another interface. */
export function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

const error = (code: ErrorCode, message: string, status: number, headers: Record<string, string> = {}) =>
  json({ ok: false, error: { code, message } }, status, headers);

/**
 * Ledger event payloads as the ledger's row mappers build them. The typebox union's static
 * shape degrades behind its computed keys, so stream logic views them through this mirror.
 */
type EventPayload =
  | { type: "ghost"; ghost: Ghost }
  | { type: "conversation"; conversation: Conversation }
  | { type: "conversation.removed"; id: string }
  | { type: "work"; work: Work }
  | { type: "decision"; decision: Decision }
  | { type: "effect"; effect: Effect }
  | { type: "notification"; notification: Notification }
  | { type: "schedule" | "schedule.removed" | "scope" | "scope.removed" | "settings" | "sandbox" | "activity" | "activity_run" | "connection" | "connection.removed" }
  | { type: "avatar" | "avatar.removed" }
  | { type: "device"; device: Device }
  | { type: "device.removed"; id: string };

export function startServer(deps: { core: Core; config: Config; ownerToken: string; documents: DocumentsPort | null; skills: SkillsPort | null; terminals?: Terminals | null; workbench?: Workbench | null; vault?: Vault | null; browser?: BrowserPort | null; logins?: LoginShelf | null; shade?: Shade | null; localAccounts?: LocalAccounts | null; mail?: MailService | null; updater?: Updater | null; memory?: MemoryStore | null; memoryDreams?: { request(ghostId: string): void } | null; quotas?: ProviderQuotas }): { port: number; stop(): Promise<void> } {
  const { core, config, ownerToken, documents, skills, vault = null, browser = null, logins = null, shade = null, localAccounts = null, updater = null, memory = null, memoryDreams = null } = deps;
  const quotas = deps.quotas ?? new ProviderQuotas({ providers: () => core.ledger.providers(), secrets: core.secrets });
  const ownerHash = Buffer.from(hashSecret(ownerToken));
  const pairingLimiter = new PairingLimiter(10, 30);
  const oauth = new OAuthLogins(core);
  const localAuth = new LocalAuth();
  const suggestions = new Suggestions(core);

  const server = Bun.serve<TerminalSocket>({
    hostname: config.host,
    port: config.port,
    // Bun closes connections idle for 10 s by default; the SSE keepalive is every 15 s.
    idleTimeout: 60,
    fetch: (request, bound) => handle(request, bound),
    websocket: terminalWebSocket,
  });
  // API, app HTML and terminal WebSockets share this listener, including for port 0.
  if (core.codingSessions instanceof CodingSessions) core.codingSessions.protectHostPort(server.port!);

  const loopbackHosts = new Set([`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`]);
  const allowedHosts = new Set(loopbackHosts);
  const publicOrigin = config.publicOrigin ?? `http://${config.host}:${server.port}`;
  const terminalPublicOrigin = URL.parse(publicOrigin);
  try {
    allowedHosts.add(new URL(publicOrigin).host.toLowerCase());
  } catch {
    core.log("invalid publicOrigin; only loopback hosts are accepted", publicOrigin);
  }
  const edge = config.cloudflareAccess ? new CloudflareAccessVerifier(config.cloudflareAccess, fetch, Date.now, core.log) : null;
  if (edge !== null) allowedHosts.add(edge.host);
  const tailnet = config.tailscaleIdentity ? new TailscaleIdentity(config.tailscaleIdentity) : null;
  if (tailnet !== null) allowedHosts.add(tailnet.host);
  const entry = tailnet !== null && config.cloudflareAccess ? goPage(tailnet.config.origin, config.cloudflareAccess.origin) : null;
  const connectionOAuth = new ConnectionOAuth(core, { root: config.root, publicOrigin });
  core.activitySources?.setOAuthRefresher?.(connection => connectionOAuth.refresh(connection));

  function failure(caught: unknown): Response {
    if (caught instanceof CommandError) return error(caught.code, caught.message, HTTP_STATUS[caught.code]);
    if (caught instanceof ContractError) return error("invalid", caught.message, 400);
    if (caught instanceof NotFound) return error("not_found", caught.message, 404);
    core.log("request failed", caught);
    return error("internal", "internal error", 500);
  }

  function authenticate(request: Request, websocketBearer: string | null = null): Access | null {
    const header = request.headers.get("authorization") ?? websocketBearer;
    if (header === null || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length).trim();
    if (token.length === 0) return null;
    const candidate = Buffer.from(hashSecret(token));
    if (candidate.length === ownerHash.length && timingSafeEqual(candidate, ownerHash)) return new Access({ kind: "owner" });
    const device = core.ledger.deviceByTokenHash(hashSecret(token));
    if (device === null) return null;
    core.ledger.touchDevice(device.id, Date.now());
    return new Access({ kind: "device", deviceId: device.id, name: device.name });
  }

  /**
   * One-time pairing claim. Claim and device insert share one ledger transaction, so a
   * consumed code always yields a device. Only failed attempts count toward the limits.
   */
  async function claimPairing(request: Request, address: string): Promise<Response> {
    const now = Date.now();
    if (!pairingLimiter.allows(address, now)) {
      return error("unavailable", "too many pairing attempts", 429, { "retry-after": "60" });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      pairingLimiter.noteFailure(address, Date.now());
      return error("invalid", "malformed JSON body", 400);
    }
    try {
      const input = parse(PairingClaim, body);
      const name = input.deviceName.trim() || "iPhone";
      core.ledger.prunePairings(now);
      const deviceId = newId();
      const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      const claimed = core.ledger.tx((): Device | null => {
        if (!core.ledger.claimPairing(hashSecret(input.code.toUpperCase()), deviceId, now)) return null;
        const device: Device = { id: deviceId, name, pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: now, lastSeenAt: null };
        core.ledger.insertDevice(device, hashSecret(token));
        return device;
      });
      if (claimed === null) {
        pairingLimiter.noteFailure(address, Date.now());
        return error("not_found", "invalid or expired pairing code", 404);
      }
      return json({ deviceId, token } satisfies PairingResult);
    } catch (caught) {
      pairingLimiter.noteFailure(address, Date.now());
      return failure(caught);
    }
  }

  async function serveCommand(request: Request, access: Access): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error("invalid", "malformed JSON body", 400);
    }
    try {
      const commandRequest = parse(CommandRequest, body);
      const result = await execute(core, access, commandRequest, { publicOrigin, documents, mail: deps.mail });
      return json({ ok: true, result } satisfies CommandResponse);
    } catch (caught) {
      return failure(caught);
    }
  }

  async function serveConversation(id: string, url: URL): Promise<Response> {
    const conversation = core.ledger.conversation(id);
    const limitParameter = url.searchParams.get("limit");
    const limit = limitParameter === null ? 100 : Math.min(Math.max(Number.parseInt(limitParameter, 10) || 0, 1), 500);
    const page = await core.engine.page(id, url.searchParams.get("before"), limit);
    return json({ conversation, ...page } satisfies ConversationPage);
  }

  async function uploadArtifact(request: Request): Promise<Response> {
    let name: string;
    try {
      name = decodeURIComponent(request.headers.get("x-ghost-file-name") ?? "");
    } catch {
      return error("invalid", "file name must be percent-encoded UTF-8", 400);
    }
    const mediaType = request.headers.get("content-type") ?? "";
    try {
      parse(ArtifactRef, { digest: "0".repeat(64), name, mediaType, size: 0 });
    } catch (caught) {
      return failure(caught);
    }
    if (/[\u0000-\u001f\u007f]/.test(name) || !MEDIA_TYPE.test(mediaType)) {
      return error("invalid", "invalid file name or media type", 400);
    }
    if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES) {
      return error("invalid", "artifact exceeds the 20 MiB upload limit", 413);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    try {
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_UPLOAD_BYTES) {
            await reader.cancel();
            return error("invalid", "artifact exceeds the 20 MiB upload limit", 413);
          }
          chunks.push(value);
        }
      }
      return json(await core.artifacts.put(Buffer.concat(chunks, size), name, mediaType), 201);
    } catch (caught) {
      return failure(caught);
    } finally {
      reader?.releaseLock();
    }
  }

  async function serveArtifact(digest: string): Promise<Response> {
    if (!DIGEST.test(digest)) throw notFound(`artifact ${digest}`);
    const rows = core.ledger.artifactsForDigest(digest);
    if (!core.artifacts.has(digest)) throw notFound(`artifact ${digest}`);
    const bytes = await core.artifacts.read(digest);
    // Store reads allocate fresh ArrayBuffer-backed bytes, which is what Bun's body union accepts.
    const body = bytes as Uint8Array<ArrayBuffer>;
    return new Response(body, { headers: { "content-type": rows[0]?.mediaType ?? "application/octet-stream", "x-content-type-options": "nosniff" } });
  }

  function serveEvents(request: Request, url: URL, access: Access): Response {
    const afterParameter = url.searchParams.get("after");
    const after = afterParameter === null ? core.ledger.seq() : Number(afterParameter);
    if (!AFTER.test(afterParameter ?? "0") || !Number.isInteger(after) || after < 0) {
      return error("invalid", "after must be a sequence number", 400);
    }
    const encoder = new TextEncoder();
    const unwatch: (() => void)[] = [];
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        // Bun holds response headers until the first chunk; the preamble flushes them
        // immediately even when the replay is empty. `retry` also hints reconnect pacing.
        push("retry: 5000\n\n");
        const sendFrame = (frame: StreamFrame) => {
          const lines = [`event: ${frame.event}`];
          if (frame.event === "ledger") lines.push(`id: ${frame.data.seq}`);
          lines.push(`data: ${JSON.stringify(frame.data)}`, "", "");
          push(lines.join("\n"));
        };

        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepalive);
          for (const off of unwatch) off();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        request.signal.addEventListener("abort", cleanup);

        // Subscribe before replaying so no event falls into the gap; early arrivals buffer until replay passes them.
        // Revoking a device closes its active stream immediately.
        if (access.principal.kind === "device") {
          const streamDeviceId = access.principal.deviceId;
          unwatch.push(
            core.ledger.subscribe((event) => {
              const data = event.data as EventPayload;
              if (data.type === "device.removed" && data.id === streamDeviceId) cleanup();
            }),
          );
        }
        let cursor = after;
        let replayed = false;
        const buffered: LedgerEvent[] = [];
        unwatch.push(
          core.ledger.subscribe((event) => {
            if (event.seq <= cursor) return;
            if (!replayed) {
              buffered.push(event);
              return;
            }
            cursor = event.seq;
            sendFrame({ event: "ledger", data: event });
          }),
        );

        for (const id of url.searchParams.getAll("conversation")) {
          if (core.ledger.findConversation(id) === null) continue;
          unwatch.push(core.engine.watch(id, (liveEvent) => sendFrame({ event: "live", data: liveEvent })));
        }

        const history = core.ledger.eventsAfter(after);
        if (history === null) {
          cursor = core.ledger.seq();
          sendFrame({ event: "reset", data: { seq: cursor } });
        } else {
          for (const event of history) {
            sendFrame({ event: "ledger", data: event });
            cursor = event.seq;
          }
          for (const event of buffered) {
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            sendFrame({ event: "ledger", data: event });
          }
        }
        replayed = true;

        keepalive = setInterval(() => push(": keepalive\n\n"), 15_000);
        keepalive.unref?.();
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  /** Serves `uiDir` with a SPA fallback. Dotfiles and paths escaping `uiDir` never resolve. */
  async function serveUi(request: Request, url: URL, injectToken: boolean): Promise<Response> {
    if (request.method !== "GET" || config.uiDir === null) return error("not_found", "not found", 404);
    const uiRoot = resolve(config.uiDir);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return error("not_found", "not found", 404);
    }
    const relative = pathname.replace(/^\/+/, "");
    const segments = relative.length === 0 ? ["index.html"] : relative.split("/");
    if (segments.some((segment) => segment.length === 0 || segment.startsWith(".") || segment.includes("\\"))) {
      return error("not_found", "not found", 404);
    }
    const target = resolve(uiRoot, ...segments);
    if (target !== uiRoot && !target.startsWith(uiRoot + sep)) return error("not_found", "not found", 404);

    const serve = async (path: string): Promise<Response | null> => {
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw caught;
      }
      const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
      // readFile allocates fresh ArrayBuffer-backed bytes, which is what Bun's body union accepts.
      const body = bytes as unknown as Uint8Array<ArrayBuffer>;
      if (extname(path) === ".html" && injectToken) {
        const script = `<script>window.__GHOST_TOKEN__=${JSON.stringify(ownerToken)}</script>`;
        const html = new TextDecoder().decode(bytes);
        const injected = html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : `${script}${html}`;
        return new Response(injected, { headers: { "content-type": type, "cache-control": "no-store" } });
      }
      return new Response(body, { headers: { "content-type": type } });
    };

    const direct = await serve(target);
    if (direct !== null) return direct;
    const fallback = await serve(join(uiRoot, "index.html"));
    return fallback ?? error("not_found", "not found", 404);
  }

  async function handle(request: Request, bound: Bun.Server<TerminalSocket>): Promise<Response | undefined> {
    // DNS rebinding: only loopback and the public origin may talk to this server.
    const host = (request.headers.get("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return error("forbidden", "untrusted host", 403);
    // The Access web origin admits nothing, UI included, without a verified Access session; that session is the owner.
    const viaEdge = edge !== null && host === edge.host;
    // The single exception: a data-free page that sends a Tailscale-connected browser to the tailnet origin.
    if (viaEdge && entry !== null && request.method === "GET" && new URL(request.url).pathname === "/go") {
      return new Response(entry.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": entry.csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
    if (viaEdge && (await edge.verify(request)) === null) return error("forbidden", "Cloudflare Access login required", 401);
    const peer = bound.requestIP(request);
    const injectToken = loopbackHosts.has(host) && peer !== null && isLoopbackAddress(peer.address);
    // Tailnet identity is ambient like a cookie: only the tailnet Host, a loopback peer (tailscaled) and a
    // same-origin or non-browser request may use it, so no other site or tailnet service can ride it.
    const siteOfRequest = request.headers.get("sec-fetch-site");
    const tailnetOwner = tailnet !== null && host === tailnet.host && peer !== null && isLoopbackAddress(peer.address)
      && siteOfRequest !== "cross-site" && siteOfRequest !== "same-site" && tailnet.login(request.headers) !== null;

    const url = new URL(request.url);
    const pathname = url.pathname;
    if (isIosTokenRoute(pathname)) {
      try { return await serveIosUpdate(request, url, updater); } catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/health" && request.method === "GET") return json({ ok: true, version: HOST_VERSION });
    if (pathname === "/api/pairing/claim" && request.method === "POST") {
      return claimPairing(request, peer === null ? "unknown" : peer.address);
    }
    if (pathname === "/api/connection-oauth/callback") {
      try { return await connectionOAuth.handle(request, url, null) ?? error("not_found", "not found", 404); }
      catch { return error("unavailable", "service login could not be completed", 503); }
    }
    if (!pathname.startsWith("/api/")) {
      try {
        return await serveUi(request, url, injectToken);
      } catch (caught) {
        return failure(caught);
      }
    }

    const terminalsRoute = pathname === "/api/terminals" || pathname.startsWith("/api/terminals/");
    const bearerAccess = viaEdge ? null : authenticate(request, terminalsRoute ? terminalStreamBearer(request, pathname) : null);
    const viaIdentity = !viaEdge && bearerAccess === null && tailnetOwner;
    const access = viaEdge || viaIdentity ? new Access({ kind: "owner" }) : bearerAccess;
    if (access === null) return error("forbidden", "missing or invalid bearer token", 401);
    const fetchSite = request.headers.get("sec-fetch-site");
    if (terminalsRoute) {
      if (fetchSite === "cross-site" || (viaEdge && fetchSite === "same-site")) return error("forbidden", "다른 사이트에서는 터미널을 조작할 수 없습니다.", 403);
      const expectedOrigin = viaEdge ? `https://${host}` : tailnet !== null && host === tailnet.host ? tailnet.config.origin : terminalPublicOrigin?.host === host ? terminalPublicOrigin.origin : url.origin;
      try { return await serveTerminals(request, url, bound, deps.terminals ?? null, expectedOrigin); }
      catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/workbench" || pathname.startsWith("/api/workbench/")) {
      if (fetchSite === "cross-site" || (viaEdge && fetchSite === "same-site")) return error("forbidden", "다른 사이트에서는 작업대를 조작할 수 없습니다.", 403);
      if (!deps.workbench) return error("unavailable", "이 Host에서는 작업대를 열 수 없습니다.", 503);
      try { return json(await serveWorkbench(deps.workbench, access.principal, request, pathname)); }
      catch (caught) { return failure(caught); }
    }
    if (pathname.startsWith("/api/connection-oauth/")) {
      try { return await connectionOAuth.handle(request, url, access) ?? error("not_found", "not found", 404); }
      catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/update" || pathname.startsWith("/api/update/")) {
      try { return await serveUpdate(request, url, updater); } catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/vault" || pathname.startsWith("/api/vault/")) return serveVault(request, url, core, vault);
    if (pathname.startsWith("/api/browser/")) return serveBrowser(request, url, core, browser, () => viaEdge || viaIdentity || authenticate(request) !== null, deps.logins ?? null);
    if (pathname === "/api/shade") return serveShade(request, url, deps.shade ?? null);
    if (pathname.startsWith("/api/connect/")) return serveConnect(request, url, core, access, deps.localAccounts ?? null, publicOrigin);
    if (pathname.startsWith("/api/mail/")) return serveMail(request, url, deps.mail ?? null);
    if (pathname.startsWith("/api/calls/")) {
      try { return await core.calls.serve(request, url, access) ?? error("not_found", "not found", 404); }
      catch (caught) { return failure(caught); }
    }
    if (pathname.startsWith("/api/memory/")) {
      try {
        return await serveMemory(request, url, core, memory, memoryDreams, access);
      } catch (caught) {
        return failure(caught);
      }
    }

    if (pathname === "/api/folders" && request.method === "GET") {
      try {
        if (access.principal.kind !== "owner" && access.principal.kind !== "device") throw new CommandError("forbidden", "폴더 목록은 소유자만 볼 수 있습니다.");
        const known = [...core.ledger.scopes().flatMap((scope) => scope.paths),
          ...(core.codingSessions?.list() ?? []).flatMap((session) => [session.cwd, ...(session.repo ? [session.repo] : [])])];
        return json(listFolders(url.searchParams.get("path"), { stateRoot: config.root, known, hidden: url.searchParams.get("hidden") === "1" }));
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/state" && request.method === "GET") {
      try {
        return json(snapshot(core, access));
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/metrics" && request.method === "GET") {
      try {
        const params = url.searchParams;
        return json(readMetrics(core.ledger, {
          ...(params.has("scopeId") ? { scopeId: params.get("scopeId") || null } : {}),
          ...(params.get("ghostId") ? { ghostId: params.get("ghostId")! } : {}),
          ...(params.get("slot") ? { slot: params.get("slot")! } : {}),
          ...(params.get("ruleId") ? { ruleId: params.get("ruleId")! } : {}),
        }));
      } catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/config/revisions" && request.method === "GET") {
      const entity = url.searchParams.get("entity");
      if (entity !== null && !["scope", "ghost", "rule", "slot", "mcp", "activity", "limits", "connection"].includes(entity)) return error("invalid", "unknown configuration entity", 400);
      return json(core.ledger.configRevisions((entity ?? undefined) as ConfigRevision["entity"] | undefined, url.searchParams.has("entityId") ? url.searchParams.get("entityId") || null : undefined));
    }
    if (pathname === "/api/commands" && request.method === "POST") return serveCommand(request, access);
    if (pathname === "/api/artifacts" && request.method === "POST") return uploadArtifact(request);
    if (pathname === "/api/events" && request.method === "GET") return serveEvents(request, url, access);

    if (pathname === "/api/providers/local-auth" || pathname === "/api/providers/local-auth/import") {
      // Reads other agents' credentials: a page on another site must not be able to trigger it.
      if (fetchSite === "cross-site" || (viaEdge && fetchSite === "same-site")) return error("forbidden", "다른 사이트에서는 인증 정보를 가져올 수 없습니다.", 403);
      try { return json(await serveLocalAuth(request, pathname, core, localAuth)); }
      catch (caught) { return failure(caught); }
    }

    if (pathname === "/api/providers/catalog" && request.method === "GET") {
      try {
        return json(core.catalog.presets);
      } catch (caught) {
        return failure(caught);
      }
    }

    if (pathname === "/api/providers/quota" && request.method === "GET") {
      try {
        return json(await quotas.read(url.searchParams.get("refresh") === "1") satisfies ProviderQuota[]);
      } catch (caught) {
        return failure(caught);
      }
    }

    if (pathname === "/api/skills" && request.method === "GET") {
      try {
        if (!skills) throw new CommandError("unavailable", "skill folders are not configured");
        return json({ skills: skills.catalog() } satisfies SkillCatalog);
      } catch (caught) {
        return failure(caught);
      }
    }

    if (pathname.startsWith("/api/orchestration/")) {
      // Ghost can use delegation, but policy and omp import are owner/device HTTP operations only.
      if (fetchSite === "cross-site" || (viaEdge && fetchSite === "same-site")) return error("forbidden", "다른 사이트에서는 오케스트레이션을 변경할 수 없습니다.", 403);
      try { return json(await serveOrchestration(request, pathname, core)); }
      catch (caught) { return failure(caught); }
    }

    if (pathname.startsWith("/api/pi/")) {
      if (fetchSite === "cross-site" || (viaEdge && fetchSite === "same-site")) return error("forbidden", "다른 사이트에서는 코딩 설정을 변경할 수 없습니다.", 403);
      try {
        const sessions = core.codingSessions;
        if (!(sessions instanceof CodingSessions)) throw new CommandError("unavailable", "이 Host에서는 내장 코딩을 사용할 수 없습니다.");
        const body = (): Promise<unknown> => request.json().catch(() => { throw invalid("malformed JSON body"); });
        const method = request.method;
        // Package management can execute arbitrary code as the Host. Only the owner
        // principal can grant it; these effects are not registered as Ghost tools.
        const manage = () => {
          if (!access.isOwner) throw new CommandError("forbidden", "Pi 패키지는 소유자만 변경할 수 있습니다.");
        };
        if (pathname === "/api/pi/settings") {
          if (method === "GET") return json({ settings: sessions.piConfig.defaults(), canManagePackages: access.isOwner,
            imageResizeAvailable: sessions.piConfig.imageResizeAvailable });
          if (method === "PUT") return json(await sessions.savePiSettings(parse(PiSettings, await body())));
        }
        if (pathname === "/api/pi/packages") {
          if (method === "GET") return json(sessions.piExtensions.list());
          if (method === "POST") {
            manage();
            return json(await sessions.piExtensions.install(parse(PiInstall, await body())), 201);
          }
        }
        const pkg = /^\/api\/pi\/packages\/([A-Za-z0-9-]+)$/.exec(pathname);
        if (pkg) {
          if (method === "PUT") {
            manage();
            return json(sessions.piExtensions.setFlags(pkg[1]!, parse(PiPackageFlags, await body())));
          }
          if (method === "DELETE") {
            manage();
            await sessions.piExtensions.remove(pkg[1]!);
            return json({ ok: true });
          }
        }
        const session = /^\/api\/pi\/sessions\/([A-Za-z0-9-]+)(?:\/(compact|packages)(?:\/([A-Za-z0-9-]+))?)?$/.exec(pathname);
        if (session) {
          const [, id, action, packageId] = session;
          if (!action && method === "GET") return json({ ...sessions.piSession(id!), canManagePackages: access.isOwner });
          if (!action && method === "PUT") return json({ ...await sessions.setPiSession(id!, parse(PiSessionConfigUpdate, await body()).overrides), canManagePackages: access.isOwner });
          if (action === "compact" && !packageId && method === "POST") return json({ ...await sessions.compactPiSession(id!), canManagePackages: access.isOwner });
          if (action === "packages" && packageId && method === "PUT") {
            manage();
            return json(await sessions.setPiSessionPackage(id!, packageId, parse(PiPackageOverrides, await body())));
          }
        }
        throw notFound("Pi 설정 경로를 찾을 수 없습니다.");
      } catch (caught) { return failure(caught); }
    }

    const codingRoute = /^\/api\/coding\/sessions\/([^/]+)(?:\/(items|events|prompt|abort|close|changes|file|dialogs)(?:\/([^/]+))?)?$/.exec(pathname);
    if (codingRoute || pathname === "/api/coding/sessions" || pathname === "/api/coding/models") {
      if (fetchSite === "cross-site" || (viaEdge && fetchSite === "same-site")) return error("forbidden", "다른 사이트에서는 코딩 세션을 열 수 없습니다.", 403);
      try {
        const sessions = core.codingSessions;
        if (!sessions) throw new CommandError("unavailable", "embedded coding is not available on this Host");
        const body = (): Promise<unknown> => request.json().catch(() => { throw invalid("malformed JSON body"); });
        const method = request.method;
        if (pathname === "/api/coding/models" && method === "GET") {
          core.codexCatalog.sync();
          return json({ models: new CodingModels({ settings: () => core.ledger.settings(), secrets: core.secrets, catalog: core.catalog }).list() });
        }
        if (pathname === "/api/coding/sessions") {
          if (method === "GET") return json(sessions.list());
          if (method === "POST") return json(await sessions.create(parse(CodingSessionCreate, await body()), { kind: "owner" }), 201);
        }
        if (!codingRoute) throw notFound("coding route not found");
        const decode = (value: string): string => {
          try { return decodeURIComponent(value); } catch { throw invalid("invalid coding route ID"); }
        };
        const [, rawId, action, rawDialog] = codingRoute;
        const id = parse(Id, decode(rawId!));
        const session = sessions.get(id);
        if (!session) throw notFound("coding session not found");
        if (!action && method === "GET") return json(session);
        if (!action && method === "PATCH") {
          const patch = parse(Type.Object({
            title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
            model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) })),
            thinking: Type.Optional(CodingThinking),
          }, { additionalProperties: false }), await body());
          return json(await sessions.rename(id, patch));
        }
        if (action === "dialogs" && rawDialog && method === "POST") {
          await sessions.answer(id, parse(Id, decode(rawDialog)), parse(CodingDialogAnswer, await body()));
          return json({ ok: true });
        }
        if (rawDialog) throw notFound("coding route not found");
        if (action === "items" && method === "GET") {
          const after = url.searchParams.get("after") ?? undefined;
          const rawLimit = url.searchParams.get("limit") ?? "100";
          if (!/^(?:[1-9]\d?|100)$/.test(rawLimit)) throw invalid("coding item limit must be 1–100");
          return json({ items: sessions.items(id, { after, limit: Number(rawLimit) }) });
        }
        if (action === "changes" && method === "GET") return json(await sessions.changes(id));
        if (action === "file" && method === "GET") {
          const file = sessions.file(id, url.searchParams.get("path") ?? "");
          if (!file) throw notFound("coding file not found");
          let bytes: Buffer;
          try { bytes = readCodingFile(file.path, 32 * 1024 * 1024); } catch { throw notFound("coding file not found"); }
          return new Response(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) as Uint8Array<ArrayBuffer>, { headers: {
            "content-type": file.mimeType || "application/octet-stream",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
          } });
        }
        if (action === "events" && method === "GET") {
          const encoder = new TextEncoder();
          let unsubscribe: (() => void) | undefined;
          let pings: ReturnType<typeof setInterval> | undefined;
          let closed = false;
          let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
          const stop = () => {
            if (closed) return;
            closed = true;
            request.signal.removeEventListener("abort", stop);
            unsubscribe?.();
            clearInterval(pings);
            try { controller?.close(); } catch { /* disconnected */ }
          };
          const enqueue = (line: string) => {
            if (closed) return;
            try { controller?.enqueue(encoder.encode(line)); } catch { stop(); }
          };
          const send = (event: CodingEvent) => enqueue(`data: ${JSON.stringify(event)}\n\n`);
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              if (request.signal.aborted) { stop(); return; }
              send({ type: "session", session });
              unsubscribe = sessions.subscribe(id, send);
              pings = setInterval(() => enqueue(": keepalive\n\n"), 15_000);
              request.signal.addEventListener("abort", stop, { once: true });
            },
            cancel: stop,
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
        }
        if (action === "prompt" && method === "POST") return json(await sessions.prompt(id, parse(CodingPrompt, await body())));
        if ((action === "abort" || action === "close") && method === "POST") {
          if (action === "abort") await sessions.abort(id);
          else await sessions.close(id);
          return json(sessions.get(id));
        }
        throw notFound("coding route not found");
      } catch (caught) {
        return failure(caught);
      }
    }

    const providerOAuth = /^\/api\/providers\/([a-z0-9][a-z0-9_-]{0,63})\/oauth$/.exec(pathname);
    if (providerOAuth !== null) {
      try {
        const id = providerOAuth[1]!;
        if (request.method === "POST") return json(oauth.start(id));
        if (request.method === "GET") return json(oauth.status(id));
        if (request.method === "DELETE") return json(oauth.cancel(id));
        return error("invalid", "use GET, POST or DELETE", 405);
      } catch (caught) {
        return failure(caught);
      }
    }

    const providerOAuthCode = /^\/api\/providers\/([a-z0-9][a-z0-9_-]{0,63})\/oauth\/code$/.exec(pathname);
    if (providerOAuthCode !== null) {
      try {
        if (request.method !== "POST") return error("invalid", "use POST", 405);
        const body = await request.json() as { code?: unknown };
        if (typeof body.code !== "string" || body.code.trim().length === 0) return error("invalid", "code is required", 400);
        return json(oauth.submitCode(providerOAuthCode[1]!, body.code));
      } catch (caught) {
        return failure(caught);
      }
    }

    const work = /^\/api\/works\/([^/]+)$/.exec(pathname);
    if (work !== null && request.method === "GET") {
      try {
        return json(workDetail(core, decodeURIComponent(work[1]!)));
      } catch (caught) {
        return failure(caught);
      }
    }
    const conversation = /^\/api\/conversations\/([^/]+)$/.exec(pathname);
    if (conversation !== null && request.method === "GET") {
      try {
        return await serveConversation(decodeURIComponent(conversation[1]!), url);
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/suggestions" && request.method === "GET") {
      try {
        const id = parse(Id, url.searchParams.get("conversation"));
        return json(await suggestions.direct(id, request.signal) satisfies NextMessageSuggestions);
      } catch (caught) {
        return failure(caught);
      }
    }
    const artifact = /^\/api\/artifacts\/([^/]+)$/.exec(pathname);
    if (artifact !== null && request.method === "GET") {
      try {
        return await serveArtifact(decodeURIComponent(artifact[1]!));
      } catch (caught) {
        return failure(caught);
      }
    }
    const pages = /^\/api\/scopes\/([^/]+)\/pages(?:\/([^/]+))?$/.exec(pathname);
    if (pages !== null && request.method === "GET") {
      try {
        if (!documents) throw new CommandError("unavailable", "document scopes are not available");
        const scopeId = decodeURIComponent(pages[1]!);
        core.ledger.scope(scopeId);
        if (pages[2] === undefined) {
          const list = await documents.listPages(scopeId, url.searchParams.get("query"));
          return json(list satisfies PageSummary[]);
        }
        const { pageId, locator, title, profile, body, hash } = await documents.readPage(scopeId, { pageId: decodeURIComponent(pages[2]) });
        return json({ pageId, locator, title, profile, body, hash } satisfies PageView);
      } catch (caught) {
        return failure(caught);
      }
    }
    return error("not_found", "not found", 404);
  }

  return {
    port: server.port!, // a TCP listener always reports its bound port
    stop: async () => {
      suggestions.close();
      oauth.close();
      connectionOAuth.close();
      core.activitySources?.setOAuthRefresher?.(null);
      server.stop(true);
    },
  };
}
