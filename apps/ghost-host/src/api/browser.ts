import type { Core } from "../core/core.ts";
import { CommandError, invalid, notFound } from "../core/errors.ts";
import type { BrowserLiveInput, BrowserPort } from "../integrations/ports.ts";
import { assertFetchableUrl } from "../integrations/netguard.ts";

const MAX_BODY = 16 * 1024;
/** Exact owner-input grammar; no arbitrary CDP commands or evaluation. */
export function parseInput(value: unknown): BrowserLiveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid browser input");
  const a = value as Record<string, unknown>;
  const only = (...keys: string[]) => { if (Object.keys(a).some((key) => !keys.includes(key))) throw invalid("invalid browser input"); };
  const number = (v: unknown, min: number, max: number, integer = false) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v));
  const optional = (key: string, min: number, max: number, integer = false) => a[key] === undefined || number(a[key], min, max, integer);
  switch (a.type) {
    case "mouse":
      only("type", "event", "x", "y", "button", "clickCount", "deltaX", "deltaY", "modifiers");
      if (!["down", "up", "move", "wheel"].includes(String(a.event)) || !number(a.x, 0, 1_000_000) || !number(a.y, 0, 1_000_000) || (a.button !== undefined && !["left", "middle", "right", "none"].includes(String(a.button))) || !optional("clickCount", 1, 3, true) || !optional("deltaX", -10000, 10000) || !optional("deltaY", -10000, 10000) || !optional("modifiers", 0, 15, true)) throw invalid("invalid mouse input");
      return a as BrowserLiveInput;
    case "key": {
      only("type", "event", "key", "code", "text", "keyCode", "modifiers");
      const key = (v: unknown, min: number) => typeof v === "string" && v.length >= min && v.length <= 32 && (/^[A-Za-z0-9 _+\-]*$/.test(v) || (Array.from(v).length === 1 && !/[\p{Cc}\p{Cs}]/u.test(v)));
      if (!["down", "up"].includes(String(a.event)) || !key(a.key, 1) || !key(a.code, 0) || (a.text !== undefined && (typeof a.text !== "string" || Array.from(a.text).length < 1 || Array.from(a.text).length > 8 || /[\p{Cc}\p{Cs}]/u.test(a.text))) || !optional("keyCode", 0, 255, true) || !optional("modifiers", 0, 15, true)) throw invalid("invalid keyboard input");
      return a as BrowserLiveInput;
    }
    case "text":
      only("type", "text");
      if (typeof a.text !== "string" || !a.text.length || a.text.length > 2000 || a.text.includes("\0")) throw invalid("text must be 1–2000 characters");
      return { type: "text", text: a.text };
    case "viewport":
      only("type", "width", "height");
      if (!number(a.width, 320, 2560, true) || !number(a.height, 240, 1600, true)) throw invalid("invalid viewport size");
      return { type: "viewport", width: a.width as number, height: a.height as number };
    case "navigate":
      only("type", "action");
      if (a.action !== "back" && a.action !== "forward" && a.action !== "reload") throw invalid("invalid navigation");
      return { type: "navigate", action: a.action };
    default: throw invalid("invalid browser input");
  }
}
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw invalid("missing browser input");
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > MAX_BODY) { await reader.cancel(); throw invalid("browser request body is too large"); } chunks.push(next.value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalid("invalid browser JSON body"); }
}
/** Authentication is enforced by server.ts, including for paired owner-equivalent devices. */
export async function serveBrowser(request: Request, url: URL, core: Core, browser: BrowserPort | null, isAuthorized?: () => boolean): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (!browser) throw new CommandError("unavailable", "the browser is not configured");
    const sessions = browser.sessions();
    if (url.pathname === "/api/browser/sessions" && request.method === "GET") return json({ sessions: sessions.map((s) => ({ ...s, handoffDecisionId: core.ledger.pendingDecisions().find((d) => d.conversationId === s.conversationId && d.kind === "question" && d.proposal?.browserHandoff)?.id ?? null })) });
    const match = /^\/api\/browser\/sessions\/([^/]{1,128})\/(live|input|window)$/.exec(url.pathname);
    if (!match) throw notFound("browser route not found");
    let id: string; try { id = decodeURIComponent(match[1]!); } catch { throw invalid("invalid conversation id"); }
    const session = sessions.find((s) => s.conversationId === id);
    if (!session) throw notFound("browser session not found");
    if (match[2] === "live" && request.method === "GET") {
      const raw = url.searchParams.get("fps") ?? "8";
      if (!/^(?:[1-9]|1[0-5])$/.test(raw)) throw invalid("fps must be 1–15");
      let stop: (() => void) | undefined; let closed = false;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let pendingFrame: Uint8Array | undefined, pendingPage: Uint8Array | undefined;
      const encoder = new TextEncoder();
      const close = () => {
        if (closed) return;
        closed = true; stop?.(); pendingFrame = pendingPage = undefined;
        request.signal.removeEventListener("abort", close); controller.close();
      };
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        pull() {
          if (closed) return;
          if (isAuthorized && !isAuthorized()) { close(); return; }
          if (pendingPage) { controller.enqueue(pendingPage); pendingPage = undefined; }
          else if (pendingFrame) { controller.enqueue(pendingFrame); pendingFrame = undefined; }
        },
        cancel() {
          closed = true; stop?.(); pendingFrame = pendingPage = undefined;
          request.signal.removeEventListener("abort", close);
        },
      });
      request.signal.addEventListener("abort", close, { once: true });
      if (request.signal.aborted) close();
      try {
        if (!closed) stop = await browser.live(session, { maxFps: Number(raw) }, (event) => {
          if (closed) return;
          if (isAuthorized && !isAuthorized()) { close(); return; }
          if (event.type === "end" && (event.reason === "engine_changed" || event.reason === "renderer_changed")) { close(); return; }
          const line = encoder.encode(JSON.stringify(event) + "\n");
          if (event.type === "end") { controller.enqueue(line); close(); return; }
          if ((controller.desiredSize ?? 0) > 0) controller.enqueue(line);
          else if (event.type === "frame") pendingFrame = line;
          else pendingPage = line;
        });
        if (closed) stop?.();
      } catch (error) { close(); throw error; }
      return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
    }
    if (match[2] === "input" && request.method === "POST") { await browser.input(session, parseInput(await body(request))); return json({ ok: true }); }
    if (match[2] === "window" && request.method === "POST") {
      const current = await browser.run(session, ["get", "url"]);
      const raw = typeof current.data === "string" ? current.data : current.data && typeof current.data === "object" && "url" in current.data ? current.data.url : null;
      let target: string | null = null;
      if (typeof raw === "string" && raw !== "about:blank" && !raw.includes("[redacted]")) target = (await assertFetchableUrl(raw, "page url")).href;
      await browser.handoff(session, target); return json({ ok: true });
    }
    throw notFound("browser route not found");
  } catch (error) {
    if (error instanceof CommandError) return json({ ok: false, error: { code: error.code, message: error.message } }, { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 }[error.code]);
    return json({ ok: false, error: { code: "internal", message: "browser request failed" } }, 500);
  }
}
