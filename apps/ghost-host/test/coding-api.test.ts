import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CodingAgentsView, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import type { CodingAgentInfo, CodingAgentPort } from "../src/integrations/ports.ts";
import { harness, tempDir } from "./support.ts";

const OWNER = "owner-coding-token";

test("the owner sees what the Host found, picks a default and switches an agent off, and a fresh look is one request away", async () => {
  const agents: CodingAgentInfo[] = [
    { id: "omp", name: "omp", path: "/bin/omp", version: "omp/1", ready: true, note: null },
    { id: "claude", name: "Claude Code", path: "/bin/claude", version: "2.1", ready: false, note: "로그인이 필요합니다(claude auth login)." },
  ];
  const looks: boolean[] = [];
  const coding: CodingAgentPort = { detect: async (refresh = false) => { looks.push(refresh); return agents; }, command: () => [] };
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
