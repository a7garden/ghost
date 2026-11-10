import type { Core } from "../core/core.ts";
import { CommandError, conflict, invalid, notFound } from "../core/errors.ts";
import type { BrowserControl, BrowserPort } from "../integrations/ports.ts";
import { assertFetchableUrl } from "../integrations/netguard.ts";

const MAX_BODY = 16 * 1024;
const KEYS = new Set(["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

/** Exactly one owner input; anything else is refused before it reaches the browser. */
export function parseControl(value: unknown): BrowserControl {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("invalid browser input");
  const input = value as Record<string, unknown>;
  const only = (...keys: string[]) => { if (Object.keys(input).some((key) => !keys.includes(key))) throw invalid("invalid browser input"); };
  const fraction = (entry: unknown) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0 && entry <= 1;
  switch (input.type) {
    case "tap":
      only("type", "x", "y");
      if (!fraction(input.x) || !fraction(input.y)) throw invalid("tap needs x and y between 0 and 1");
      return { type: "tap", x: input.x as number, y: input.y as number };
    case "text":
      only("type", "text");
      if (typeof input.text !== "string" || !input.text.length || input.text.length > 2000 || input.text.includes("\0")) throw invalid("text must be 1–2000 characters");
      return { type: "text", text: input.text };
    case "key":
      only("type", "key");
      if (typeof input.key !== "string" || !KEYS.has(input.key)) throw invalid("unsupported key");
      return { type: "key", key: input.key as Extract<BrowserControl, { type: "key" }>["key"] };
    case "scroll":
      only("type", "dy");
      if (typeof input.dy !== "number" || !Number.isFinite(input.dy) || input.dy === 0 || Math.abs(input.dy) > 10_000) throw invalid("scroll needs a non-zero dy");
      return { type: "scroll", dy: input.dy };
    case "navigate":
      only("type", "action");
      if (input.action !== "back" && input.action !== "forward" && input.action !== "reload") throw invalid("unsupported navigation");
      return { type: "navigate", action: input.action };
    default:
      throw invalid("invalid browser input");
  }
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw invalid("browser request body is too large");
  try { return JSON.parse(text); } catch { throw invalid("invalid browser JSON body"); }
}

/**
 * The owner's side of a browser handoff, for every authenticated principal (paired devices are
 * owner-equivalent): a live frame, one input at a time, or opening the same session as a Mac window.
 * Only a pending handoff question reaches its Ghost's session; the Ghost itself is held off by the
 * same pending question until the owner answers.
 */
export async function serveBrowser(request: Request, url: URL, core: Core, browser: BrowserPort | null): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    if (!browser) throw new CommandError("unavailable", "the browser is not configured");
    const match = /^\/api\/browser\/handoffs\/([^/]{1,128})\/(frame|control|window)$/.exec(url.pathname);
    if (!match) throw notFound("browser route not found");
    let id: string;
    try { id = decodeURIComponent(match[1]!); } catch { throw invalid("invalid decision id"); }
    const decision = core.ledger.findDecision(id);
    const handoff = decision?.proposal?.browserHandoff;
    if (!decision || decision.kind !== "question" || !handoff || typeof handoff !== "object") throw notFound("browser handoff not found");
    if (decision.state !== "pending") throw conflict("the browser handoff has ended");
    const session = { ghostId: decision.ghostId, conversationId: decision.conversationId };
    if (match[2] === "frame" && request.method === "GET") return json(await browser.view(session));
    if (match[2] === "control" && request.method === "POST") {
      await browser.control(session, parseControl(await body(request)));
      return json({ ok: true });
    }
    if (match[2] === "window" && request.method === "POST") {
      const current = await browser.run(session, ["get", "url"]);
      const raw = typeof current.data === "string" ? current.data : current.data && typeof current.data === "object" && "url" in current.data ? current.data.url : null;
      let target: string | null = null;
      if (typeof raw === "string" && raw !== "about:blank" && !raw.includes("[redacted]")) {
        try { target = (await assertFetchableUrl(raw, "page url")).href; } catch {}
      }
      await browser.handoff(session, target);
      return json({ ok: true });
    }
    throw notFound("browser route not found");
  } catch (error) {
    if (error instanceof CommandError) {
      const statuses = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unavailable: 503, internal: 500 };
      return json({ ok: false, error: { code: error.code, message: error.message } }, statuses[error.code]);
    }
    return json({ ok: false, error: { code: "internal", message: "browser request failed" } }, 500);
  }
}
