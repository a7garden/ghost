import { expect, test } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrOutput, HerdrView, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { Herdr, terminalText } from "../src/integrations/herdr.ts";
import { harness, tempDir } from "./support.ts";

const OWNER = "owner-herdr-token";

const snapshot = {
  id: "cli:api:snapshot",
  result: { snapshot: {
    workspaces: [{ workspace_id: "w1", label: "ghost" }],
    tabs: [{ tab_id: "w1:t1", label: "로그인 고치기" }, { tab_id: "w1:t2", label: "shell" }],
    panes: [
      { pane_id: "w1:pA", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "blocked", cwd: "/work", foreground_cwd: "/work/tree", terminal_title_stripped: "x" },
      { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t2", agent: null, agent_status: "unknown", cwd: "/work" },
      // herdr leaves the key out of a pane that never had an agent.
      { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2", agent_status: "unknown", cwd: "/work" },
    ],
  } },
};

/** A stand-in `herdr` that answers the three commands the Host uses and records every argv it was run with. */
function fakeHerdr(dir: string) {
  const path = join(dir, "herdr");
  const log = join(dir, "argv.log");
  writeFileSync(path, `#!/bin/sh
echo "$@" >> '${log}'
case "$*" in
  "session list --json") echo '{"sessions":[{"name":"default","running":true},{"name":"old","running":false}]}' ;;
  "--session default api snapshot") cat <<'JSON'
${JSON.stringify(snapshot)}
JSON
  ;;
  "--session default pane read w1:pA "*) printf '\\n\\n  working on it   \\n\\033[31mred\\n\\n' ;;
  "--session default pane read "*) echo '{"error":{"code":"pane_not_found","message":"gone"}}'; exit 1 ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`);
  chmodSync(path, 0o755);
  return { path, argv: () => Bun.file(log).text().then((text) => text.trim().split("\n")) };
}

test("herdr lists only agent panes of running sessions and reads one pane's terminal as plain text", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  try {
    const herdr = new Herdr(fake.path);
    const view = await herdr.overview();
    expect(view.available).toBe(true);
    expect(view.panes).toEqual([{ session: "default", id: "w1:pA", workspace: "ghost", tab: "로그인 고치기", agent: "claude", status: "blocked", cwd: "/work/tree", title: "로그인 고치기" }]);

    const output = await herdr.output("default", "w1:pA");
    expect(output?.text).toBe("  working on it\nred");
    expect(output?.pane.status).toBe("blocked");
    // A shell pane is not an agent pane, and a pane herdr does not know is the same answer.
    expect(await herdr.output("default", "w1:p2")).toBeNull();
    expect(await herdr.output("default", "w1:pZ")).toBeNull();
    // Nothing the Host ran can write: only list, snapshot and read.
    expect((await fake.argv()).every((line) => /^(session list|--session default (api snapshot|pane read))/.test(line))).toBe(true);

    await expect(herdr.output("../x", "w1:pA")).rejects.toThrow("not a herdr session or pane id");
    await expect(herdr.output("default", "w1:pA --raw")).rejects.toThrow("not a herdr session or pane id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Mac without herdr is reported as unavailable, not as an error", async () => {
  expect(await new Herdr(null).overview()).toEqual({ available: false, note: null, panes: [] });
});

test("terminal text keeps the end, drops control bytes and trailing blanks", () => {
  expect(terminalText("\n\na  \n\u001b[0mb\u001b]0;title\u0007c\n\n")).toBe("a\nbc");
  const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
  const kept = terminalText(long).split("\n");
  expect(kept).toHaveLength(300);
  expect(kept.at(-1)).toBe("line 499");
});

test("the herdr routes need the owner token and answer with the contract's shapes", async () => {
  const dir = tempDir();
  const fake = fakeHerdr(dir);
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null, herdr: new Herdr(fake.path) });
  const get = (path: string, token?: string) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  try {
    expect((await get("/api/herdr")).status).toBe(401);
    expect((await get("/api/herdr/output?session=default&pane=w1%3ApA")).status).toBe(401);
    expect(parse(HerdrView, await (await get("/api/herdr", OWNER)).json()).panes).toHaveLength(1);
    expect(parse(HerdrOutput, await (await get("/api/herdr/output?session=default&pane=w1%3ApA", OWNER)).json()).text).toBe("  working on it\nred");
    expect((await get("/api/herdr/output?session=default&pane=w1%3ApZ", OWNER)).status).toBe(404);
    expect((await get("/api/herdr/output?session=default&pane=nope", OWNER)).status).toBe(400);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("a Host without the herdr port says so", async () => {
  const h = harness(":memory:");
  const config: Config = { root: tempDir(), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const server = startServer({ core: h.core, config, ownerToken: OWNER, documents: null, skills: null });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/herdr`, { headers: { authorization: `Bearer ${OWNER}` } })).status).toBe(503);
  } finally {
    await server.stop();
    rmSync(config.root, { recursive: true, force: true });
  }
});
