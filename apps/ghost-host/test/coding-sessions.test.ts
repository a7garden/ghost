import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall, getCurrentTools, getSystemMessageText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { CodingEvent, CodingItem, CodingSession, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import { CodingSessions } from "../src/coding/index.ts";
import type { CodingRequester, CodingSettled } from "../src/coding/ports.ts";
import { loadConfig } from "../src/config.ts";
import { Core } from "../src/core/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { hostIsIdle } from "../src/update/index.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const owner = { kind: "owner" } as const;
const ghost: CodingRequester = { kind: "ghost", ghostId: "test-ghost", workId: "test-work", callId: "test-call" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
}

// These integration tests drive real Bun HTTP and Seatbelt subprocesses; wait on observed state,
// not a fixed startup delay.
async function until<T>(read: () => T | undefined | null | false, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const value = read();
    if (value) return value;
    await Bun.sleep(5);
  } while (Date.now() < end);
  throw new Error("coding test timed out waiting for an event");
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ghost-embedded-"));
  const repo = join(dir, "project"), root = join(dir, "host");
  mkdirSync(repo); mkdirSync(root);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "index.txt"), "before\n");
  writeFileSync(join(repo, "preview.html"), "<h1>Mockup</h1>");
  writeFileSync(join(repo, "preview.png"), Buffer.from(png, "base64"));
  writeFileSync(join(repo, "AGENTS.md"), "ALLOWED_AGENTS_CONTEXT");
  writeFileSync(join(repo, "CLAUDE.md"), "ALLOWED_CLAUDE_CONTEXT");
  writeFileSync(join(dir, "AGENTS.md"), "FORBIDDEN_PARENT_CONTEXT");
  mkdirSync(join(repo, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(repo, ".pi", "SYSTEM.md"), "FORBIDDEN_PROJECT_CONTEXT");
  writeFileSync(join(repo, ".pi", "extensions", "unexpected.ts"), "throw new Error('project extension must not load')");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base");
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: console.error });
  core.attach(new FakeEngine());
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", input: ["text", "image"], reasoning: true }] });
  ledger.tx(() => {
    ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: "http://127.0.0.1:9/v1", models: [{ id: "faux-1", name: "Faux 1", reasoning: true }] });
    ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  });
  secrets.put("faux", "faux-key");
  const create = (real = false) => new CodingSessions({ root, ledger, settings: () => ledger.settings(), secrets, catalog: core.catalog, log: console.error,
    authorizeGhost: () => {}, sandboxRoot: join(dir, "sandboxes"),
    ...(real ? {} : { provider: () => faux.provider }),
  });
  const sessions = create();
  core.setCodingSessions(sessions);
  return { core, dir, repo, root, ledger, secrets, faux, sessions, create,
    async close() { await sessions.shutdown(); core.stop(); ledger.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("an owner session with no folder works in its own empty sandbox; a Ghost still needs a repository", async () => {
  const f = fixture();
  try {
    const a = await f.sessions.create({}, owner), b = await f.sessions.create({}, owner);
    expect(a).toMatchObject({ title: "샌드박스", repo: null, branch: null, ghostId: null });
    expect(a.cwd.startsWith(join(realpathSync(f.dir), "sandboxes"))).toBe(true);
    expect(readdirSync(a.cwd)).toEqual([]);
    expect(b.cwd).not.toBe(a.cwd);
    // The first instruction names a sandbox session; a later one and an explicit title do not.
    await f.sessions.prompt(a.id, { text: "\n## 로그인 화면의 제목과 입력 순서를 정리해서 한 줄로 로그인할 수 있게 해 주세요" });
    expect(f.sessions.get(a.id)?.title).toBe("로그인 화면의 제목과 입력 순서를 정리해서 한 줄로 로그인할 수 있게 해 주…".slice(0, 39).trimEnd() + "…");
    const named = await f.sessions.create({ title: "내 이름" }, owner);
    await f.sessions.prompt(named.id, { text: "다른 이름이 되면 안 됨" });
    expect(f.sessions.get(named.id)?.title).toBe("내 이름");
    // A session opened on a folder is also named by its first instruction instead of keeping the folder name.
    const folder = await f.sessions.create({ cwd: f.repo }, owner);
    expect(folder).toMatchObject({ title: "project", ghostId: null });
    await f.sessions.prompt(folder.id, { text: "버튼 정렬을 바로잡아 주세요" });
    expect(f.sessions.get(folder.id)?.title).toBe("버튼 정렬을 바로잡아 주세요");
    await expect(f.sessions.create({}, { kind: "ghost", ghostId: "g", workId: "w", callId: "c" })).rejects.toMatchObject({ code: "invalid" });
  } finally { await f.close(); }
});

test("faux provider streams thinking/text, sees the image, and persists edit and write patches and transcript IDs", async () => {
  const f = fixture();
  try {
    const session = await f.sessions.create({ repo: f.repo, branch: "coding-test" }, owner);
    expect(session.cwd).not.toBe(f.repo);
    expect(session.base).toMatch(/^[0-9a-f]{40}$/);
    const events: CodingEvent[] = [];
    const outcomes: CodingSettled[] = [];
    f.sessions.subscribe(session.id, event => events.push(event));
    f.sessions.onSettled(outcome => outcomes.push(outcome));
    f.faux.setResponses([
      (context) => {
        const system = context.messages.filter(message => message.role === "system").map(getSystemMessageText).join("\n");
        expect(system).toContain("ALLOWED_AGENTS_CONTEXT");
        expect(system).toContain("ALLOWED_CLAUDE_CONTEXT");
        expect(system).not.toContain("FORBIDDEN_");
        const user = context.messages.find(msg => msg.role === "user");
        expect(user?.role === "user" && Array.isArray(user.content) && user.content.some(block => block.type === "image" && block.mimeType === "image/png")).toBe(true);
        return fauxAssistantMessage([fauxThinking("considering"), fauxText("I will edit."), fauxToolCall("edit", { path: "index.txt", edits: [{ oldText: "before", newText: "after" }] })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("write", { path: "generated.txt", content: "new\n" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "preview.png" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Edited."),
    ]);
    expect(await f.sessions.prompt(session.id, { text: "Fix it", images: [{ data: png, mimeType: "image/png", name: "input.png" }] })).toEqual({ disposition: "started" });
    await until(() => outcomes[0]);
    expect(outcomes.map(({ outcome, turn, finalText }) => ({ outcome, turn, finalText }))).toEqual([{ outcome: "done", turn: 1, finalText: "Edited." }]);
    const items = f.sessions.items(session.id, { after: "" });
    const assistantId = items.find(item => item.kind === "assistant" && item.text === "I will edit.")!.id;
    expect(events.some(event => event.type === "item" && event.item.id === assistantId && event.item.kind === "assistant" && event.item.streaming)).toBe(true);
    expect(items.some(item => item.kind === "thinking" && item.text === "considering")).toBe(true);
    expect(items.find(item => item.kind === "tool" && item.tool === "edit")).toMatchObject({ status: "done", diff: expect.stringContaining("+after") });
    expect(items.find(item => item.kind === "tool" && item.tool === "write")).toMatchObject({ status: "done", diff: expect.stringContaining("+new") });
    const user = items.find(item => item.kind === "user");
    if (user?.kind !== "user") throw new Error("missing user message");
    expect(user.images[0]?.label).toBe("input.png");
    expect(readFileSync(f.sessions.file(session.id, user.images[0]!.path)!.path).toString("base64")).toBe(png);
    expect(items.find(item => item.kind === "tool" && item.tool === "read")).toMatchObject({ status: "done", images: [{ path: user.images[0]!.path, mimeType: "image/png" }] });
    expect(readFileSync(join(f.repo, "index.txt"), "utf8")).toBe("before\n");
    expect(await f.sessions.changes(session.id)).toMatchObject({ dirty: true, diff: expect.stringContaining("+after"), files: [
      { path: "index.txt", status: "modified", additions: 1, deletions: 1 },
      { path: "generated.txt", status: "untracked", additions: 0, deletions: 0 },
    ] });
    await f.sessions.shutdown();
    const again = f.create();
    try {
      expect(again.items(session.id, { after: "" })).toEqual(items);
      expect(again.items(session.id, { after: items[0]!.id, limit: 1 })).toEqual(items.slice(1, 2));
    } finally { await again.shutdown(); }
  } finally { await f.close(); }
});

test("owner routes authenticate, stream a snapshot and items, and answer a paused turn", async () => {
  const f = fixture();
  const server = startServer({ core: f.core, config: { ...loadConfig({}, f.root), host: "127.0.0.1", port: 0 }, ownerToken: "owner-test", documents: null, skills: null });
  const base = `http://127.0.0.1:${server.port}/api/coding`;
  const request = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, { method, headers: { authorization: "Bearer owner-test", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const streamAbort = new AbortController();
  try {
    expect((await fetch(`${base}/sessions`)).status).toBe(401);
    expect(await (await request("/models")).json()).toMatchObject({ models: [expect.objectContaining({ provider: "faux", model: "faux-1" })] });
    expect((await request("/sessions", "POST", { cwd: f.repo, repo: f.repo })).status).toBe(400);
    const response = await request("/sessions", "POST", { cwd: f.repo, title: "Draft" });
    expect(response.status).toBe(201);
    const session = parse(CodingSession, await response.json());
    const route = `/sessions/${session.id}`;
    expect(await (await request("/sessions")).json()).toEqual([session]);
    expect(await (await request(route)).json()).toEqual(session);
    expect(await (await request(route, "PATCH", { title: "Renamed", thinking: "off" })).json()).toMatchObject({ title: "Renamed", thinking: "off" });
    const results: string[] = [];
    f.sessions.onSettled(event => results.push(event.outcome));
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_owner_choices", { title: "Pick a mockup", options: [{ id: "design", label: "Mockup", html: "preview.html" }] }), { stopReason: "toolUse" }),
      context => {
        const latest = context.messages.at(-1);
        expect(latest?.role === "toolResult" && latest.content[0]).toMatchObject({ text: '{"optionId":"design"}' });
        return fauxAssistantMessage("Chosen.");
      },
    ]);
    const events = await fetch(`${base}${route}/events`, { headers: { authorization: "Bearer owner-test" }, signal: streamAbort.signal });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const received: CodingEvent[] = [];
    const readEvents = async () => {
      let lineEnd: number;
      while ((lineEnd = buffered.indexOf("\n\n")) < 0) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("coding event stream closed early");
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const line = buffered.slice(0, lineEnd);
      buffered = buffered.slice(lineEnd + 2);
      if (line.startsWith("data: ")) received.push(parse(CodingEvent, JSON.parse(line.slice(6))));
    };
    await readEvents();
    expect(received[0]).toMatchObject({ type: "session", session: { title: "Renamed" } });
    expect(await (await request(`${route}/prompt`, "POST", { text: "Choose" })).json()).toEqual({ disposition: "started" });
    while (!received.some(event => event.type === "session" && event.session.state === "waiting")) await readEvents();
    const waiting = parse(CodingSession, await (await request(route)).json());
    expect(waiting.pendingDialog).toMatchObject({ kind: "choices", options: [{ id: "design", html: "preview.html" }] });
    expect(hostIsIdle(f.core)).toBe(false);
    expect((await request(`${route}/dialogs/${waiting.pendingDialog!.id}`, "POST", { optionId: "unknown" })).status).toBe(400);
    const preview = await request(`${route}/file?path=preview.html`);
    expect(preview.headers.get("content-type")).toContain("text/html");
    expect(preview.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    expect(await preview.text()).toContain("<h1>Mockup</h1>");
    expect((await request(`${route}/file?path=../AGENTS.md`)).status).toBe(404);
    expect(await (await request(`${route}/dialogs/${waiting.pendingDialog!.id}`, "POST", { optionId: "design" })).json()).toEqual({ ok: true });
    await until(() => results.includes("done"));
    expect(results).toEqual(["waiting", "done"]);
    const payload = await (await request(`${route}/items?after=&limit=100`)).json() as { items: unknown[] };
    expect(payload.items.map(item => parse(CodingItem, item))).toContainEqual(expect.objectContaining({ kind: "assistant", text: "Chosen." }));
    expect(await (await request(`${route}/changes`)).json()).toMatchObject({ files: [], dirty: false });
    expect(await (await request(`${route}/abort`, "POST")).json()).toMatchObject({ state: "idle", turn: 1 });
    expect(await (await request(`${route}/close`, "POST")).json()).toMatchObject({ state: "closed" });
    await reader.cancel();
  } finally { streamAbort.abort(); await server.stop(); await f.close(); }
});

test("parallel scouts own separate transcript items and both abort with the parent", async () => {
  const f = fixture();
  try {
    const session = await f.sessions.create({ repo: f.repo }, owner);
    let ready = 0, aborted = 0;
    const child: FauxResponseFactory = async (context, options) => {
      expect(getCurrentTools(context.messages).map(tool => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
      if (!context.messages.some(message => message.role === "toolResult")) return fauxAssistantMessage(fauxToolCall("read", { path: "index.txt" }), { stopReason: "toolUse" });
      ready++;
      const signal = options!.signal!;
      const { promise, reject } = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true });
      return promise;
    };
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ agent: "scout", task: "First" }, { agent: "scout", task: "Second" }] }), { stopReason: "toolUse" }),
      child, child, child, child,
    ]);
    const outcomes: CodingSettled[] = [];
    f.sessions.onSettled(report => outcomes.push(report));
    await f.sessions.prompt(session.id, { text: "Scout" });
    await until(() => ready === 2);
    const items = f.sessions.items(session.id);
    const children = items.filter(item => item.kind === "subagent");
    expect(children.map(item => item.status)).toEqual(["running", "running"]);
    expect(new Set(items.filter(item => item.kind === "tool" && item.subagent).map(item => item.kind === "tool" && item.subagent))).toEqual(new Set(children.map(item => item.id)));
    await f.sessions.abort(session.id);
    expect(aborted).toBe(2);
    expect(outcomes.map(outcome => outcome.outcome)).toEqual(["aborted"]);
    expect(f.sessions.items(session.id).filter(item => item.kind === "subagent").map(item => item.status)).toEqual(["error", "error"]);
  } finally { await f.close(); }
});

test.skipIf(process.platform !== "darwin")("file escapes fail and a Seatbelt refusal needs explicit approval for that call only", async () => {
  const f = fixture();
  try {
    const session = await f.sessions.create({ repo: f.repo }, owner);
    const outside = join(f.root, "outside.txt");
    writeFileSync(outside, "protected");
    symlinkSync(outside, join(session.cwd, "link.txt"));
    const result: CodingSettled[] = [];
    f.sessions.onSettled(report => result.push(report));
    const command = `printf changed > '${outside}'`;
    f.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: outside, content: "bad" }), fauxToolCall("write", { path: "link.txt", content: "bad" }), fauxToolCall("write", { path: "nested/../bad", content: "bad" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Finished."),
    ]);
    await f.sessions.prompt(session.id, { text: "Try the same command twice" });
    const first = await until(() => f.sessions.get(session.id)?.pendingDialog);
    expect(first.kind).toBe("approval");
    expect(f.sessions.items(session.id).flatMap(item => item.kind === "tool" && item.tool === "write" ? [item.status] : [])).toEqual(["error", "error", "error"]);
    expect(f.sessions.file(session.id, "link.txt")).toBeNull();
    expect(readFileSync(outside, "utf8")).toBe("protected");
    await f.sessions.answer(session.id, first.id, { value: "yes" });
    const second = await until(() => f.sessions.get(session.id)?.pendingDialog);
    expect(second.id).not.toBe(first.id);
    expect(readFileSync(outside, "utf8")).toBe("changed");
    writeFileSync(outside, "protected again");
    await f.sessions.answer(session.id, second.id, { value: "no" });
    await until(() => result.some(report => report.outcome === "done"));
    expect(readFileSync(outside, "utf8")).toBe("protected again");
  } finally { await f.close(); }
});

test("restart does not resend a working Ghost turn and stores interruption evidence once", async () => {
  const f = fixture();
  try {
    const session = await f.sessions.create({ repo: f.repo }, ghost);
    expect(session.ghostId).toBe("test-ghost");
    f.faux.setResponses([async (_context, options) => {
      const { promise, reject } = Promise.withResolvers<never>();
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      return promise;
    }]);
    await f.sessions.prompt(session.id, { text: "This must never replay" });
    await until(() => f.faux.state.callCount === 1);
    await f.sessions.shutdown();
    // A record stored before ghostId existed regains it from its requester on load.
    const stored = f.ledger.codingSessions()[0]!;
    delete (stored.session as Omit<CodingSession, "ghostId"> & { ghostId?: string | null }).ghostId;
    f.ledger.putCodingSession(stored);
    const restarted = f.create();
    try {
      const reports: CodingSettled[] = [];
      restarted.onSettled(report => reports.push(report));
      expect(restarted.get(session.id)?.ghostId).toBe("test-ghost");
      expect(restarted.get(session.id)?.state).toBe("failed");
      expect(restarted.items(session.id).filter(item => item.kind === "notice")).toMatchObject([{ text: expect.stringContaining("턴이 중단되었습니다") }]);
      expect(reports.map(report => [report.turn, report.outcome])).toEqual([[1, "interrupted"]]);
      expect(f.faux.state.callCount).toBe(1);
      f.faux.setResponses([context => {
        expect(context.messages.filter(message => message.role === "user")).toHaveLength(2);
        return fauxAssistantMessage("Recovered.");
      }]);
      await restarted.prompt(session.id, { text: "Continue manually" });
      await until(() => reports[1]);
      expect(reports[1]).toMatchObject({ turn: 2, outcome: "done", finalText: "Recovered." });
      expect(f.ledger.codingSessions()[0]?.reports.map(report => report.outcome)).toEqual(["interrupted", "done"]);
    } finally { await restarted.shutdown(); }
  } finally { await f.close(); }
});

test("the native Ghost provider uses the configured relay URL and its live Ghost credential", async () => {
  const f = fixture();
  const calls: { path: string; authorization: string | null; model: string }[] = [];
  const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const { model } = await request.json() as { model: string };
    calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), model });
    const chunk = { id: "relay-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "Relay answered." }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const live = f.create(true);
  try {
    f.ledger.tx(() => f.ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Relay", baseUrl: `http://127.0.0.1:${relay.port}/custom`, models: [{ id: "relay-model", name: "Relay model" }] }));
    const session = await live.create({ cwd: f.repo, model: { provider: "faux", model: "relay-model" } }, owner);
    f.secrets.put("faux", "rotated-key");
    const reports: CodingSettled[] = [];
    live.onSettled(report => reports.push(report));
    await live.prompt(session.id, { text: "Probe" });
    await until(() => reports[0]);
    expect(reports[0]).toMatchObject({ outcome: "done", finalText: "Relay answered." });
    expect(calls).toEqual([{ path: "/custom/chat/completions", authorization: "Bearer rotated-key", model: "relay-model" }]);
  } finally { await live.shutdown(); await relay.stop(true); await f.close(); }
});
