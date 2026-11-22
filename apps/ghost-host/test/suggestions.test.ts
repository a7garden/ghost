import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { NextMessageSuggestions, parse, type HerdrChat, type HerdrPaneView, type Message } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import type { Engine, TranscriptPage } from "../src/core/ports.ts";
import { Suggestions } from "../src/core/suggestions.ts";
import { parseComposerPrediction, parseComposerPredictions } from "../src/engine/composer-prediction.ts";
import { Herdr } from "../src/integrations/herdr.ts";
import { FakeEngine, harness, tempDir } from "./support.ts";

test("normalizes single suggestions like omp, including quotes, controls, spaces and the length limit", () => {
  expect(parseComposerPrediction('  " 계속\t  진행해  "  ')).toBe("계속 진행해");
  expect(parseComposerPrediction("“좋아”")).toBe("좋아");
  expect(parseComposerPrediction("`go on`")).toBe("go on");
  expect(parseComposerPrediction("\x1b[31mGo\x1b[0m\0\n on")).toBe("Go on");
  expect(parseComposerPrediction("NO_PREDICTION")).toBeUndefined();
  expect(parseComposerPrediction("x".repeat(501))).toBeUndefined();
});

test("strips a preamble and list markers, dedupes alternatives, caps the choices and honors a leading skip", () => {
  expect(parseComposerPredictions('Here are options:\r\n1. "Ship it!"\r\n2) ship it?\n* “테스트해”\n• `결과 보여줘`\n- Next', 3)).toEqual(["Ship it!", "테스트해", "결과 보여줘"]);
  expect(parseComposerPredictions("Options:\n- NO_PREDICTION\n- Not offered", 3)).toBeUndefined();
  expect(parseComposerPredictions("- Continue\n- NO_PREDICTION\n- Why?", 3)).toEqual(["Continue", "Why?"]);
  expect(parseComposerPredictions("\n  ", 3)).toBeUndefined();
});

type SuggestInput = Parameters<NonNullable<Engine["suggest"]>>[0];
class SuggestEngine extends FakeEngine {
  transcript: TranscriptPage = { messages: [], before: null, live: null };
  readonly calls: SuggestInput[] = [];
  generate = async (_input: SuggestInput) => ["계속해"];
  override async page() { return this.transcript; }
  async suggest(input: SuggestInput) {
    this.calls.push(input);
    return this.generate(input);
  }
}

const model = { provider: "faux", model: "test" };
const OWNER = "test-suggestions-owner";
const noSuggestions = { suggestions: [] };
const paneId = "w1:p1";

function fixture() {
  const h = harness();
  const engine = new SuggestEngine();
  h.core.attach(engine);
  const ghost = h.core.createGhost({ name: "Suggestion Ghost", persona: "" });
  const id = ghost.directConversationId;
  const message = (entry: string, role: Message["role"], text: string): Message => ({
    id: entry, conversationId: id, role, text, origin: role === "user" ? "owner" : null,
    createdAt: 1, toolCalls: [], tool: null, attachments: [],
  });
  const messages = [message("1", "user", "확인해줘"), message("2", "assistant", "확인했어")];
  engine.transcript.messages = messages;
  return { ...h, engine, ghost, id, message, messages };
}

test("suggestion routes authorize transcript reads, persist settings and reuse results for the same anchor", async () => {
  const f = fixture();
  const dir = tempDir();
  const config: Config = { root: dir, host: "127.0.0.1", port: 0, publicOrigin: null, uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null };
  const herdr = new Herdr(null);
  const pane: HerdrPaneView = {
    id: paneId, workspaceId: "w1", tabId: "w1:t1", workspace: "test", tab: "test", title: "test",
    status: "done", agent: "omp", cwd: null, focused: true, owned: false,
  };
  let chat: HerdrChat = {
    pane: paneId, source: "omp", title: null, model: null, cursor: "100", reset: false,
    items: [{ id: "1", kind: "user", at: 1, text: "확인해줘" }, { id: "2", kind: "agent", at: 2, text: "확인했어" }, { id: "3", kind: "thinking", at: 2 }],
  };
  herdr.overview = async () => ({ available: true, note: null, session: "default", workspaces: [{
    id: pane.workspaceId, label: "test", status: "done", worktree: null,
    tabs: [{ id: pane.tabId, label: "test", status: "done", panes: [pane] }],
  }] });
  herdr.chat = async () => chat;
  const server = startServer({ core: f.core, config, ownerToken: OWNER, documents: null, skills: null, herdr });
  const get = (path: string, token = OWNER) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const read = async (path: string) => parse(NextMessageSuggestions, await (await get(path)).json());
  const direct = `/api/suggestions?conversation=${f.id}`;
  const coding = `/api/herdr/suggestions?pane=${paneId}`;
  const update = (settings: { nextMessageSuggestions: boolean; suggestionModel: typeof model | null; codingDelivery: "steer" | "queue" }) => execute(f.core, new Access({ kind: "owner" }), {
    requestId: crypto.randomUUID(), command: { type: "settings.update", ...settings },
  }, { publicOrigin: "http://127.0.0.1", documents: null });
  try {
    expect(f.ledger.settings()).toMatchObject({ nextMessageSuggestions: true, suggestionModel: null, codingDelivery: "steer" });
    expect((await get(direct, "wrong")).status).toBe(401);
    expect((await get(coding, "wrong")).status).toBe(401);
    expect((await get("/api/suggestions")).status).toBe(400);
    expect((await get("/api/herdr/suggestions?pane=invalid")).status).toBe(400);
    expect(await read(direct)).toEqual(noSuggestions);
    expect(await read(coding)).toEqual(noSuggestions);
    expect(f.engine.calls).toHaveLength(0);

    await update({ nextMessageSuggestions: true, suggestionModel: model, codingDelivery: "queue" });
    expect(f.ledger.settings()).toMatchObject({ nextMessageSuggestions: true, suggestionModel: model, codingDelivery: "queue" });
    const seq = f.ledger.seq();
    for (const path of [direct, coding, direct, coding]) {
      expect(await read(path)).toEqual({ suggestions: ["계속해"] });
    }
    expect(f.ledger.seq()).toBe(seq);
    expect(f.engine.calls.map(call => call.messages)).toEqual(Array.from({ length: 2 }, () => [
      { role: "user", text: "확인해줘" }, { role: "assistant", text: "확인했어" },
    ]));

    for (const status of ["working", "blocked"] as const) {
      pane.status = status;
      expect(await read(coding)).toEqual(noSuggestions);
    }
    pane.status = "done";
    chat = { ...chat, items: [...chat.items, { id: "4", kind: "user", at: 3, text: "아직" }] };
    expect(await read(coding)).toEqual(noSuggestions);
    chat = { ...chat, source: null };
    expect(await read(coding)).toEqual(noSuggestions);
    f.engine.transcript.live = { conversationId: f.id, running: true, partial: null, tools: [] };
    expect(await read(direct)).toEqual(noSuggestions);
    f.engine.transcript.live = null;
    f.engine.transcript.messages = [...f.messages, f.message("3", "user", "다음")];
    expect(await read(direct)).toEqual(noSuggestions);
    const review = f.core.newConversation(f.ghost.id, "review", null, "Not direct");
    f.ledger.tx(() => f.ledger.putConversation(review));
    expect(await read(`/api/suggestions?conversation=${review.id}`)).toEqual(noSuggestions);

    f.engine.transcript.messages = [...f.messages, f.message("4", "assistant", "실패하는 새 응답")];
    f.engine.generate = async () => { throw new Error("unavailable"); };
    expect(await read(direct)).toEqual(noSuggestions);
    expect(await read(direct)).toEqual(noSuggestions);
    expect(f.engine.calls).toHaveLength(3);

    await update({ nextMessageSuggestions: false, suggestionModel: null, codingDelivery: "steer" });
    expect(f.ledger.settings()).toMatchObject({ nextMessageSuggestions: false, suggestionModel: null, codingDelivery: "steer" });
    f.engine.transcript.messages = f.messages;
    expect(await read(direct)).toEqual(noSuggestions);
    expect(f.engine.calls).toHaveLength(3);
  } finally {
    await server.stop();
    f.core.stop();
    await f.core.idle();
    f.ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent readers share a flight; the final disconnect aborts it and a later reader asks again", async () => {
  const f = fixture();
  f.ledger.tx(() => f.ledger.putSetting("defaultModel", model));
  const service = new Suggestions(f.core, null);
  const first = new AbortController();
  const second = new AbortController();
  const started = Promise.withResolvers<AbortSignal>();
  const modelReply = Promise.withResolvers<string[]>();
  f.engine.generate = ({ signal }) => {
    started.resolve(signal);
    return modelReply.promise;
  };
  try {
    const a = service.direct(f.id, first.signal);
    const b = service.direct(f.id, second.signal);
    const signal = await started.promise;
    first.abort();
    expect(await a).toEqual(noSuggestions);
    expect(signal.aborted).toBe(false);
    expect(f.engine.calls).toHaveLength(1);
    second.abort();
    expect(await b).toEqual(noSuggestions);
    expect(signal.aborted).toBe(true);
    modelReply.resolve(["arrived too late"]);
    // An abandoned flight is not remembered: coming back to the conversation asks again.
    expect(await service.direct(f.id, new AbortController().signal)).toEqual({ suggestions: ["arrived too late"] });
    expect(f.engine.calls).toHaveLength(2);
  } finally {
    service.close();
    f.core.stop();
    await f.core.idle();
    f.ledger.close();
  }
});
