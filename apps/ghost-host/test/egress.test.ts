import { expect, test } from "bun:test";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { createEgressProxy } from "../src/integrations/egress-proxy.ts";
import { assertFetchableUrl, blockedAddress } from "../src/integrations/netguard.ts";

async function through(proxy: string, path: string, method = "GET") {
  const done = Promise.withResolvers<{ status: number; body: string }>();
  const url = new URL(proxy);
  const req = request({ hostname: url.hostname, port: Number(url.port), method, path }, (res) => {
    let body = ""; res.on("data", (chunk) => { body += chunk; });
    res.on("end", () => done.resolve({ status: res.statusCode!, body }));
  });
  req.on("error", done.reject); req.end();
  return done.promise;
}
async function tunnel(proxy: string, destination: string, payload?: string) {
  const done = Promise.withResolvers<string>();
  const url = new URL(proxy);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  let output = "";
  socket.setTimeout(3000, () => { socket.destroy(); done.reject(new Error("tunnel deadline")); });
  socket.on("connect", () => socket.write(`CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`));
  socket.on("data", (chunk) => {
    output += chunk.toString();
    if (output.includes("403") || output.includes("proxied")) { socket.destroy(); done.resolve(output); }
    else if (payload && output.includes("200 Connection Established")) { socket.write(payload); payload = undefined; }
  });
  socket.on("error", done.reject);
  return done.promise;
}

test("shared guard rejects private compressed IPv6 and all intended IPv4 ranges", async () => {
  for (const ip of ["::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fc00::1", "fe80::123", "172.16.0.1", "172.31.255.255", "100.64.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "0.0.0.0"]) expect(blockedAddress(ip)).toBe(true);
  for (const ip of ["2001:4860:4860::8888", "2001::1", "8.8.8.8", "172.32.0.1", "::ffff:8.8.8.8"]) expect(blockedAddress(ip)).toBe(false);
  for (const url of ["http://[::1]", "http://[::ffff:7f00:1]", "http://172.20.0.1", "http://localhost.", "http://foo.ts.net", "file:///tmp/x"]) await expect(assertFetchableUrl(url, "url")).rejects.toThrow();
});

test("HTTP and CONNECT refuse blocked literals, private DNS and mixed DNS answers", async () => {
  let resolutions = 0;
  const proxy = await createEgressProxy({ resolve: async () => { resolutions++; return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]; } });
  try {
    for (const host of ["127.0.0.1", "192.168.1.1", "localhost", "a.internal", "a.ts.net", "mixed.example"]) {
      expect((await through(proxy.url, `http://${host}/`)).status).toBe(403);
      expect(await tunnel(proxy.url, `${host}:80`)).toContain("403 Forbidden");
    }
    expect((await through(proxy.url, "http://[::1]/")).status).toBe(403);
    expect(await tunnel(proxy.url, "[::1]:443")).toContain("403");
    expect(resolutions).toBe(2);
  } finally { await proxy.close(); }
});

test("allowed HTTP and CONNECT use the checked literal without a second DNS lookup", async () => {
  const server = createServer((req, res) => { res.end(`proxied:${req.url}:${req.headers.host}`); });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
  const address = server.address(); if (!address || typeof address === "string") throw new Error("no address");
  let resolutions = 0;
  const proxy = await createEgressProxy({ resolve: async (host) => { expect(host).toBe("public.example"); resolutions++; return [{ address: "127.0.0.1", family: 4 }]; }, blocked: () => false });
  try {
    const result = await through(proxy.url, `http://public.example:${address.port}/hello?q=1`);
    expect(result.status).toBe(200); expect(result.body).toBe(`proxied:/hello?q=1:public.example:${address.port}`);
    const output = await tunnel(proxy.url, `public.example:${address.port}`, "GET /tunnel HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n");
    expect(output).toContain("proxied:/tunnel:public.example"); expect(resolutions).toBe(2);
  } finally {
    await proxy.close();
    const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise;
  }
});
