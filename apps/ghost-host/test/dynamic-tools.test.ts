import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GhostToolList, validate, matchesToolPatterns, type McpServer } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createToolSet } from "../src/tools/index.ts";
import { mcpToolName } from "../src/tools/dynamic.ts";
import { requireAllowed } from "../src/tools/shared.ts";
import { createHostMcpClients, McpClients } from "../src/integrations/mcp.ts";
import { SourceConnections } from "../src/integrations/activity-sources.ts";
import { createVault } from "../src/stores/vault.ts";
import { DEFAULT_RULES } from "../src/core/policy.ts";
import { harness, hostTaskId } from "./support.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import { fakeMcpServer } from "./fixtures/mcp-server.ts";
import { connect } from "node:net";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" } as Context;
const content = (result: ToolExecutionResult) => (result.content ?? []).map(part => part.type === "text" ? part.text : "").join("\n");
const api = (callId: string, conversationId = 1) => ({ conversationId, taskId: hostTaskId(), callId, output() {}, diagnostic() {} }) as unknown as ToolExecutionApi;

function setup(connectGate?: Promise<void>) {
  const h = harness();
  const ghost = h.core.createGhost({ name: "Reader", persona: "", tools: ["mcp.fake.*"] });
  const conversation = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(conversation.id, "1");
  const server: McpServer = { id: "fake", name: "Fake MCP", enabled: true, transport: { kind: "stdio", command: process.execPath, args: [new URL("./fixtures/mcp-server.ts", import.meta.url).pathname], env: [], cwd: null }, readTools: ["echo"], createdAt: 1, updatedAt: 1 };
  h.ledger.tx(() => { h.ledger.putMcpServer(server); for (const rule of DEFAULT_RULES) h.ledger.putPolicyRule(rule); });
  const mcp = new McpClients({ server: id => h.ledger.mcpServers().find(server => server.id === id) ?? null, wrapCommand: async argv => { await connectGate; return argv; } });
  const tools = createToolSet({ core: h.core, sandbox: {} as never, memory: null, documents: null, skills: null, mcp });
  const catalog = async () => (await tools.prepare!(conversation, h.ledger.ghost(ghost.id), null, tools.extensionsFor(conversation, h.ledger.ghost(ghost.id), null))).flatMap(extension => extension.tools ?? []);
  const call = async (name: string, args: unknown, callId: string, provided?: ToolRegistration) => {
    const tool = provided ?? (await catalog()).find(tool => tool.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.execute(args as never, api(callId), context);
  };
  cleanup.push(async () => { await mcp.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); });
  return { ...h, ghost, conversation, server, mcp, tools, catalog, call };
}

test("open grants validate bounded patterns without admitting unknown builtin literals", () => {
  expect(validate(GhostToolList, ["web_*", "mcp.server.*", "conn.calendar", "*"])).toBe(true);
  expect(validate(GhostToolList, ["invented_builtin"])).toBe(false);
  expect(validate(GhostToolList, ["mcp.[server].*"])).toBe(false);
  expect(validate(GhostToolList, ["*".repeat(513)])).toBe(false);
  expect(matchesToolPatterns(["mcp.calendar.*"], "mcp.calendar.list")).toBe(true);
  expect(matchesToolPatterns(["mcp.calendar.*"], "mcp.contacts.list")).toBe(false);
  expect(mcpToolName("a.b", "c")).not.toBe(mcpToolName("a", "b.c"));
});

test("the Host invokes owner-marked reads but journals false read annotations as writes", async () => {
  const s = setup();
  const read = await s.call("mcp.fake.echo", { text: "live evidence" }, "read");
  expect(content(read)).toContain("live evidence");
  expect(s.ledger.effectsInState("done")).toHaveLength(0);
  const write = await s.call("mcp.fake.wipe", {}, "false-read");
  expect(write.isError).toBeFalsy();
  expect(s.ledger.pendingDecisions().some(decision => decision.kind === "approve_effect" && decision.effectId !== null)).toBe(true);
  expect(s.ledger.effectsInState("pending")[0]?.tool).toBe("mcp.fake.wipe");
});

test("approved MCP writes execute once and changed server tools become visible", async () => {
  const s = setup();
  expect((await s.catalog()).some(tool => tool.name === "mcp.fake.extra")).toBe(false);
  await s.call("mcp.fake.grow", {}, "grow");
  const decision = s.ledger.pendingDecisions().find(decision => decision.kind === "approve_effect")!;
  await s.core.decisions.resolve(decision.id, { outcome: "approve" }, "owner");
  await s.core.idle();
  expect(s.ledger.effect(decision.effectId!).state).toBe("done");
  expect((await s.catalog()).some(tool => tool.name === "mcp.fake.extra")).toBe(true);
  await s.call("mcp.fake.grow", {}, "grow");
  expect(s.ledger.effectsInState("done").filter(effect => effect.tool === "mcp.fake.grow")).toHaveLength(1);
});

test("server and Ghost revocation reject stale approved MCP executions", async () => {
  const s = setup();
  await s.call("mcp.fake.grow", {}, "grow-revoked");
  const decision = s.ledger.pendingDecisions().find(decision => decision.kind === "approve_effect")!;
  s.ledger.tx(() => s.ledger.putMcpServer({ ...s.server, enabled: false, updatedAt: 2 }));
  await s.core.decisions.resolve(decision.id, { outcome: "approve" }, "owner");
  await s.core.idle();
  expect(s.ledger.effect(decision.effectId!).state).toBe("denied");
  s.ledger.tx(() => s.ledger.putMcpServer(s.server));
  const stale = (await s.catalog()).find(tool => tool.name === "mcp.fake.echo")!;
  s.ledger.tx(() => s.ledger.putGhost({ ...s.ghost, tools: [] }));
  expect((await s.call("mcp.fake.echo", { text: "not delivered" }, "stale", stale)).isError).toBe(true);
});

test("wildcard grants cannot widen a Work tool scope or conversation kind", async () => {
  const s = setup();
  s.ledger.tx(() => s.ledger.putGhost({ ...s.ghost, tools: ["*"] }));
  expect(() => requireAllowed(s.core, api("wrong-kind"), "write")).toThrow("does not run");
  const work = s.core.works.createRoot({ ghostId: s.ghost.id, originConversationId: s.conversation.id, title: "Read", brief: "Read only", toolScope: ["mcp.fake.echo"] });
  await s.core.idle();
  const current = s.ledger.work(work.id);
  if (!current.conversationId) throw new Error("Work did not start");
  s.ledger.setPiConversationId(current.conversationId, "2");
  const workApi = api("narrowed", 2);
  expect(() => requireAllowed(s.core, workApi, "mcp.fake.grow")).toThrow("outside this Work");
  expect(requireAllowed(s.core, workApi, "mcp.fake.echo").work?.id).toBe(work.id);
});

test("tool search actually installs and invokes a discovered tool after delayed server registration", async () => {
  const s = setup();
  s.ledger.tx(() => { s.ledger.deleteMcpServer(s.server.id); s.ledger.putSetting("toolSearchThreshold", 1); });
  expect((await s.catalog()).some(tool => tool.name.startsWith("mcp."))).toBe(false);
  s.ledger.tx(() => s.ledger.putMcpServer(s.server));
  const initial = await s.catalog();
  expect(initial.some(tool => tool.name === "mcp.fake.echo")).toBe(false);
  const installed: ToolRegistration[] = [];
  s.tools.bindLoader!(async (_piId, definitions) => { installed.push(...definitions); });
  const search = initial.find(tool => tool.name === "tool_search")!;
  const found = await search.execute({ query: "echo", limit: 1 } as never, api("discover"), context);
  expect(content(found)).toContain("mcp.fake.echo");
  const discovered = installed.find(tool => tool.name === "mcp.fake.echo")!;
  expect(content(await s.call(discovered.name, { text: "discovered execution" }, "discovered", discovered))).toContain("discovered execution");
});

test.skipIf(process.platform !== "darwin")("production stdio MCP confines reads and writes to its private workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-mcp-boundary-"));
  const h = harness();
  h.core.createGhost({ name: "Owner", persona: "", isDefault: true });
  const sources = new SourceConnections({ root, currentConnection: id => h.ledger.findConnection(id) });
  const vault = createVault(root);
  const outside = join(root, "private-credential");
  writeFileSync(outside, "DO-NOT-EXPOSE");
  const program = `const readline=require('node:readline');const fs=require('node:fs');const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'confined',version:'1'}};else if(q.method==='tools/list')result={tools:[{name:'probe',inputSchema:{type:'object'}}]};else{let denied=false;try{fs.readFileSync(${JSON.stringify(outside)})}catch{denied=true}fs.writeFileSync('owned','ok');result={content:[{type:'text',text:JSON.stringify({denied,cwd:process.cwd(),home:process.env.HOME,hostHome:${JSON.stringify(homedir())}})}]}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`;
  const server: McpServer = { id: "confined", name: "Confined", enabled: true, transport: { kind: "stdio", command: process.execPath, args: ["-e", program], env: [], cwd: null }, readTools: ["probe"], createdAt: 1, updatedAt: 1 };
  h.ledger.tx(() => h.ledger.putMcpServer(server));
  const clients = createHostMcpClients({ root, ledger: h.ledger, sources, vault });
  cleanup.push(async () => { await clients.close(); await sources.close(); vault.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const result = await clients.callTool(server.id, "probe", {});
  const value = JSON.parse(result.content.map(part => part.type === "text" ? part.text : "").join(""));
  const expected = join(root, "mcp", createHash("sha256").update(server.id).digest("hex"));
  expect(value.denied).toBe(true);
  expect(value.cwd).toEndWith(expected.replace(/^\/private/, ""));
  expect(value.home).not.toBe(homedir());
});

test("live Ghost grants are checked again after lazy MCP initialization waits", async () => {
  const gate = Promise.withResolvers<void>();
  const s = setup(gate.promise);
  const pending = s.call("mcp.fake.echo", { text: "revoked" }, "after-wait");
  s.ledger.tx(() => s.ledger.putGhost({ ...s.ghost, tools: [] }));
  gate.resolve();
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(content(result)).toContain("not enabled");
});

test("MCP HTTP uses only granted stored credentials and never exposes echoed secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-mcp-http-"));
  const h = harness();
  const ghost = h.core.createGhost({ name: "Granted", persona: "", tools: ["mcp.remote.*"] });
  const other = h.core.createGhost({ name: "Ungranted", persona: "", tools: ["mcp.remote.*"] });
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const servers: Server[] = [];
  const seenAuth: string[] = [];
  const token = "HTTP-ONLY-VAULT-TOKEN";
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    seenAuth.push(request.headers.get("authorization") ?? "");
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
    const id = request.headers.get("mcp-session-id");
    if (id && sessions.has(id)) return sessions.get(id)!.handleRequest(request);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: id => { sessions.set(id, transport); } });
    const server = fakeMcpServer(100);
    servers.push(server);
    await server.connect(transport);
    return transport.handleRequest(request);
  } });
  const sources = new SourceConnections({ root, currentConnection: id => h.ledger.findConnection(id) });
  const vault = createVault(root);
  h.ledger.tx(() => {
    h.ledger.putConnection({ id: "service", name: "Service", config: { kind: "api", baseUrl: `http://127.0.0.1:${http.port}/`, authHeader: "Authorization", authPrefix: "Bearer", testPath: "me", headers: {}, ghostIds: [ghost.id] }, hasCredential: true, credentialVersion: "v1", createdAt: 1, updatedAt: 1 });
    h.ledger.putMcpServer({ id: "remote", name: "Remote", enabled: true, transport: { kind: "http", url: `http://127.0.0.1:${http.port}/mcp`, connectionId: "service" }, readTools: ["echo"], createdAt: 1, updatedAt: 1 });
    for (const rule of DEFAULT_RULES) h.ledger.putPolicyRule(rule);
  });
  await sources.setCredential("service", token, "v1");
  const clients = createHostMcpClients({ root, ledger: h.ledger, sources, vault });
  cleanup.push(async () => { await clients.close(); await Promise.all(servers.map(server => server.close())); await http.stop(true); await sources.close(); vault.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const tools = createToolSet({ core: h.core, sandbox: {} as never, memory: null, documents: null, skills: null, mcp: clients });
  const conversation = h.ledger.conversation(ghost.directConversationId);
  h.ledger.setPiConversationId(conversation.id, "1");
  const catalog = (await tools.prepare!(conversation, ghost, null, tools.extensionsFor(conversation, ghost, null))).flatMap(extension => extension.tools ?? []);
  const echo = catalog.find(tool => tool.name === "mcp.remote.echo")!;
  const result = await echo.execute({ text: `Bearer ${token}` } as never, api("http-read"), context);
  expect(result.isError).toBeFalsy();
  expect(content(result)).toContain("[redacted]");
  expect(content(result)).not.toContain(token);
  expect(seenAuth.length).toBeGreaterThan(0);
  expect(seenAuth.every(value => value === `Bearer ${token}`)).toBe(true);
  const otherConversation = h.ledger.conversation(other.directConversationId);
  expect((await tools.prepare!(otherConversation, other, null, tools.extensionsFor(otherConversation, other, null))).flatMap(extension => extension.tools ?? []).some(tool => tool.name.startsWith("mcp.remote."))).toBe(false);
  const connection = h.ledger.connection("service");
  if (connection.config.kind !== "api") throw new Error("Expected the HTTP credential fixture to use an API connection");
  const revoked = { ...connection, config: { ...connection.config, ghostIds: [] } };
  h.ledger.tx(() => h.ledger.putConnection(revoked));
  expect((await echo.execute({ text: "revoked" } as never, api("http-revoked"), context)).isError).toBe(true);
});

for (const mutation of ["grant", "replace", "delete", "rename"] as const) {
  test.skipIf(process.platform !== "darwin")(`vault ${mutation} immediately stops credentialed stdio MCP and its egress`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-mcp-revoke-"));
    const h = harness();
    const owner = h.core.createGhost({ name: "Owner", persona: "", isDefault: true });
    const sources = new SourceConnections({ root, currentConnection: id => h.ledger.findConnection(id) });
    const vault = createVault(root);
    const token = "VAULT-RAW-MCP-TOKEN";
    const item = vault.create({ kind: "secret", title: "mcp.revoke.FAKE_SECRET", value: token, ghostIds: [owner.id] });
    const changes: unknown[] = [];
    const unsubscribe = vault.subscribe(change => changes.push(change));
    // A live IPC port keeps the real child alive after stdin closes without a clock-based wait.
    const program = `const fs=require('node:fs');const readline=require('node:readline');const channel=new (require('node:worker_threads').MessageChannel)();channel.port1.on('message',()=>{});process.on('SIGTERM',()=>fs.writeFileSync('term','received'));readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'revoke',version:'1'}};else if(q.method==='tools/list')result={tools:['pid','hold'].map(name=>({name,inputSchema:{type:'object'}}))};else if(q.params.name==='hold'){process.stderr.write(process.env.FAKE_SECRET);fs.writeFileSync('waiting','ready');return}else result={content:[{type:'text',text:JSON.stringify({pid:process.pid,proxy:process.env.HTTP_PROXY,changed:process.env.FAKE_SECRET==='replacement-value'})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`;
    const server: McpServer = { id: "revoke", name: "Revoke", enabled: true, transport: { kind: "stdio", command: process.execPath, args: ["-e", program], env: ["FAKE_SECRET"], cwd: null }, readTools: ["pid", "hold"], createdAt: 1, updatedAt: 1 };
    h.ledger.tx(() => h.ledger.putMcpServer(server));
    const clients = createHostMcpClients({ root, ledger: h.ledger, sources, vault });
    cleanup.push(async () => { unsubscribe(); await clients.close(); await sources.close(); vault.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); rmSync(root, { recursive: true, force: true }); });
    const first = await clients.callTool(server.id, "pid", {});
    const before = JSON.parse(first.content.map(part => part.type === "text" ? part.text : "").join("")) as { pid: number; proxy: string; changed: boolean };
    const unrelated = vault.create({ kind: "secret", title: "unrelated", value: "unrelated-secret", ghostIds: [owner.id] });
    vault.update(unrelated.id, { value: "unrelated-new-value" });
    expect(JSON.stringify(await clients.callTool(server.id, "pid", {}))).toContain(String(before.pid));
    const directory = join(root, "mcp", createHash("sha256").update(server.id).digest("hex"));
    const entered = Promise.withResolvers<void>();
    const watcher = watch(directory, (_event, filename) => {
      if (filename === "waiting") { watcher.close(); entered.resolve(); }
    });
    cleanup.push(async () => { watcher.close(); });
    const pending = clients.callTool(server.id, "hold", {}).then(() => null, (error: unknown) => error);
    await entered.promise;
    if (mutation === "grant") vault.update(item.id, { ghostIds: [] });
    else if (mutation === "replace") vault.update(item.id, { value: "replacement-value" });
    else if (mutation === "rename") vault.update(item.id, { title: "renamed" });
    else vault.remove(item.id);
    const proxy = new URL(before.proxy);
    const reachable = Promise.withResolvers<boolean>();
    const socket = connect({ host: proxy.hostname, port: Number(proxy.port) });
    socket.once("connect", () => { socket.destroy(); reachable.resolve(true); });
    socket.once("error", () => { socket.destroy(); reachable.resolve(false); });
    const outcome = await pending;
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Revoked MCP call unexpectedly completed");
    expect(outcome.message).not.toContain(token);
    expect(await reachable.promise).toBe(false);
    expect(existsSync(join(directory, "term"))).toBe(false);
    expect(JSON.stringify(changes)).not.toContain(token);
    expect(JSON.stringify(changes)).not.toContain("replacement-value");
    if (mutation === "replace") {
      const next = await clients.callTool(server.id, "pid", {});
      const metadata = JSON.parse(next.content.map(part => part.type === "text" ? part.text : "").join("")) as { pid: number; changed: boolean };
      expect(metadata.changed).toBe(true);
      expect(metadata.pid).not.toBe(before.pid);
      expect(JSON.stringify(next)).not.toContain(token);
      expect(JSON.stringify(next)).not.toContain("replacement-value");
    } else await expect(clients.callTool(server.id, "pid", {})).rejects.toThrow("needs exactly one");
  }, 10_000);
}
