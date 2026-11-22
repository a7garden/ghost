import { expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrControlEnd, HerdrControlLease, HerdrFrame, parse, type HerdrControlEnd as End } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { ControlLeases, type HerdrControlRequest, type HerdrControlStream } from "../src/integrations/herdr-control.ts";
import { HerdrState } from "../src/integrations/herdr-state.ts";
import { Herdr } from "../src/integrations/herdr.ts";
import { harness, tempDir } from "./support.ts";

// Each subprocess really exchanges NDJSON over pipes. Disk stands in for herdr's grid and scrollback across process restarts.
const script = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [state, log, terminal, cols, rows, takeover] = process.argv.slice(-6);
const get = () => JSON.parse(readFileSync(state,'utf8'));
const update = (fn) => { const all = get(); fn(all[terminal]); writeFileSync(state,JSON.stringify(all)); };
const note = (event) => appendFileSync(log,JSON.stringify({terminal,...event})+'\\n');
const shut = (reason) => console.log(JSON.stringify({type:'terminal.closed',reason}));
const first = get()[terminal];
note({type:'open',cols:Number(cols),rows:Number(rows),takeover:takeover==='1'});
if (first.held && takeover!=='1') {
  shut('terminal attach failed: terminal '+terminal+' already has an attached client; retry with --takeover');
  process.exit(0);
}
let seq=0;
const draw = (full = true) => {const data = get()[terminal]; console.log(JSON.stringify({type:'terminal.frame',seq:++seq,full,width:data.cols,height:data.rows,bytes:Buffer.from(full?'full':'delta').toString('base64')}));};
update((data)=>{data.cols=Number(cols);data.rows=Number(rows);data.held=false;});
draw(); draw(false);
for await (const line of console) {
  const cmd=JSON.parse(line);note(cmd);
  if (cmd.type==='terminal.release') {shut('detached');break;}
  if (cmd.type==='terminal.input' && cmd.text==='external-takeover') {shut('terminal attach taken over');break;}
  if (cmd.type==='terminal.resize') {
    update(d=>{ if (d.failures>0) {d.failures--;return;} d.cols=cmd.cols; d.rows=cmd.rows; });
  }
  if (cmd.type==='terminal.scroll') update(d=>{d.offset=cmd.direction==='up'?d.offset+cmd.lines:Math.max(0,d.offset-cmd.lines);});
  draw();
}
`;

const SESSION = "ghost-test";
const P1 = "w1:p1", P2 = "w1:p2";
const BASE = { cols: 120, rows: 40 }, PHONE = { cols: 44, rows: 23 };
const request = (pane = P1, flags: Partial<HerdrControlRequest> = {}): HerdrControlRequest => ({ pane, ...PHONE, fit: false, takeover: false, client: "phone", ...flags });
const signal = () => new AbortController().signal;
const code = (error: unknown) => error instanceof Error && "code" in error ? error.code : undefined;
type Grid = { cols: number; rows: number; offset: number; held: boolean; failures: number; layout: { cols: number; rows: number } | null };

function fixture(grace = 20) {
  const root = tempDir(), grid = join(root, "grid"), log = join(root, "log");
  const fresh = (): Grid => ({ ...BASE, offset: 0, held: false, failures: 0, layout: BASE });
  writeFileSync(grid, JSON.stringify({ term_first: fresh(), term_second: fresh() }));
  const panes = new Map([[P1, "term_first"], [P2, "term_second"]]);
  const rows = (): Record<string, Grid> => JSON.parse(readFileSync(grid, "utf8"));
  const change = (terminal: string, patch: Partial<Grid>) => {
    const all = rows();
    all[terminal] = { ...all[terminal]!, ...patch };
    writeFileSync(grid, JSON.stringify(all));
  };
  const delays: number[] = [];
  const options = {
    grace,
    sleep: async (ms: number) => { delays.push(ms); await Bun.sleep(ms > 50 ? 0 : 12); },
    inspect: async (_session: string, pane: string, layout: boolean) => {
      const terminal = panes.get(pane);
      if (!terminal) return null;
      const data = rows()[terminal]!;
      return { terminal, viewportRows: data.rows, offset: data.offset, layout: layout ? data.layout : null };
    },
    spawn: (_session: string, terminal: string, size: { cols: number; rows: number }, takeover: boolean) => Bun.spawn([process.execPath, "-e", script,
      grid, log, terminal, String(size.cols), String(size.rows), takeover ? "1" : "0"], { stdin: "pipe" as const, stdout: "pipe" as const, stderr: "pipe" as const }),
  };
  const state = new HerdrState(root);
  const manager = new ControlLeases({ ...options, state });
  const events = (): Record<string, unknown>[] => {
    try { return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)); } catch { return []; }
  };
  return { manager, state, options, rows, change, delays, events, root, panes };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw Error("timed out waiting for simulated herdr");
}

function watch(stream: HerdrControlStream) {
  const first = Promise.withResolvers<unknown>(), end = Promise.withResolvers<End>();
  stream.listen(first.resolve, end.resolve);
  return { first: first.promise, end: end.promise };
}

test("leases an owned pane and restores size then scroll, with the documented backoff", async () => {
  const f = fixture();
  try {
    f.state.claim(SESSION, "term_first");
    f.change("term_first", { offset: 17 });
    const handle = await f.manager.open(SESSION, request(), "owner", signal());
    const events = watch(handle);
    expect(handle.lease).toMatchObject({ pane: P1, baseline: BASE, owned: true });
    expect(await events.first).toMatchObject({ full: true, width: 44, height: 23 });
    const leaseId = handle.lease.leaseId;
    await f.manager.send(SESSION, "owner", { pane: P1, leaseId, type: "input", text: "한글\u001b[D" });
    await f.manager.send(SESSION, "owner", { pane: P1, leaseId, type: "mouse", action: "down", button: "right", column: 4, row: 7, modifiers: 2 });
    await f.manager.send(SESSION, "owner", { pane: P1, leaseId, type: "resize", cols: 52, rows: 26 });
    await until(() => f.rows().term_first!.rows === 26);
    f.change("term_first", { failures: 4 });
    await f.manager.release(SESSION, P1, leaseId, "owner");
    expect(await events.end).toEqual({ reason: "released" });
    expect(f.delays.filter((ms) => ms > 50)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(f.rows().term_first).toMatchObject({ ...BASE, offset: 0 });
    expect(f.events()).toMatchObject([
      { type: "open", ...PHONE }, { type: "terminal.input", text: "한글\u001b[D" },
      { type: "terminal.mouse", action: "down", button: "right", column: 4, row: 7, modifiers: 2 },
      { type: "terminal.resize", cols: 52, rows: 26 }, { type: "terminal.resize", ...BASE },
      { type: "terminal.scroll", direction: "down", lines: 65535 }, ...Array(4).fill({ type: "terminal.resize", ...BASE }),
      { type: "terminal.release" },
    ]);
    expect(f.events().filter((event) => "pane" in event || "leaseId" in event)).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.root, "herdr-leases.json"), "utf8"))).toEqual([]);
  } finally { await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
});

test("requires explicit fit and takeover; grants a fresh generation on reconnect and rejects stale or foreign commands", async () => {
  const f = fixture(60);
  try {
    const open = (flags: Partial<HerdrControlRequest> = {}) => f.manager.open(SESSION, request(P1, flags), "owner", signal());
    expect(await open().catch(code)).toBe("confirm_required");
    expect(f.events()).toEqual([]);
    f.change("term_first", { held: true });
    expect(await open({ fit: true }).catch(code)).toBe("held");
    const first = await open({ fit: true, takeover: true });
    const firstWatch = watch(first);
    expect(await open({ client: "other", fit: true }).catch(code)).toBe("held");
    const replaced = await open({ client: "other", fit: true, takeover: true });
    expect(await firstWatch.end).toEqual({ reason: "taken" });
    replaced.disconnect();
    const renewed = await open({ client: "other", fit: true });
    expect(renewed.lease.baseline).toEqual(BASE);
    expect(renewed.lease.leaseId).not.toEqual(replaced.lease.leaseId);
    await f.manager.release(SESSION, P1, replaced.lease.leaseId, "owner");
    expect(f.rows().term_first).toMatchObject(PHONE);
    expect(await f.manager.send(SESSION, "owner", { pane: P1, leaseId: first.lease.leaseId, type: "input", text: "stale" }).catch(code)).toBe("conflict");
    expect(await f.manager.send(SESSION, "another-device", { pane: P1, leaseId: renewed.lease.leaseId, type: "input", text: "foreign" }).catch(code)).toBe("conflict");
    renewed.disconnect();
    await until(() => f.state.leases.size === 0);
    expect(f.rows().term_first).toMatchObject(BASE);
  } finally { await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
});

test("switches panes for the same client, preserves later desktop geometry, and never restores over a takeover", async () => {
  const f = fixture();
  try {
    f.state.claim(SESSION, "term_first"); f.state.claim(SESSION, "term_second");
    const first = watch(await f.manager.open(SESSION, request(), "owner", signal()));
    f.change("term_first", { layout: { cols: 98, rows: 35 } });
    const second = await f.manager.open(SESSION, request(P2), "owner", signal());
    expect(await first.end).toEqual({ reason: "released" });
    expect(f.rows().term_first).toMatchObject({ cols: 98, rows: 35 });
    expect(f.rows().term_second).toMatchObject(PHONE);
    const output = watch(second);
    await f.manager.send(SESSION, "owner", { pane: P2, leaseId: second.lease.leaseId, type: "input", text: "external-takeover" });
    expect(await output.end).toEqual({ reason: "taken" });
    expect(f.rows().term_second).toMatchObject(PHONE);
    expect(f.events().filter((event) => event.terminal === "term_second").map((event) => event.type)).toEqual(["open", "terminal.input"]);
  } finally { await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
});

test("recovers persisted leases without takeover, drops replaced pane IDs, and never guesses a null size", async () => {
  const f = fixture();
  try {
    const first = { session: SESSION, pane: P1, terminal_id: "term_first", baseline: BASE, layout: BASE, size: PHONE, startedAt: 10 };
    f.state.setLease(`${SESSION}/${P1}`, first);
    f.state.setLease(`${SESSION}/${P2}`, { ...first, pane: P2, terminal_id: "term_other" });
    expect(statSync(join(f.root, "herdr-leases.json")).mode & 0o777).toBe(0o600);
    f.change("term_first", { ...PHONE, offset: 25 });
    const state = new HerdrState(f.root);
    const restarted = new ControlLeases({ ...f.options, state });
    await restarted.recover();
    expect(state.leases.size).toBe(0);
    expect(f.rows().term_first).toMatchObject({ ...BASE, offset: 0 });
    expect(f.events()).toMatchObject([{ type: "open", ...BASE, takeover: false }, { type: "terminal.scroll", direction: "down" }, { type: "terminal.release" }]);
    state.setLease(`${SESSION}/${P1}`, { ...first, baseline: null });
    await new ControlLeases({ ...f.options, state }).recover();
    expect(f.events()).toHaveLength(3);
    expect(state.leases.size).toBe(0);
    await restarted.shutdown();
  } finally { await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
});

test("marks real creation-response identities, survives Host restart and prunes them from the herdr tree", async () => {
  const root = tempDir(), cli = join(root, "cli"), snapshot = join(root, "snapshot.json");
  const pane = { workspace_id: "w1", tab_id: "w1:t1", pane_id: P1, terminal_id: "term_first" };
  const writeSnapshot = (panes: unknown[]) => writeFileSync(snapshot, JSON.stringify({ result: { snapshot: { workspaces: [{ workspace_id: "w1" }], tabs: [{ workspace_id: "w1", tab_id: "w1:t1" }], panes } } }));
  const seen = async (herdr: Herdr) => (await herdr.overview()).workspaces[0]!.tabs[0]!.panes[0]!.owned;
  writeSnapshot([pane]);
  writeFileSync(cli, `#!/bin/sh
case "$*" in
'--session ${SESSION} api snapshot') cat '${snapshot}' ;;
'--session ${SESSION} workspace create '*) echo '${JSON.stringify({ result: { root_pane: pane } })}' ;;
*) exit 2 ;;
esac`, { mode: 0o700 });
  const create = () => new Herdr(cli, { root, prefs: () => ({ session: SESSION, agent: null, notify: "off" }) });
  try {
    const herdr = create();
    expect(await seen(herdr)).toBe(false);
    expect((await herdr.createWorkspace({ cwd: root })).owned).toBe(true);
    expect(statSync(join(root, "herdr-owned.json")).mode & 0o777).toBe(0o600);
    expect(await seen(create())).toBe(true);
    writeSnapshot([{ ...pane, terminal_id: "term_new" }]);
    expect(await seen(herdr)).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "herdr-owned.json"), "utf8"))).toEqual({});
    writeSnapshot([pane]);
    expect(await seen(create())).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("control routes authenticate, clamp, validate commands, and send lease, coalesced frames, then end", async () => {
  const f = fixture();
  const config: Config = { root: f.root, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const core = harness(":memory:").core;
  class FakePort extends Herdr {
    override control(input: HerdrControlRequest, principal: string, abort: AbortSignal) { return f.manager.open(SESSION, input, principal, abort); }
    override controlSend(command: Parameters<Herdr["controlSend"]>[0], principal: string) { return f.manager.send(SESSION, principal, command); }
    override controlRelease(input: Parameters<Herdr["controlRelease"]>[0], principal: string) { return f.manager.release(SESSION, input.pane, input.leaseId, principal); }
  }
  const server = startServer({ core, config, ownerToken: "private", documents: null, skills: null, herdr: new FakePort(null) });
  const fetchRoute = (path: string, body?: object, token = "private", site?: string) => fetch(`http://127.0.0.1:${server.port}/api/herdr/control${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(site ? { "sec-fetch-site": site } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const query = `?pane=${P1}&cols=1&rows=500`;
  try {
    expect((await fetchRoute(query, undefined, "wrong")).status).toBe(401);
    expect((await fetchRoute(query, undefined, "private", "cross-site")).status).toBe(403);
    const declined = await fetchRoute(query);
    expect(declined.status).toBe(409);
    expect(await declined.json()).toMatchObject({ error: { code: "confirm_required" } });
    const res = await fetchRoute(`${query}&fit=1&client=${crypto.randomUUID()}`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const nextEvent = async () => {
      while (!buffer.includes("\n\n")) {
        const step = await reader.read();
        if (step.done) throw Error("control event stream ended early");
        buffer += step.value;
      }
      const separator = buffer.indexOf("\n\n");
      const [event, data] = buffer.slice(0, separator).split("\n");
      buffer = buffer.slice(separator + 2);
      return { name: event!.slice(7), data: JSON.parse(data!.slice(6)) };
    };
    const leaseEvent = await nextEvent();
    expect(leaseEvent.name).toBe("lease");
    const { leaseId } = parse(HerdrControlLease, leaseEvent.data);
    const frame = await nextEvent();
    expect(frame.name).toBe("frame");
    expect(parse(HerdrFrame, frame.data)).toMatchObject({ width: 20, height: 120, full: true, seq: 2 });
    const base = { pane: P1, leaseId };
    for (const command of [{ ...base, type: "input", text: "" }, { ...base, type: "resize", cols: 301, rows: 23 }, { ...base, type: "scroll", direction: "up", lines: 501 }, { ...base, type: "mouse", action: "move", column: -1, row: 1 }]) {
      expect((await fetchRoute("/send", command)).status).toBe(400);
    }
    expect((await fetchRoute("/send", { ...base, type: "input", text: "hello", leaseId: crypto.randomUUID() })).status).toBe(409);
    expect((await fetchRoute("/send", { ...base, type: "scroll", direction: "up", lines: 3, source: "page_key" })).status).toBe(200);
    expect((await fetchRoute("/release", base)).status).toBe(200);
    let event = await nextEvent();
    while (event.name === "frame") event = await nextEvent();
    expect(event.name).toBe("end");
    expect(parse(HerdrControlEnd, event.data)).toEqual({ reason: "released" });
    expect((await fetchRoute("/send", { ...base, type: "input", text: "absent" })).status).toBe(409);
  } finally { await server.stop(); await f.manager.shutdown(); rmSync(f.root, { recursive: true, force: true }); }
});
