import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@ghost/contract";
import { assertMcpUrl, McpClients, type McpCallResult, type McpOptions } from "../src/integrations/mcp.ts";
import { fakeMcpServer } from "./fixtures/mcp-server.ts";

type StdioTransport = Extract<McpServer["transport"], { kind: "stdio" }>;
const FIXTURE = new URL("./fixtures/mcp-server.ts", import.meta.url).pathname;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

function config(transport: McpServer["transport"], extra: Partial<McpServer> = {}): McpServer {
  return { id: "fake", name: "Fake", enabled: true, transport, readTools: ["echo"], createdAt: 0, updatedAt: 0, ...extra };
}
const stdio = (extra: Partial<StdioTransport> = {}): McpServer["transport"] => ({ kind: "stdio", command: process.execPath, args: [FIXTURE], env: [], cwd: null, ...extra });

function clients(server: () => McpServer, options: Partial<McpOptions> = {}): McpClients {
  const mcp = new McpClients({ server: (id) => (server().id === id ? server() : null), ...options });
  cleanup.push(() => mcp.close());
  return mcp;
}
const textOf = (result: McpCallResult) => result.content.map((item) => (item.type === "text" ? item.text : "")).join("");

test("lists every page and classifies tools only by the owner's readTools", async () => {
  const mcp = clients(() => config(stdio({ args: [FIXTURE, "3"] })));
  const tools = await mcp.listTools("fake");
  expect(tools.map((tool) => tool.name)).toEqual(["echo", "wipe", "pid", "argv", "env", "slow", "crash", "big", "mixed", "grow", "fail"]);
  const echo = tools.find((tool) => tool.name === "echo")!;
  const wipe = tools.find((tool) => tool.name === "wipe")!;
  expect(echo.access).toBe("read");
  expect(wipe.access).toBe("write");
  expect(wipe.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  expect(wipe.description).toBe("Claims to be harmless");
});

test("calls a tool and keeps a tool-reported failure as a result", async () => {
  const mcp = clients(() => config(stdio()));
  expect(textOf(await mcp.callTool("fake", "echo", { text: "hi" }))).toBe("hi");
  const failed = await mcp.callTool("fake", "fail", {});
  expect(failed.isError).toBe(true);
  expect(textOf(failed)).toBe("nope");
});

test("refreshes the cached tool list after tools/list_changed", async () => {
  const changed = Promise.withResolvers<string>();
  const mcp = clients(() => config(stdio()), { onToolsChanged: changed.resolve });
  expect((await mcp.listTools("fake")).some((tool) => tool.name === "extra")).toBe(false);
  await mcp.callTool("fake", "grow", {});
  expect(await changed.promise).toBe("fake");
  expect((await mcp.listTools("fake")).some((tool) => tool.name === "extra")).toBe(true);
});

test("a call past its deadline fails and the server keeps serving", async () => {
  const mcp = clients(() => config(stdio()), { limits: { callMs: 300 } });
  const pid = textOf(await mcp.callTool("fake", "pid", {}));
  await expect(mcp.callTool("fake", "slow", { ms: 600 })).rejects.toThrow("did not finish tool slow within 1 seconds");
  expect(textOf(await mcp.callTool("fake", "pid", {}))).toBe(pid);
  const controller = new AbortController();
  const reason = new Error("owner stopped the work");
  const call = mcp.callTool("fake", "slow", { ms: 600 }, controller.signal);
  controller.abort(reason);
  await expect(call).rejects.toBe(reason);
});

test("a crashed server fails the running call without its stderr and relaunches on the next call", async () => {
  const mcp = clients(() => config(stdio()));
  const before = textOf(await mcp.callTool("fake", "pid", {}));
  const crash = await mcp.callTool("fake", "crash", {}).then(() => null, (error: Error) => error);
  expect(crash?.message).toContain("stopped during tool crash");
  expect(crash?.message).not.toContain("SECRET-STDERR-TOKEN");
  expect(mcp.stderrTail("fake")).toContain("SECRET-STDERR-TOKEN");
  const after = textOf(await mcp.callTool("fake", "pid", {}));
  expect(after).not.toBe(before);
});

test("bounds the text and images of one call", async () => {
  const mcp = clients(() => config(stdio()), { limits: { textBytes: 1_001, imageBytes: 10 } });
  const big = await mcp.callTool("fake", "big", { chars: 5_000 });
  expect(big.truncated).toBe(true);
  expect(textOf(big)).toBe("é".repeat(500));
  const mixed = await mcp.callTool("fake", "mixed", {});
  expect(mixed.truncated).toBe(true);
  expect(mixed.content.some((item) => item.type === "image")).toBe(false);
  expect(textOf(mixed)).toContain("[image omitted: over the size limit]");

  const roomy = clients(() => config(stdio(), { id: "roomy" }));
  const full = await roomy.callTool("roomy", "mixed", {});
  expect(full.truncated).toBe(false);
  expect(full.content.map((item) => item.type)).toEqual(["text", "image", "text", "resource_link", "text"]);
  expect(full.content[2]).toEqual({ type: "text", text: "[image omitted: unsupported type image/svg+xml]" });
  expect(full.content[3]).toEqual({ type: "resource_link", uri: "file:///notes.md", name: "notes", mimeType: null, description: null });
  expect(full.content[4]).toEqual({ type: "text", text: "[resource file:///a.txt]\ninline body" });
});

test("a message over the size limit ends that session instead of buffering it", async () => {
  const mcp = clients(() => config(stdio()), { limits: { messageBytes: 64 * 1024 } });
  await expect(mcp.callTool("fake", "big", { chars: 100_000 })).rejects.toThrow(/Fake (stopped|failed) during tool big/);
  expect(textOf(await mcp.callTool("fake", "echo", { text: "back" }))).toBe("back");
});

test("launches through the command wrapper with only the listed secrets", async () => {
  process.env.GHOST_TEST_LEAK = "leak";
  cleanup.push(() => delete process.env.GHOST_TEST_LEAK);
  let values: Record<string, string> = { FAKE_SECRET: "s3cret", GHOST_TEST_LEAK: "x" };
  const mcp = clients(() => config(stdio({ env: ["FAKE_SECRET"] })), {
    wrapCommand: (argv) => [...argv, "--wrapped"],
    env: async () => values,
  });
  expect(JSON.parse(textOf(await mcp.callTool("fake", "argv", {})))).toEqual(["--wrapped"]);
  expect(textOf(await mcp.callTool("fake", "env", {}))).toBe("s3cret unset");

  values = {};
  const missing = clients(() => config(stdio({ env: ["FAKE_SECRET"] }), { id: "missing" }), { env: async () => values });
  await expect(missing.listTools("missing")).rejects.toThrow("needs a value for FAKE_SECRET");
});

test("refuses unknown and disabled servers and reconnects when the transport changes", async () => {
  let server = config(stdio());
  const mcp = clients(() => server);
  await expect(mcp.listTools("other")).rejects.toThrow("not registered");
  const before = textOf(await mcp.callTool("fake", "pid", {}));
  server = { ...server, readTools: [] };
  expect(textOf(await mcp.callTool("fake", "pid", {}))).toBe(before);
  expect((await mcp.listTools("fake")).every((tool) => tool.access === "write")).toBe(true);
  server = { ...server, transport: stdio({ args: [FIXTURE, "5"] }) };
  expect(textOf(await mcp.callTool("fake", "pid", {}))).not.toBe(before);
  server = { ...server, enabled: false };
  await expect(mcp.callTool("fake", "pid", {})).rejects.toThrow("disabled");
});

/** A local Streamable HTTP server: a fresh fake MCP server per session, so a client can reconnect. */
async function httpServer(token: string) {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers: Server[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
      const id = request.headers.get("mcp-session-id");
      const existing = id === null ? undefined : sessions.get(id);
      if (existing) return existing.handleRequest(request);
      if (id !== null) return new Response("unknown session", { status: 404 });
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (session) => void sessions.set(session, transport),
      });
      const server = fakeMcpServer(4);
      servers.push(server);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  cleanup.push(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await http.stop(true);
  });
  return `http://127.0.0.1:${http.port}/mcp`;
}

test("speaks streamable HTTP with the connection's auth header", async () => {
  const url = await httpServer("t0ken");
  const mcp = clients(() => config({ kind: "http", url, connectionId: "conn" }), { authHeaders: async (id) => ({ Authorization: id === "conn" ? "Bearer t0ken" : "wrong" }) });
  expect((await mcp.listTools("fake")).length).toBe(11);
  expect(textOf(await mcp.callTool("fake", "echo", { text: "over http" }))).toBe("over http");

  const refused = clients(() => config({ kind: "http", url, connectionId: "other" }, { id: "refused" }), { authHeaders: async () => ({ Authorization: "Bearer stale" }) });
  await expect(refused.listTools("refused")).rejects.toThrow("did not start or answer initialize (HTTP 401)");
});

test("an HTTP message over the size limit fails the call", async () => {
  const url = await httpServer("t0ken");
  const mcp = clients(() => config({ kind: "http", url, connectionId: "conn" }), {
    authHeaders: async () => ({ Authorization: "Bearer t0ken" }),
    limits: { messageBytes: 32 * 1024, callMs: 2_000 },
  });
  await expect(mcp.callTool("fake", "big", { chars: 50_000 })).rejects.toThrow(/Fake (stopped|failed) during tool big/);
  expect(textOf(await mcp.callTool("fake", "echo", { text: "still here" }))).toBe("still here");
});

test("accepts https anywhere and plain http only on loopback", () => {
  for (const url of ["https://mcp.example.com/mcp", "http://127.0.0.1:8080/mcp", "http://localhost/mcp", "http://[::1]:9000/", "http://[::ffff:127.0.0.1]/"]) {
    expect(assertMcpUrl(url).href).toBeTruthy();
  }
  for (const url of ["http://mcp.example.com/mcp", "http://10.0.0.5/mcp", "http://[::ffff:10.0.0.5]/", "ftp://127.0.0.1/", "http://127.0.0.1.example.com/"]) {
    expect(() => assertMcpUrl(url)).toThrow("must be https");
  }
  expect(() => assertMcpUrl("https://user:pass@mcp.example.com/")).toThrow("must not carry credentials");
  expect(() => assertMcpUrl("not a url")).toThrow("not a valid URL");
});
