import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HerdrAsk, HerdrChat, HerdrPaneView, parse, type HerdrOutput } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { Herdr } from "../src/integrations/herdr.ts";
import { choiceTone, detectHerdrAsk } from "../src/integrations/herdr-ask.ts";
import { HerdrChatReader } from "../src/integrations/herdr-chat.ts";
import { harness, tempDir } from "./support.ts";

// omp v19.1.0, isolated herdr: `pane read --source recent-unwrapped --format text`.
const OMP_APPROVAL = `╭─ Allow tool: bash ──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Command: echo GHOST_CHAT_PROOF                                                                                      │
│  Approve                                                                                                           │
│   Approve bash for this session                                                                                     │
│   Deny                                                                                                              │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑/↓ choose · 󰌑 select · 󰘴 󰌑/󰘴 Q approve · 󱊷 deny · 󰘴 O details · type to deny and steer                             │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ⠇ 50s · 󰪟 Sonnet 5.5 ·  ghost-chat-proof.0BaJuY ·  main ?2 ·  0.5%/1M 󰁨 · 󰙺 0.00                    bash 실행 확인`;

// Trimmed from herdr-mobile-relay's recorded claude-single-approval / codex-final-approval frames.
const CLAUDE_APPROVAL = ` Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2
  3 ## Overview
  4
  5 ## Tasks
  6
  7 ## Links
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend`;
const CODEX_APPROVAL = `  Implement this plan?

  1. Yes, implement this plan          Switch to Default and start coding.
  2. Yes, clear context and implement  Fresh thread. Context: 29% used.
› 3. No, stay in Plan mode             Continue planning with the model.

  Press enter to confirm or esc to go back`;

const PANE = "w1:p1";
const output = (text: string, agent = "omp", status: HerdrOutput["pane"]["status"] = "blocked"): HerdrOutput => ({
  text, pane: { id: PANE, workspaceId: "w1", tabId: "w1:t1", workspace: "work", tab: "task", title: "task", agent, status, cwd: null, focused: false, owned: false },
});

test("reads terminal approval frames with the cursor, context, option tones, and keys", () => {
  const omp = detectHerdrAsk(output(OMP_APPROVAL))!;
  expect(omp.view).toEqual({ pane: PANE, kind: "approval", title: "Allow tool: bash", detail: "Command: echo GHOST_CHAT_PROOF", choices: [
    { index: 0, label: "Approve", tone: "approve" }, { index: 1, label: "Approve bash for this session", tone: "trust" }, { index: 2, label: "Deny", tone: "deny" },
  ], selected: 0 });
  expect(omp.keys(2)).toEqual(["down", "down", "enter"]);
  expect(omp.keys(0)).toEqual(["enter"]);
  const claude = detectHerdrAsk(output(CLAUDE_APPROVAL, "claude"))!;
  expect(claude.view).toMatchObject({ kind: "approval", selected: 0, title: "Do you want to create notes.md?", detail: "notes.md" });
  expect(claude.view.choices.map((choice) => choice.tone)).toEqual(["approve", "trust", "deny"]);
  const codex = detectHerdrAsk(output(CODEX_APPROVAL, "codex"))!;
  expect(codex.view).toMatchObject({ kind: "approval", selected: 2, title: "Implement this plan?" });
  expect(codex.view.choices[2]?.label).toBe("No, stay in Plan mode");
  expect(codex.keys(0)).toEqual(["up", "up", "enter"]);

  const question = detectHerdrAsk(output("Which path?\n  • Stream\n❯ • Batch\n↑/↓ to navigate · Enter to select"))!;
  expect(question.view).toMatchObject({ kind: "question", selected: 1, choices: [{ label: "Stream", tone: "neutral" }, { label: "Batch", tone: "neutral" }] });
  const binary = detectHerdrAsk(output("$ run task\nContinue? [y/N]:"))!;
  expect(binary.view).toMatchObject({ title: "Continue?", detail: "$ run task", selected: 1 });
  expect(binary.keys(0)).toEqual(["y", "enter"]);
  expect(binary.keys(1)).toEqual(["n", "enter"]);
});

test("does not turn scrollback, text input, or multiple choices/questions into an actionable ask", () => {
  const menu = "Which target?\n❯ 1. Local\n  2. Staging";
  expect(detectHerdrAsk(output(OMP_APPROVAL, "omp", "working"))).toBeNull();
  for (const text of [
    `${OMP_APPROVAL}\nContinuing on the next task`,
    `${menu}\nEsc to cancel · our next step is to run it`,
    `${menu}\nEnter to submit`,
    `${menu}\n  3. Type something.\nEnter to select`,
    `${menu}\n  3. Chat about this`,
    `${menu}\nTab/Arrow keys to navigate · Esc to cancel`,
    `Question 2 of 4\n${menu}`,
    `${menu}\nSpace to toggle · Enter to select`,
    "Which targets?\n❯ 1. [ ] Local\n  2. [x] Staging\nEnter to select",
    "Enter your answer:\n❯ \nEnter to submit",
    "Which target?\n1. Local\n2. Staging\nEnter to select",
    "Which target?\n❯ 1. Local\n❯ 2. Staging",
  ]) expect(detectHerdrAsk(output(text))).toBeNull();
});

test("distinguishes durable trust and refusal without guessing from choice order", () => {
  for (const label of ["Yes", "Allow once", "Proceed", "Run this command", "Approve"]) expect(choiceTone(label)).toBe("approve");
  for (const label of ["Always permit", "Yes, and don’t ask again", "Trust this project", "Approve bash for this session", "Yes, allow all edits"]) expect(choiceTone(label)).toBe("trust");
  for (const label of ["No", "Deny", "Reject", "Cancel", "Exit", "Decline", "Not now", "Don't run this", "Never allow again"]) expect(choiceTone(label)).toBe("deny");
  expect(choiceTone("Use the second design")).toBe("neutral");
});

const row = (value: unknown) => `${JSON.stringify(value)}\n`;
const omp = (role: string, content: unknown) => row({ type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role, content } });
const claude = (role: string, content: unknown) => row({ type: role, message: { role, content } });
const text = (value: string) => ({ type: "text", text: value });
const ompFolder = (dir: string) => join(dir, ".omp", "agent", "sessions", "sample");

test("reads omp records at byte offsets and resolves a pending tool by the same ID in a later poll", async () => {
  const dir = tempDir();
  try {
    mkdirSync(ompFolder(dir), { recursive: true });
    const file = join(ompFolder(dir), "session.jsonl");
    const reader = new HerdrChatReader(dir);
    const ref = { agent: "omp", kind: "path", value: file };
    const head = row({ type: "title", title: "샘플" }) + omp("user", [text("<system-reminder>hide this</system-reminder>\n# Task\n결과 확인\n\n# Rules\n- Work only inside the current directory; follow its AGENTS.md and project conventions.\nInternal rules")]) +
      row({ type: "custom_message", display: true, content: "harness event body" }) + row({ type: "credential_pin", hash: "credential metadata" });
    const call = omp("assistant", [text("실행합니다."), { type: "thinking", thinking: "private reasoning" },
      { type: "toolCall", id: "cmd", name: "bash", arguments: { command: "echo sample\nprivate second line", token: "unknown secret arg" } }]);
    const result = row({ type: "message", message: { role: "toolResult", toolCallId: "cmd", isError: true, content: [text("private tool output")] } });
    writeFileSync(file, head + call + result.slice(0, -1)); // A writer has not committed the final line yet.
    const first = parse(HerdrChat, await reader.read(PANE, ref, null));
    expect(first).toMatchObject({ source: "omp", title: "샘플", cursor: String(Buffer.byteLength(head + call)), reset: false });
    expect(first.items).toEqual([
      { id: `${Buffer.byteLength(row({ type: "title", title: "샘플" }))}:0`, at: 1767225600000, kind: "user", text: "결과 확인" },
      { id: `${Buffer.byteLength(head)}:0`, at: 1767225600000, kind: "agent", text: "실행합니다." },
      { id: `${Buffer.byteLength(head)}:1`, at: 1767225600000, kind: "thinking" },
      { id: `${Buffer.byteLength(head)}:2`, at: 1767225600000, kind: "tool", name: "bash", summary: "echo sample", ok: null },
    ]);
    const tail = "\n" + row({ type: "compaction", summary: "compactor raw content" }) + omp("assistant", [text("끝냈습니다.")]);
    appendFileSync(file, tail);
    const second = await reader.read(PANE, ref, first.cursor);
    expect(second.items).toMatchObject([{ id: first.items[3]!.id, kind: "tool", ok: false }, { kind: "note", text: "대화 기록 압축" }, { kind: "agent", text: "끝냈습니다." }]);
    expect(second.cursor).toBe(String(Buffer.byteLength(head + call + result.slice(0, -1) + tail)));
    expect((await reader.read(PANE, ref, second.cursor)).items).toEqual([]);
    const cold = await new HerdrChatReader(dir).read(PANE, ref, first.cursor);
    expect(cold.items).toEqual(second.items);
    expect(JSON.stringify([first, second])).not.toMatch(/private|credential metadata|unknown secret arg|compactor raw/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("looks up a Claude session ID, filters metadata and redacts credentials even in visible text", async () => {
  const dir = tempDir();
  try {
    const project = join(dir, ".claude", "projects", "sample");
    mkdirSync(project, { recursive: true });
    const file = join(project, "session-id.jsonl");
    const first = row({ type: "custom-title", customTitle: "Claude 작업" }) +
      claude("user", "<local-command-stdout>hidden slash output</local-command-stdout>\n작업") +
      row({ type: "user", isMeta: true, message: { role: "user", content: "hidden injection" } }) +
      claude("assistant", [{ type: "redacted_thinking", data: "reasoning bytes" },
        { type: "tool_use", id: "read", name: "Read", input: { file_path: "/work/readme", content: "body of input" } }]) +
      claude("user", [{ type: "tool_result", tool_use_id: "read", content: "tool output body" }]);
    const last = claude("assistant", [text("Authorization: Bearer ABCDEFG1234567890\nTOKEN=private-value\nsk-ant-A123456789012345\n완료")]);
    writeFileSync(file, first + last);
    const reader = new HerdrChatReader(dir);
    const ref = { agent: "claude", kind: "id", value: "session-id" };
    const chat = await reader.read(PANE, ref, null);
    expect(chat).toMatchObject({ source: "claude", title: "Claude 작업", cursor: String(Buffer.byteLength(first + last)), items: [
      { kind: "user", text: "작업" }, { kind: "thinking" }, { kind: "tool", name: "Read", summary: "/work/readme", ok: true },
      { kind: "agent", text: "Authorization: Bearer [redacted]\nTOKEN=[redacted]\n[redacted]\n완료" },
    ] });
    expect(JSON.stringify(chat)).not.toMatch(/hidden|reasoning bytes|output body|body of input|private-value/);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("starts at a complete tail line, caps UTF-8 text, and resets after truncate or replace", async () => {
  const dir = tempDir();
  try {
    mkdirSync(ompFolder(dir), { recursive: true });
    const file = join(ompFolder(dir), "log.jsonl");
    const reader = new HerdrChatReader(dir);
    const ref = { agent: "omp", kind: "path", value: file };
    const head = row({ type: "title", title: "Retained title" }) + omp("user", "oldest") + omp("user", `old oversized ${"A".repeat(1024 * 1024)}`);
    const tail = omp("assistant", "가😀".repeat(2_000));
    writeFileSync(file, head + tail + '{"type":');
    const initial = await reader.read(PANE, ref, null);
    expect(initial).toMatchObject({ title: "Retained title", cursor: String(Buffer.byteLength(head + tail)), reset: false });
    expect(initial.items).toHaveLength(1);
    const item = initial.items[0]!;
    expect(item.id).toBe(`${Buffer.byteLength(head)}:0`);
    expect(item.kind).toBe("agent");
    if (item.kind !== "agent") throw Error("unexpected item type");
    expect(Buffer.byteLength(item.text)).toBeLessThanOrEqual(8192);
    expect(item.text).not.toContain("�");

    writeFileSync(file, omp("assistant", "new conversation"));
    const truncated = await reader.read(PANE, ref, initial.cursor);
    expect(truncated).toMatchObject({ reset: true, title: null, items: [{ kind: "agent", text: "new conversation" }] });
    renameSync(file, `${file}.old`);
    writeFileSync(file, omp("assistant", "rotated conversation with a longer record"));
    expect(await reader.read(PANE, ref, truncated.cursor)).toMatchObject({ reset: true, items: [{ kind: "agent", text: "rotated conversation with a longer record" }] });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("never reads paths outside an agent's root, symlink escapes, directories or a non-jsonl file", async () => {
  const dir = tempDir();
  try {
    const folder = ompFolder(dir);
    mkdirSync(folder, { recursive: true });
    const outside = join(dir, "elsewhere.jsonl");
    const nonJsonl = join(folder, "nope.txt");
    const escape = join(folder, "escape.jsonl");
    const wrongTarget = join(folder, "wrong-target.jsonl");
    const directory = join(folder, "directory.jsonl");
    writeFileSync(outside, omp("user", "forbidden"));
    writeFileSync(nonJsonl, omp("user", "forbidden"));
    mkdirSync(directory);
    symlinkSync(outside, escape);
    symlinkSync(nonJsonl, wrongTarget);
    const reader = new HerdrChatReader(dir);
    for (const path of [outside, nonJsonl, escape, wrongTarget, directory, "relative.jsonl"]) {
      expect(await reader.read(PANE, { agent: "omp", kind: "path", value: path }, null)).toMatchObject({ source: null, items: [], cursor: "0" });
    }
    expect(await reader.read(PANE, { agent: "claude", kind: "id", value: "../escape" }, null)).toMatchObject({ source: null, items: [], cursor: "0" });
    expect(await reader.read(PANE, { agent: "unknown", kind: "path", value: outside }, null)).toMatchObject({ source: null, items: [], cursor: "0" });
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

test("authenticates ask, answer and chat; rejects stale answers without sending and batches the matching keys once", async () => {
  const dir = tempDir();
  const cli = join(dir, "herdr");
  const log = join(dir, "keys");
  mkdirSync(ompFolder(dir), { recursive: true });
  const file = join(ompFolder(dir), "session.jsonl");
  writeFileSync(file, omp("user", "안녕"));
  writeFileSync(join(dir, "screen"), OMP_APPROVAL);
  writeFileSync(join(dir, "panes"), JSON.stringify({ result: { panes: [{ pane_id: PANE, agent: "omp", agent_session: { agent: "omp", kind: "path", value: file } }] } }));
  writeFileSync(cli, `#!/bin/sh
case "$*" in
  '--session isolated api snapshot') echo '{"result":{"snapshot":{"workspaces":[{"workspace_id":"w1"}],"tabs":[{"workspace_id":"w1","tab_id":"w1:t1"}],"panes":[{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1","agent":"omp","agent_status":"blocked"},{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2","agent":"omp","agent_status":"idle"}]}}}' ;;
  '--session isolated pane read w1:p1 '*) cat '${join(dir, "screen")}' ;;
  '--session isolated pane list --workspace w1') cat '${join(dir, "panes")}' ;;
  '--session isolated pane send-keys '*) shift 4; printf '%s\\n' "$*" >> '${log}'; echo '{}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(cli, 0o700);
  const h = harness(":memory:");
  const config: Config = { root: dir, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const ownerToken = "test-herdr-owner";
  const server = startServer({ core: h.core, config, ownerToken, documents: null, skills: null, herdr: new Herdr(cli, { prefs: () => ({ session: "isolated", agent: "omp", notify: "off" }), transcriptHome: dir }) });
  const request = (path: string, body?: unknown, token = ownerToken) => fetch(`http://127.0.0.1:${server.port}/api/herdr/${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  try {
    expect((await request(`ask?pane=${PANE}`, undefined, "wrong")).status).toBe(401);
    expect((await request(`chat?pane=${PANE}`, undefined, "wrong")).status).toBe(401);
    expect((await request("answer", { pane: PANE, title: "Allow tool: bash", index: 2 }, "wrong")).status).toBe(401);
    const ask = parse(HerdrAsk, await (await request(`ask?pane=${PANE}`)).json());
    expect(ask.selected).toBe(0);
    expect(await (await request("ask?pane=w1:p2")).json()).toBeNull();
    const chat = parse(HerdrChat, await (await request(`chat?pane=${PANE}&path=/ignore-me`)).json());
    expect(chat.items).toMatchObject([{ kind: "user", text: "안녕" }]);
    expect((await request("answer", { pane: PANE, title: "old", index: 2 })).status).toBe(409);
    for (const index of [-1, 3, 100]) expect((await request("answer", { pane: PANE, title: ask.title, index })).status).toBe(409);
    expect((await request("answer", { pane: PANE, title: ask.title, index: 1.5 })).status).toBe(400);
    expect(await Bun.file(log).exists()).toBe(false);
    expect(parse(HerdrPaneView, await (await request("answer", { pane: PANE, title: ask.title, index: 2 })).json()).id).toBe(PANE);
    expect(readFileSync(log, "utf8")).toBe("w1:p1 down down enter\n");
  } finally {
    await server.stop();
    rmSync(dir, { force: true, recursive: true });
  }
});
