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
  type SkillCatalog,
  parse,
} from "@ghost/contract";
import type { Config } from "../config.ts";
import type { BrowserPort, DocumentsPort, SkillsPort } from "../integrations/ports.ts";
import { PairingLimiter } from "./pairing-limit.ts";
import { OAuthLogins } from "./oauth.ts";
import { Access } from "../core/access.ts";
import { execute, hashSecret } from "../core/commands.ts";
import type { Core } from "../core/core.ts";
import { CommandError, notFound } from "../core/errors.ts";
import { newId } from "../core/ids.ts";
import { HOST_VERSION, snapshot, workDetail } from "../core/state.ts";
import { NotFound } from "../ledger/ledger.ts";
import type { Vault } from "../stores/vault.ts";
import { serveVault } from "./vault.ts";
import { serveBrowser } from "./browser.ts";

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
  | { type: "schedule" | "schedule.removed" | "space" | "space.removed" | "settings" | "sandbox" | "activity" | "activity_run" | "connection" | "connection.removed" }
  | { type: "avatar" | "avatar.removed" }
  | { type: "device"; device: Device }
  | { type: "device.removed"; id: string };

export function startServer(deps: { core: Core; config: Config; ownerToken: string; documents: DocumentsPort | null; skills: SkillsPort | null; vault?: Vault | null; browser?: BrowserPort | null }): { port: number; stop(): Promise<void> } {
  const { core, config, ownerToken, documents, skills, vault = null, browser = null } = deps;
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
      const result = await execute(core, access, commandRequest, { publicOrigin, documents });
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
    const peer = bound.requestIP(request);
    const injectToken = loopbackHosts.has(host) && peer !== null && isLoopbackAddress(peer.address);

    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/api/health" && request.method === "GET") return json({ ok: true, version: HOST_VERSION });
    if (pathname === "/api/pairing/claim" && request.method === "POST") {
      return claimPairing(request, peer === null ? "unknown" : peer.address);
    }
    if (!pathname.startsWith("/api/")) {
      try {
        return await serveUi(request, url, injectToken);
      } catch (caught) {
        return failure(caught);
      }
    }

    const access = authenticate(request);
    if (access === null) return error("forbidden", "missing or invalid bearer token", 401);
    if (pathname === "/api/vault" || pathname.startsWith("/api/vault/")) return serveVault(request, url, core, vault);
    if (pathname.startsWith("/api/browser/")) return serveBrowser(request, url, core, browser);

    if (pathname === "/api/state" && request.method === "GET") {
      try {
        return json(snapshot(core, access));
      } catch (caught) {
        return failure(caught);
      }
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
    const pages = /^\/api\/spaces\/([^/]+)\/pages(?:\/([^/]+))?$/.exec(pathname);
    if (pages !== null && request.method === "GET") {
      try {
        if (!documents) throw new CommandError("unavailable", "document spaces are not available");
        const spaceId = decodeURIComponent(pages[1]!);
        core.ledger.space(spaceId);
        if (pages[2] === undefined) {
          const list = await documents.listPages(spaceId, url.searchParams.get("query"));
          return json(list satisfies PageSummary[]);
        }
        const { pageId, locator, title, profile, body, hash } = await documents.readPage(spaceId, { pageId: decodeURIComponent(pages[2]) });
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
      server.stop(true);
    },
  };
}
