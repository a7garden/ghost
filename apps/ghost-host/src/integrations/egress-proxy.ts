import { lookup } from "node:dns/promises";
import { createServer, request, type OutgoingHttpHeaders } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { BLOCKED_HOSTNAMES, BLOCKED_SUFFIXES, blockedAddress } from "./netguard.ts";

export interface EgressProxy {
  url: string;
  close(): Promise<void>;
}
export interface EgressProxyOptions {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Test seam; production always uses the shared private-address guard. */
  blocked?: (address: string) => boolean;
}

/** Resolves once, checks every answer, and connects only to the checked literal. */
export async function createEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const resolver = options.resolve ?? ((host) => lookup(host, { all: true }));
  const blocked = options.blocked ?? blockedAddress;
  const sockets = new Set<Socket>();
  let closing = false;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(60_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  async function target(url: URL) {
    if (closing || url.username || url.password) throw new Error("refused");
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || BLOCKED_HOSTNAMES[host] || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new Error("refused");
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new Error("DNS deadline")), 5_000);
    const addresses = await Promise.race([
      isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : resolver(host),
      deadline.promise,
    ]).finally(() => clearTimeout(timer));
    if (closing || !addresses.length || addresses.some((a) => !isIP(a.address) || blocked(a.address))) throw new Error("refused");
    const address = addresses[0]!;
    return { host: address.address, family: address.family, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
  }
  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: 10_000, requestTimeout: 30_000 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("refused");
      const checked = await target(url);
      if (res.destroyed) return;
      const headers: OutgoingHttpHeaders = { ...req.headers, host: url.host };
      for (const name of (req.headers.connection ?? "").split(",")) delete headers[name.trim().toLowerCase()];
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      headers.connection = "close";
      const upstream = request({ ...checked, method: req.method, path: url.pathname + url.search, headers, agent: false }, (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      const deadline = setTimeout(() => upstream.destroy(), 10_000);
      upstream.on("socket", (socket) => {
        track(socket);
        socket.once("connect", () => clearTimeout(deadline));
      });
      upstream.on("close", () => clearTimeout(deadline));
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      res.writeHead(403, { "Connection": "close" });
      res.end("Destination refused");
    }
  });
  server.on("connection", track);
  server.on("connect", async (req, client, head) => {
    try {
      const authority = req.url ?? "";
      if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+):\d+$/.test(authority)) throw new Error("refused");
      const url = new URL(`https://${authority}`);
      const checked = await target(url);
      if (client.destroyed) return;
      const upstream = track(connect(checked));
      const timer = setTimeout(() => { upstream.destroy(); client.destroy(); }, 10_000);
      upstream.once("connect", () => {
        clearTimeout(timer);
        if (client.destroyed) { upstream.destroy(); return; }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on("close", () => { clearTimeout(timer); client.destroy(); });
      client.on("close", () => upstream.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}
