import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodingSessions } from "../src/integrations/coding-sessions.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const store = () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-coding-sessions-"));
  roots.push(root);
  return { root, sessions: new CodingSessions(root) };
};
const meta = { agent: "claude", workId: "w1", callId: "c1", task: "Fix it", cwd: "/work/it's here", branch: "ghost/fix", base: "abc123" } as const;

test("a run the Host lost track of reads as interrupted, not as running or failed", () => {
  const { root, sessions } = store();
  const writer = sessions.open(meta);
  writer.step("say", "starting");
  expect(sessions.get(writer.id)!.session.state).toBe("running");
  // After a restart nothing holds the run, and it never wrote an end.
  const after = new CodingSessions(root).get(writer.id)!;
  expect(after.session).toMatchObject({ state: "interrupted", endedAt: null, exitCode: null });
  expect(after.steps.map((step) => step.text)).toEqual(["starting"]);
});

test("the hand-over command quotes the directory and names each agent's own resume", () => {
  const { sessions } = store();
  const claude = sessions.open(meta);
  claude.native("n-1");
  expect(sessions.get(claude.id)!.session.resumeCommand).toBe(`cd '/work/it'\\''s here' && claude --resume n-1`);
  const codex = sessions.open({ ...meta, agent: "codex" });
  codex.native("n-2");
  expect(sessions.get(codex.id)!.session.resumeCommand).toContain("&& codex resume n-2");
  const silent = sessions.open(meta);
  expect(sessions.get(silent.id)!.session.resumeCommand).toBeNull();
  expect(sessions.continuation(silent.id)).toBeNull();
  expect(sessions.continuation(claude.id)).toEqual({ agent: "claude", cwd: "/work/it's here", branch: "ghost/fix", base: "abc123", nativeId: "n-1" });
});

test("a failed run reads as failed, and a torn last line after a crash does not hide the rest", () => {
  const { root, sessions } = store();
  const writer = sessions.open(meta);
  writer.step("say", "one");
  writer.end(1);
  appendFileSync(join(root, `${writer.id}.jsonl`), '{"t":"step","at":1,"kind":"say","te');
  const detail = sessions.get(writer.id)!;
  expect(detail.session).toMatchObject({ state: "failed", exitCode: 1 });
  expect(detail.steps.map((step) => step.text)).toEqual(["one"]);
});

test("a session file stops growing at its cap and says so once; long steps are cut", () => {
  const { sessions } = store();
  const writer = sessions.open(meta);
  const chunk = "x".repeat(4_000);
  for (let index = 0; index < 600; index++) writer.step("result", chunk);
  writer.end(0);
  const { steps } = sessions.get(writer.id)!;
  expect(steps.at(-1)).toMatchObject({ kind: "note" });
  expect(steps.filter((step) => step.kind === "note")).toHaveLength(1);
  expect(steps.every((step) => step.text.length <= 4_000)).toBe(true);
  expect(steps.length).toBeLessThan(600);
});

test("only well-formed ids resolve, and sessions older than ninety days are removed when a new one opens", () => {
  const { root, sessions } = store();
  expect(sessions.get("../ledger")).toBeNull();
  expect(sessions.get("0".repeat(32))).toBeNull();
  const old = sessions.open(meta);
  old.end(0);
  const oldPath = join(root, `${old.id}.jsonl`);
  const stale = new Date(Date.now() - 91 * 86_400_000);
  utimesSync(oldPath, stale, stale);
  writeFileSync(join(root, "notes.txt"), "not a session");
  const fresh = sessions.open(meta);
  expect(existsSync(oldPath)).toBe(false);
  expect(sessions.list().map((session) => session.id)).toEqual([fresh.id]);
  expect(statSync(join(root, `${fresh.id}.jsonl`)).mode & 0o777).toBe(0o600);
});

test("a Work's page asks for its own sessions only", () => {
  const { sessions } = store();
  const mine = sessions.open({ ...meta, workId: "w1", callId: "a" });
  const other = sessions.open({ ...meta, workId: "w2", callId: "b" });
  const loose = sessions.open({ ...meta, workId: null, callId: "c" });
  expect(sessions.list(30, "w1").map((session) => session.id)).toEqual([mine.id]);
  expect(sessions.list(30, "w2").map((session) => session.id)).toEqual([other.id]);
  expect(sessions.list().map((session) => session.id).sort()).toEqual([mine.id, other.id, loose.id].sort());
  expect(sessions.list(1)).toHaveLength(1);
});
