import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_BEARER_PREFIX, TERMINAL_PROTOCOL, type TerminalAgentEvent, type TerminalView } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";
import { Terminals } from "../src/terminal/index.ts";
import { terminalNotifier } from "../src/terminal/notify.ts";
import { harness } from "./support.ts";

const owner = "terminal-owner-test";
const cols = 82, rows = 27;

test("owner-authenticated HTTP and WebSocket stream resize, relay input and report exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ghost-terminal-api-"));
  const root = join(cwd, "state");
  mkdirSync(root);
  const h = harness();
  const terminals = new Terminals(root);
  const server = startServer({ core: h.core, config: { ...loadConfig({}, root), host: "127.0.0.1", port: 0 }, ownerToken: owner, documents: null, skills: null, terminals });
  const base = `http://127.0.0.1:${server.port}/api/terminals`;
  const headers = { authorization: `Bearer ${owner}`, "content-type": "application/json" };
  let socket: WebSocket | undefined;
  try {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: { ...headers, origin: "https://foreign.invalid" } })).status).toBe(403);
    expect((await fetch(base, { headers, method: "POST", body: "{" })).status).toBe(400);
    const response = await fetch(base, { headers, method: "POST", body: JSON.stringify({ cwd, command: "/bin/sh", cols, rows }) });
    expect(response.status).toBe(200);
    expect((await fetch(`${base}/agents`)).status).toBe(401);
    expect(await (await fetch(`${base}/agents`, { headers })).json()).toEqual(terminals.availableAgents());
    for (const spec of [{ args: ["no command"] }, { command: "/bin/echo", args: ["before\0after"] }]) {
      expect((await fetch(base, { headers, method: "POST", body: JSON.stringify({ cwd, cols, rows, ...spec }) })).status).toBe(400);
    }
    const { id } = await response.json() as { id: string };
    expect(await (await fetch(base, { headers })).json()).toEqual([expect.objectContaining({ id, cols, rows, agent: null })]);
    expect((await fetch(`${base}/${id}/resize`, { method: "POST", headers, body: JSON.stringify({ cols: 101, rows: 33 }) })).status).toBe(200);
    expect((await fetch(`${base}/${id}/stream`, { headers: { "sec-websocket-protocol": `${TERMINAL_BEARER_PREFIX}${owner}` } })).status).toBe(401);
    const url = `${base.replace("http:", "ws:")}/${id}/stream`;
    const unauthorized = new WebSocket(url, [TERMINAL_PROTOCOL]);
    const rejected = Promise.withResolvers<void>();
    unauthorized.onopen = () => rejected.reject(new Error("unauthenticated WebSocket was upgraded"));
    unauthorized.onerror = () => rejected.resolve();
    await rejected.promise;
    socket = new WebSocket(url, [TERMINAL_PROTOCOL, `${TERMINAL_BEARER_PREFIX}${owner}`]);
    socket.binaryType = "arraybuffer";
    const ended = Promise.withResolvers<number>();
    const decoder = new TextDecoder();
    let text = "";
    socket.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) { text += decoder.decode(data, { stream: true }); return; }
      const frame = JSON.parse(data);
      if (frame.type === "ready") {
        expect(frame).toMatchObject({ type: "ready", cols: 101, rows: 33, reset: true });
        expect(socket?.protocol).toBe(TERMINAL_PROTOCOL);
      }
      if (frame.type === "replay-end") {
        socket?.send(JSON.stringify({ type: "resize", cols: 105, rows: 37 }));
        socket?.send(JSON.stringify({ type: "input", data: "stty size; printf 'UNTIL:%s\\n' END; exit 9\r" }));
      }
      if (frame.type === "exit") ended.resolve(frame.code);
    };
    socket.onerror = () => ended.reject(new Error("terminal WebSocket failed"));
    socket.onclose = () => ended.reject(new Error("terminal stream closed before exit frame"));
    expect(await ended.promise).toBe(9);
    expect(text).toContain("37 105");
    expect(text).toContain("UNTIL:END");
    expect((await fetch(`${base}/${id}`, { headers, method: "DELETE" })).status).toBe(200);
    expect(await (await fetch(base, { headers })).json()).toEqual([]);
  } finally {
    socket?.close();
    await server.stop();
    await terminals.shutdown();
    h.ledger.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("terminal agent events respect coding notification preferences and use the shared inbox", async () => {
  const h = harness();
  try {
    h.core.createGhost({ name: "Ghost", persona: "", isDefault: true });
    await h.core.start();
    const notify = terminalNotifier(h.core);
    const terminal: TerminalView = { id: "terminal-test", cwd: "/tmp/project", cols, rows, agent: "claude", state: "idle", exitCode: null };
    const waiting: TerminalAgentEvent = { type: "waiting", agent: "claude", reason: "prompt" };
    const finished: TerminalAgentEvent = { type: "finished", agent: "claude", reason: "quiet" };
    const notices = () => h.ledger.notificationsForState().filter(item => item.id.startsWith("coding:terminal:"));
    const prefs = (value: string) => h.ledger.tx(() => h.ledger.putSetting("coding", { notify: value }));
    prefs("off");
    notify(terminal, waiting);
    notify(terminal, finished);
    expect(notices()).toHaveLength(0);
    prefs("blocked");
    notify(terminal, finished);
    expect(notices()).toHaveLength(0);
    notify(terminal, waiting);
    expect(notices()).toMatchObject([{ title: "에이전트가 답을 기다려요", body: "claude · project", kind: "message" }]);
    prefs("all");
    notify(terminal, finished);
    expect(notices().map(item => item.title)).toContain("에이전트가 끝났어요");
    expect(notices()).toHaveLength(2);
  } finally { h.core.stop(); await h.core.idle(); h.ledger.close(); }
});
