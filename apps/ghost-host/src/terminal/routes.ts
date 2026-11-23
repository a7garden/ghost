import { parse, TERMINAL_BEARER_PREFIX, TERMINAL_PROTOCOL, TerminalClientFrame, TerminalCreate, TerminalSize } from "@ghost/contract";
import { CommandError, invalid, notFound } from "../core/errors.ts";
import type { Terminals } from "./index.ts";

const STREAM = /^\/api\/terminals\/([^/]+)\/stream$/;
const RESOURCE = /^\/api\/terminals\/([^/]+)(\/resize)?$/;
const MAX_CONTROL_BYTES = 400_000; // Worst-case JSON escaping for a 65,536-character input frame.

export type TerminalSocket = { service: Terminals; id: string; after: number | undefined; detach?: () => void };

export function terminalStreamBearer(request: Request, pathname: string): string | null {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !STREAM.test(pathname)) return null;
  const offer = protocols(request).find(protocol => protocol.startsWith(TERMINAL_BEARER_PREFIX));
  // The browser cannot supply custom authorization headers; pass the same bearer in the upgrade.
  // Never put it in a URL or echo this offer in the selected-protocol header.
  if (!offer) return null;
  const token = offer.slice(TERMINAL_BEARER_PREFIX.length);
  return /^[a-zA-Z0-9_-]+$/.test(token) ? `Bearer ${token}` : null;
}

function protocols(request: Request): string[] {
  return (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim());
}

async function jsonBody(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw invalid("JSON 요청 본문이 올바르지 않습니다."); }
}

/** Runs after the same bearer/paired-device/Access auth as herdr; it isn't a Ghost tool. */
export async function serveTerminals(request: Request, url: URL, server: Bun.Server<TerminalSocket>, service: Terminals | null, origin: string): Promise<Response | undefined> {
  if (!service) throw new CommandError("unavailable", "터미널을 사용할 수 없습니다.");
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null && requestOrigin !== origin) throw new CommandError("forbidden", "다른 사이트에서는 터미널을 조작할 수 없습니다.");
  if (url.pathname === "/api/terminals") {
    if (request.method === "GET") return Response.json(service.list(), { headers: { "cache-control": "no-store" } });
    if (request.method === "POST") return Response.json({ id: service.create(parse(TerminalCreate, await jsonBody(request))) });
  }
  const stream = STREAM.exec(url.pathname);
  if (stream && request.method === "GET") {
    const id = stream[1]!;
    if (!service.has(id)) throw notFound("터미널을 찾을 수 없습니다.");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw invalid("WebSocket 연결이 필요합니다.");
    const negotiated = protocols(request).includes(TERMINAL_PROTOCOL);
    const cursor = url.searchParams.get("after");
    const after = cursor === null ? undefined : Number(cursor);
    if (after !== undefined && (!/^\d+$/.test(cursor!) || !Number.isSafeInteger(after))) throw invalid("출력 위치가 올바르지 않습니다.");
    if (!server.upgrade(request, {
      data: { service, id, after },
      headers: negotiated ? { "sec-websocket-protocol": TERMINAL_PROTOCOL } : undefined,
    })) throw invalid("WebSocket 연결을 열 수 없습니다.");
    return undefined;
  }
  const resource = RESOURCE.exec(url.pathname);
  if (resource) {
    const [, id, resize] = resource;
    if (resize && request.method === "POST") {
      service.resize(id!, parse(TerminalSize, await jsonBody(request)));
      return Response.json({ ok: true });
    }
    if (!resize && request.method === "DELETE") {
      await service.closeTerminal(id!);
      return Response.json({ ok: true });
    }
  }
  throw notFound("터미널 요청을 찾을 수 없습니다.");
}

export const terminalWebSocket: Bun.WebSocketHandler<TerminalSocket> = {
  maxPayloadLength: MAX_CONTROL_BYTES,
  backpressureLimit: 2 * 1024 * 1024,
  closeOnBackpressureLimit: true,
  sendPings: true,
  idleTimeout: 60,
  open(socket) {
    const { service, id, after } = socket.data;
    if (!service.has(id)) { socket.close(1000); return; }
    socket.data.detach = service.attach(id, after, frame => {
      if (frame instanceof Uint8Array) socket.sendBinary(frame);
      else {
        socket.sendText(JSON.stringify(frame));
        if (frame.type === "exit") socket.close(1000);
      }
    });
  },
  message(socket, message) {
    if (!socket.data.service.has(socket.data.id)) { socket.close(1000); return; }
    try {
      if (typeof message !== "string") throw invalid("JSON 터미널 입력이 필요합니다.");
      const frame = parse(TerminalClientFrame, JSON.parse(message));
      if (frame.type === "input") socket.data.service.input(socket.data.id, frame.data, frame.binary);
      else socket.data.service.resize(socket.data.id, frame);
    } catch { socket.close(1008, "invalid terminal frame"); }
  },
  close(socket) { socket.data.detach?.(); },
};
