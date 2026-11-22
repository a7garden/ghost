import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  ArtifactRef,
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
  type CodingSetup,
  type HerdrChanges,
  type HerdrDiff,
  type HerdrFrame,
  type HerdrOutput,
  type HerdrUpload,
  type OmpInfo,
  type HerdrPaneView,
  type HerdrView,
  CodingStart,
  HerdrAgentStart,
  HerdrClose,
  HerdrInput,
  HerdrIntegrationInstall,
  HerdrPrompt,
  HerdrRename,
  HerdrSplit,
  HerdrTabCreate,
  HerdrWorkspaceCreate,
  type SkillCatalog,
  parse,
} from "@ghost/contract";
import type { Config } from "../config.ts";
import type { BrowserPort, DocumentsPort, HerdrPort, SkillsPort } from "../integrations/ports.ts";
import { mergeFrames } from "../integrations/herdr.ts";
import type { OmpInfoProvider } from "../integrations/omp.ts";
import { saveUpload, UPLOAD_MAX_BYTES } from "../integrations/uploads.ts";
import { PairingLimiter } from "./pairing-limit.ts";
import { OAuthLogins } from "./oauth.ts";
import { ConnectionOAuth } from "./connection-oauth.ts";
import { CloudflareAccessVerifier } from "./cloudflare-access.ts";
import { Access } from "../core/access.ts";
import { execute, hashSecret } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { CommandError, invalid, notFound } from "../core/errors.ts";
import { newId } from "../core/ids.ts";
import { HOST_VERSION, snapshot, workDetail } from "../core/state.ts";
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

export function startServer(deps: { core: Core; config: Config; ownerToken: string; documents: DocumentsPort | null; skills: SkillsPort | null; herdr?: HerdrPort | null; omp?: OmpInfoProvider | null; vault?: Vault | null; browser?: BrowserPort | null; mail?: MailService | null; updater?: Updater | null; memory?: MemoryStore | null; memoryDreams?: { request(ghostId: string): void } | null }): { port: number; stop(): Promise<void> } {
  const { core, config, ownerToken, documents, skills, herdr = null, omp = null, vault = null, browser = null, updater = null, memory = null, memoryDreams = null } = deps;
  const ownerHash = Buffer.from(hashSecret(ownerToken));
  const pairingLimiter = new PairingLimiter(10, 30);
  const oauth = new OAuthLogins(core);

  const server: Bun.Server<undefined> = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Bun closes connections idle for 10 s by default; the SSE keepalive is every 15 s.
    idleTimeout: 60,
    fetch: (request, bound) => handle(request, bound),
  });

  const loopbackHosts = new Set([`127.0.0.1:${server.port}`, `localhost:${server.port}`, `[::1]:${server.port}`]);
  const allowedHosts = new Set(loopbackHosts);
  const publicOrigin = config.publicOrigin ?? `http://${config.host}:${server.port}`;
  try {
    allowedHosts.add(new URL(publicOrigin).host.toLowerCase());
  } catch {
    core.log("invalid publicOrigin; only loopback hosts are accepted", publicOrigin);
  }
  const edge = config.cloudflareAccess ? new CloudflareAccessVerifier(config.cloudflareAccess, fetch, Date.now, core.log) : null;
  if (edge !== null) allowedHosts.add(edge.host);
  const connectionOAuth = new ConnectionOAuth(core, { root: config.root, publicOrigin });
  core.activitySources?.setOAuthRefresher?.(connection => connectionOAuth.refresh(connection));

  function failure(caught: unknown): Response {
    if (caught instanceof CommandError) return error(caught.code, caught.message, HTTP_STATUS[caught.code]);
    if (caught instanceof ContractError) return error("invalid", caught.message, 400);
    if (caught instanceof NotFound) return error("not_found", caught.message, 404);
    core.log("request failed", caught);
    return error("internal", "internal error", 500);
  }

  function authenticate(request: Request): Access | null {
    const header = request.headers.get("authorization");
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

  async function handle(request: Request, bound: Bun.Server<undefined>): Promise<Response> {
    // DNS rebinding: only loopback and the public origin may talk to this server.
    const host = (request.headers.get("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) return error("forbidden", "untrusted host", 403);
    // The Access web origin admits nothing, UI included, without a verified Access session; that session is the owner.
    const viaEdge = edge !== null && host === edge.host;
    if (viaEdge && (await edge.verify(request)) === null) return error("forbidden", "Cloudflare Access login required", 401);
    const peer = bound.requestIP(request);
    const injectToken = loopbackHosts.has(host) && peer !== null && isLoopbackAddress(peer.address);

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

    const access = viaEdge ? new Access({ kind: "owner" }) : authenticate(request);
    if (access === null) return error("forbidden", "missing or invalid bearer token", 401);
    if (pathname.startsWith("/api/connection-oauth/")) {
      try { return await connectionOAuth.handle(request, url, access) ?? error("not_found", "not found", 404); }
      catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/update" || pathname.startsWith("/api/update/")) {
      try { return await serveUpdate(request, url, updater); } catch (caught) { return failure(caught); }
    }
    if (pathname === "/api/vault" || pathname.startsWith("/api/vault/")) return serveVault(request, url, core, vault);
    if (pathname.startsWith("/api/browser/")) return serveBrowser(request, url, core, browser, () => viaEdge || authenticate(request) !== null);
    if (pathname.startsWith("/api/mail/")) return serveMail(request, url, deps.mail ?? null);
    if (pathname.startsWith("/api/memory/")) {
      try {
        return await serveMemory(request, url, core, memory, memoryDreams, access);
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

    if (pathname === "/api/providers/catalog" && request.method === "GET") {
      try {
        return json(core.catalog.presets);
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

    // Coding is the owner's herdr. What must be set up for it, the agents in the session in use, one pane's terminal text, and the few things
    // the owner does from the app: start an agent in a new workspace, send it a prompt or keys, install herdr's hook for an agent.
    if (pathname === "/api/coding" && request.method === "GET") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        return json(await herdr.setup() satisfies CodingSetup);
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/coding/integrations" && request.method === "POST") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        const body: unknown = await request.json().catch(() => { throw invalid("malformed JSON body"); });
        await herdr.installIntegration(parse(HerdrIntegrationInstall, body).agent);
        return json(await herdr.setup() satisfies CodingSetup);
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/herdr" && request.method === "GET") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        return json(await herdr.overview() satisfies HerdrView);
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/herdr/output" && request.method === "GET") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        const lines = url.searchParams.get("lines");
        return json(await herdr.output(url.searchParams.get("pane") ?? "", { ansi: url.searchParams.get("format") === "ansi", ...(lines === null ? {} : { lines: Number(lines) }) }) satisfies HerdrOutput);
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/herdr/changes" && request.method === "GET") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        return json(await herdr.changes(url.searchParams.get("pane") ?? "") satisfies HerdrChanges);
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname === "/api/herdr/diff" && request.method === "GET") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        return json(await herdr.diff(url.searchParams.get("pane") ?? "", url.searchParams.get("path") ?? "") satisfies HerdrDiff);
      } catch (caught) {
        return failure(caught);
      }
    }
    // What omp offers for starting a session in a directory: its models and that directory's recent conversations.
    if (pathname === "/api/coding/omp" && request.method === "GET") {
      try {
        if (!omp) throw new CommandError("unavailable", "omp is not available on this Host");
        return json(await omp.info(url.searchParams.get("cwd") ?? "") satisfies OmpInfo);
      } catch (caught) {
        return failure(caught);
      }
    }
    // A file from the app (a phone screenshot) saved on the Mac for an agent to read by path; the body is the file's bytes.
    if (pathname === "/api/herdr/upload" && request.method === "POST") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        if (Number(request.headers.get("content-length") ?? 0) > UPLOAD_MAX_BYTES) throw invalid("the file is larger than 10 MB");
        return json(saveUpload(config.root, url.searchParams.get("name") ?? "file", new Uint8Array(await request.arrayBuffer())) satisfies HerdrUpload);
      } catch (caught) {
        return failure(caught);
      }
    }
    // The owner's herdr, from the app: the live terminal of a pane and its keyboard, and creating, renaming and closing workspaces, tabs, panes and agents.
    if (pathname === "/api/herdr/terminal" && request.method === "GET") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        const cols = Number(url.searchParams.get("cols") ?? 80), rows = Number(url.searchParams.get("rows") ?? 24);
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) throw invalid("cols and rows must be numbers");
        const abort = new AbortController();
        request.signal.addEventListener("abort", () => abort.abort(), { once: true });
        const frames = await herdr.terminal(url.searchParams.get("pane") ?? "", cols, rows, abort.signal);
        const encoder = new TextEncoder();
        let keepalive: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => { try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* the viewer is gone */ } };
            keepalive = setInterval(() => { try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* the viewer is gone */ } }, 15_000);
            // Output that arrives within 40 ms goes out as one frame: a busy agent redraws many times a second and a phone does not need every step.
            let pending: HerdrFrame | null = null;
            let flushTimer: ReturnType<typeof setTimeout> | undefined;
            const flush = () => { flushTimer = undefined; if (pending !== null) { send("frame", pending); pending = null; } };
            try {
              for await (const frame of frames) {
                pending = mergeFrames(pending, frame);
                flushTimer ??= setTimeout(flush, 40);
              }
              clearTimeout(flushTimer);
              flush();
              send("end", {});
            } catch (caught) {
              clearTimeout(flushTimer);
              flush();
              send("error", { message: caught instanceof Error ? caught.message : "the terminal stopped" });
            } finally {
              clearTimeout(flushTimer);
              clearInterval(keepalive);
              try { controller.close(); } catch { /* already closed */ }
            }
          },
          cancel() {
            clearInterval(keepalive);
            abort.abort();
            void frames.return(undefined);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      } catch (caught) {
        return failure(caught);
      }
    }
    if (pathname.startsWith("/api/herdr/") && request.method === "POST") {
      try {
        if (!herdr) throw new CommandError("unavailable", "herdr is not available on this Host");
        const body: unknown = await request.json().catch(() => { throw invalid("malformed JSON body"); });
        switch (pathname) {
          case "/api/herdr/start":
            return json((await herdr.start(parse(CodingStart, body))).pane satisfies HerdrPaneView);
          case "/api/herdr/workspaces":
            return json(await herdr.createWorkspace(parse(HerdrWorkspaceCreate, body)) satisfies HerdrPaneView);
          case "/api/herdr/tabs":
            return json(await herdr.createTab(parse(HerdrTabCreate, body)) satisfies HerdrPaneView);
          case "/api/herdr/split":
            return json(await herdr.split(parse(HerdrSplit, body)) satisfies HerdrPaneView);
          case "/api/herdr/agents":
            return json(await herdr.startAgent(parse(HerdrAgentStart, body)) satisfies HerdrPaneView);
          case "/api/herdr/prompt": {
            const prompt = parse(HerdrPrompt, body);
            return json((await herdr.prompt(prompt.pane, prompt.text)).pane satisfies HerdrPaneView);
          }
          case "/api/herdr/input":
            await herdr.input(parse(HerdrInput, body));
            return json({ ok: true });
          case "/api/herdr/rename":
            await herdr.rename(parse(HerdrRename, body));
            return json({ ok: true });
          case "/api/herdr/close":
            await herdr.close(parse(HerdrClose, body));
            return json({ ok: true });
        }
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
      oauth.close();
      connectionOAuth.close();
      core.activitySources?.setOAuthRefresher?.(null);
      server.stop(true);
    },
  };
}
