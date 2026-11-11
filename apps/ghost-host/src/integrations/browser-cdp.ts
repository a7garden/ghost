import { CommandError } from "../core/errors.ts";

export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId?: string }
export interface CdpDisconnect {
  cause: "host-close" | "controller-ack" | "socket-close" | "socket-error" | "socket-not-open" | "protocol-nontext" | "protocol-oversized" | "protocol-json";
  stage: "host" | "receive" | "command" | "idle";
  closeCode?: number;
}
interface Pending {
  method: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Private loopback transport. Neither protocol payloads nor browser errors are logged or forwarded. */
export class BrowserCdp {
  private serial = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly disconnects = new Set<(reason: CdpDisconnect) => void>();
  private terminalError?: CommandError;
  private constructor(private readonly socket: WebSocket, maxMessageLength: number) {
    socket.onmessage = (message) => {
      if (typeof message.data !== "string") { this.fail("protocol-nontext"); this.socket.close(); return; }
      if (message.data.length > maxMessageLength) { this.fail("protocol-oversized"); this.socket.close(); return; }
      let value: Record<string, unknown>;
      try { value = JSON.parse(message.data); } catch { this.fail("protocol-json"); this.socket.close(); return; }
      if (!value || typeof value !== "object") return;
      if (typeof value.id === "number") {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        this.pending.delete(value.id); clearTimeout(pending.timer);
        if (value.error || !value.result || typeof value.result !== "object" || Array.isArray(value.result)) pending.reject(new CommandError("unavailable", `Private browser command failed (${pending.method})`));
        else pending.resolve(value.result as Record<string, unknown>);
      } else if (typeof value.method === "string" && value.params && typeof value.params === "object" && !Array.isArray(value.params)) {
        const event: CdpEvent = { method: value.method, params: value.params as Record<string, unknown>, ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}) };
        for (const listener of this.listeners) listener(event);
      }
    };
    socket.onclose = event => this.fail("socket-close",event.code);
    socket.onerror = () => this.fail("socket-error");
  }
  static async connect(endpoint: string, options?: { imageResponses?: boolean }): Promise<BrowserCdp> {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new CommandError("unavailable", "Invalid private browser endpoint"); }
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port || !/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new CommandError("unavailable", "Invalid private browser endpoint");
    const socket = new WebSocket(url.href);
    const ready = Promise.withResolvers<BrowserCdp>();
    const timer = setTimeout(() => { socket.close(); ready.reject(new CommandError("unavailable", "Private browser connection timed out")); }, 5000);
    socket.onopen = () => { clearTimeout(timer); ready.resolve(new BrowserCdp(socket, options?.imageResponses ? 12 * 1024 * 1024 : 1024 * 1024)); };
    socket.onerror = socket.onclose = () => { clearTimeout(timer); ready.reject(new CommandError("unavailable", "Private browser connection failed")); };
    return ready.promise;
  }
  onEvent(listener: (event: CdpEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onDisconnect(listener: (reason: CdpDisconnect) => void) { this.disconnects.add(listener); return () => this.disconnects.delete(listener); }
  request(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.socket.readyState !== WebSocket.OPEN) { this.fail("socket-not-open"); return Promise.reject(this.terminalError); }
    const id = ++this.serial, result = Promise.withResolvers<Record<string, unknown>>();
    const timer = setTimeout(() => { this.pending.delete(id); result.reject(new CommandError("unavailable", "Private browser command timed out")); }, 5000);
    this.pending.set(id, { ...result, timer, method });
    try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch { clearTimeout(timer); this.pending.delete(id); result.reject(new CommandError("unavailable", "Private browser command failed")); }
    return result.promise;
  }
  private fail(cause: CdpDisconnect["cause"], closeCode?: number) {
    if (this.terminalError) return;
    const reason: CdpDisconnect = {
      cause,
      stage:cause === "host-close" ? "host" : cause === "controller-ack" ? "command" : cause.startsWith("protocol-") ? "receive" : this.pending.size ? "command" : "idle",
      ...(typeof closeCode === "number" && Number.isInteger(closeCode) && closeCode >= 1000 && closeCode <= 4999 ? {closeCode} : {}),
    };
    // Only fixed classifications/numeric protocol codes survive. Never retain or
    // forward close reasons, socket errors, URLs, command args or received bytes.
    this.terminalError = new CommandError("unavailable",`Private browser connection ended (${reason.cause}; ${reason.stage}${reason.closeCode === undefined ? "" : `; ${reason.closeCode}`})`);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.terminalError); }
    this.pending.clear(); this.listeners.clear();
    for (const listener of this.disconnects) listener(reason);
    this.disconnects.clear();
  }
  close(cause: "host-close" | "controller-ack" = "host-close") { this.fail(cause); this.socket.close(); }
}
