import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CodingAgentsView, CodingSessionDetail, CodingSessionList, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import type { CodingAgentInfo, CodingAgentPort } from "../src/integrations/ports.ts";
import { CodingAgents } from "../src/integrations/coding-agents.ts";
import { harness, tempDir } from "./support.ts";

const OWNER = "owner-coding-token";

test("the owner sees what the Host found, picks a default and switches an agent off, and a fresh look is one request away", async () => {
  const agents: CodingAgentInfo[] = [
    { id: "omp", name: "omp", path: "/bin/omp", version: "omp/1", ready: true, note: null },
    { id: "claude", name: "Claude Code", path: "/bin/claude", version: "2.1", ready: false, note: "로그인이 필요합니다(claude auth login)." },
  ];
  const looks: boolean[] = [];
  const real = new CodingAgents(join(tempDir(), "coding-sessions"));
  const coding: CodingAgentPort = { detect: async (refresh = false) => { looks.push(refresh); return agents; }, command: () => [], stream: (agent) => real.stream(agent), sessions: real.sessions };
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null, coding });
  const base = `http://127.0.0.1:${server.port}`;
  const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  const send = (command: object) => fetch(`${base}/api/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER}` },
    body: JSON.stringify({ requestId: randomUUID(), command }),
  });
  try {
    expect((await get("/api/coding-agents")).status).toBe(401);
    const first = parse(CodingAgentsView, await (await get("/api/coding-agents", OWNER)).json());
    expect(first.agents.map(({ id, ready }) => ({ id, ready }))).toEqual([{ id: "omp", ready: true }, { id: "claude", ready: false }]);
    expect(first).toMatchObject({ default: null, disabled: [] });

    expect((await send({ type: "coding.set", default: "omp", disabled: ["claude"] })).status).toBe(200);
    expect(parse(CodingAgentsView, await (await get("/api/coding-agents", OWNER)).json())).toMatchObject({ default: "omp", disabled: ["claude"] });
    expect(h.ledger.setting<unknown>("coding", null)).toEqual({ default: "omp", disabled: ["claude"] });

    expect((await send({ type: "coding.set", default: "vim", disabled: [] })).status).toBe(400);

    await get("/api/coding-agents?refresh=1", OWNER);
    expect(looks).toEqual([false, false, true]);
  } finally {
    await server.stop();
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("a Host with no coding agents port says so", async () => {
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/coding-agents`, { headers: { authorization: `Bearer ${OWNER}` } });
    expect(response.status).toBe(503);
  } finally {
    await server.stop();
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("the owner reads each coding session and follows a running one from where they left off", async () => {
  const h = harness(":memory:");
  const real = new CodingAgents(join(tempDir(), "coding-sessions"));
  const coding: CodingAgentPort = { detect: async () => [], command: () => [], stream: (agent) => real.stream(agent), sessions: real.sessions };
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null, coding });
  const get = (path: string, token?: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  try {
    const writer = real.sessions.open({ agent: "omp", workId: null, callId: "call-1", task: "Add b", cwd: "/work/tree", branch: "ghost/add-b", base: "abc" });
    writer.native("native-9");
    writer.step("say", "looking");
    expect((await get(`/api/coding-sessions/${writer.id}`)).status).toBe(401);

    const running = parse(CodingSessionDetail, await (await get(`/api/coding-sessions/${writer.id}`, OWNER)).json());
    expect(running.session).toMatchObject({ id: writer.id, state: "running", nativeId: "native-9", endedAt: null });
    expect(running.steps.map((step) => step.text)).toEqual(["looking"]);

    writer.step("tool", "bash: ls");
    writer.end(0);
    const rest = parse(CodingSessionDetail, await (await get(`/api/coding-sessions/${writer.id}?after=${running.next}`, OWNER)).json());
    expect(rest.session.state).toBe("done");
    expect(rest.steps.map((step) => step.text)).toEqual(["bash: ls"]);

    const listed = parse(CodingSessionList, await (await get("/api/coding-sessions", OWNER)).json());
    expect(listed.sessions.map((session) => session.id)).toEqual([writer.id]);
    expect((await get(`/api/coding-sessions/${"0".repeat(32)}`, OWNER)).status).toBe(404);
    expect((await get("/api/coding-sessions/..%2Fledger.db", OWNER)).status).toBe(404);
  } finally {
    await server.stop();
    rmSync(config.root, { recursive: true, force: true });
  }
});
