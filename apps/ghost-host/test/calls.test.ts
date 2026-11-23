import { describe, expect, test } from "bun:test";
import type { Call, CallEngine } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import type { CallEnginePort } from "../src/core/calls.ts";
import { execute } from "../src/core/commands.ts";
import { snapshot } from "../src/core/state.ts";
import { harness } from "./support.ts";

const owner = new Access({ kind: "owner" });
const context = { publicOrigin: "http://localhost", documents: null };

function setup(engines: Partial<Record<CallEngine, string | null>> = { local: null, realtime: null }) {
  const h = harness();
  const hungUp: Call[] = [];
  for (const [engine, unavailable] of Object.entries(engines) as [CallEngine, string | null][]) {
    const port: CallEnginePort = { unavailable: () => unavailable, hangup: async (call) => void hungUp.push(call) };
    h.core.calls.register(engine, port);
  }
  const ghost = h.core.createGhost({ name: "Main", persona: "You lead.", model: { provider: "test", model: "test-model" }, isDefault: true });
  const send = (command: Parameters<typeof execute>[2]["command"], requestId: string = crypto.randomUUID()) => execute(h.core, owner, { requestId, command }, context);
  return { ...h, ghost, hungUp, send };
}

describe("voice calls", () => {
  test("a started call speaks into the Ghost's direct conversation and the retry is the same call", async () => {
    const t = setup();
    const requestId = crypto.randomUUID();
    const first = await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" }, requestId);
    const again = await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" }, requestId);
    expect(again).toEqual(first);
    const call = t.core.calls.get(first.callId as string);
    expect(call).toMatchObject({ ghostId: t.ghost.id, conversationId: t.ghost.directConversationId, engine: "local", status: "connecting", answeredAt: null, endedAt: null });
    expect(t.core.calls.list()).toHaveLength(1);
    expect(snapshot(t.core, owner).calls).toEqual([call]);
  });

  test("only one call is live at a time, and a new one starts once the first is over", async () => {
    const t = setup();
    const first = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    await expect(t.send({ type: "call.start", ghostId: t.ghost.id, engine: "realtime" })).rejects.toThrow("End the current call");
    await t.send({ type: "call.end", callId: first });
    const second = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "realtime" })).callId as string;
    expect(second).not.toBe(first);
    expect(t.core.calls.list().map((call) => call.status)).toEqual(["connecting", "ended"]);
  });

  test("an engine that cannot take calls says why and no call is recorded", async () => {
    const t = setup({ local: "The speech server is not running.", realtime: null });
    await expect(t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).rejects.toThrow("speech server is not running");
    expect(t.core.calls.list()).toEqual([]);
    const uninstalled = setup({ local: null });
    await expect(uninstalled.send({ type: "call.start", ghostId: uninstalled.ghost.id, engine: "realtime" })).rejects.toThrow("not installed");
  });

  test("without an engine the owner's default is used, and voice.set changes it", async () => {
    const t = setup();
    expect(snapshot(t.core, owner).settings.voice).toEqual({ engine: "realtime", voice: "default" });
    await t.send({ type: "voice.set", engine: "local", voice: "Sohee" });
    expect(snapshot(t.core, owner).settings.voice).toEqual({ engine: "local", voice: "Sohee" });
    const call = t.core.calls.get((await t.send({ type: "call.start", ghostId: t.ghost.id })).callId as string);
    expect(call.engine).toBe("local");
  });

  test("activate starts the clock once; hanging up releases the engine once and counts the seconds", async () => {
    const t = setup();
    const id = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    await t.send({ type: "call.activate", callId: id });
    const answered = t.core.calls.get(id).answeredAt;
    expect(answered).not.toBeNull();
    await t.send({ type: "call.activate", callId: id });
    expect(t.core.calls.get(id).answeredAt).toBe(answered);
    await t.send({ type: "call.end", callId: id });
    await t.send({ type: "call.end", callId: id });
    expect(t.core.calls.get(id)).toMatchObject({ status: "ended", endReason: "hangup", error: null });
    expect(t.core.calls.get(id).seconds).toBeGreaterThanOrEqual(0);
    expect(t.hungUp.map((call) => call.id)).toEqual([id]);
    await expect(t.send({ type: "call.activate", callId: id })).rejects.toThrow("ended");
  });

  test("a call that never connects, and one that runs out of time, are closed by their deadlines", async () => {
    const t = setup();
    const never = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    t.core.calls.expire(never);
    expect(t.core.calls.get(never)).toMatchObject({ status: "failed", endReason: "unavailable", seconds: 0 });
    const long = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    await t.send({ type: "call.activate", callId: long });
    t.core.calls.expire(long);
    expect(t.core.calls.get(long)).toMatchObject({ status: "ended", endReason: "limit", error: null });
    t.core.calls.expire(long);
    expect(t.hungUp.map((call) => call.id)).toEqual([never, long]);
  });

  test("a restart fails whatever was live and never resumes it", async () => {
    const t = setup();
    const id = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    await t.send({ type: "call.activate", callId: id });
    t.core.calls.recover();
    expect(t.core.calls.get(id)).toMatchObject({ status: "failed", endReason: "interrupted" });
    expect(t.core.calls.active()).toBeNull();
    expect(t.hungUp).toEqual([]);
  });

  test("a spoken message is tagged with its live call; a stranger's or an ended call is refused", async () => {
    const t = setup();
    const id = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    await t.send({ type: "call.activate", callId: id });
    await t.send({ type: "message.send", conversationId: t.ghost.directConversationId, text: "안녕", callId: id });
    expect(t.engine.to(t.ghost.directConversationId).at(-1)).toMatchObject({ text: "안녕", origin: "owner", callId: id });
    const other = t.core.createGhost({ name: "Other", persona: "You help.", model: { provider: "test", model: "test-model" } });
    await expect(t.send({ type: "message.send", conversationId: other.directConversationId, text: "hi", callId: id })).rejects.toThrow("not a call in this conversation");
    await t.send({ type: "call.end", callId: id });
    await expect(t.send({ type: "message.send", conversationId: t.ghost.directConversationId, text: "late", callId: id })).rejects.toThrow("ended");
    await t.send({ type: "message.send", conversationId: t.ghost.directConversationId, text: "typed after the call" });
    expect(t.engine.to(t.ghost.directConversationId).at(-1)?.callId).toBeUndefined();
  });

  test("the engine re-checks the call at admission, so a held spoken turn cannot land after hangup", async () => {
    const t = setup();
    const id = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    const authorizers: (undefined | (() => void))[] = [];
    const submit = t.engine.submit.bind(t.engine);
    t.engine.submit = (conversationId, submission, authorize) => (authorizers.push(authorize), submit(conversationId, submission, authorize));
    await t.send({ type: "message.send", conversationId: t.ghost.directConversationId, text: "안녕", callId: id });
    await t.send({ type: "message.send", conversationId: t.ghost.directConversationId, text: "typed" });
    expect(authorizers[0]).toBeDefined();
    expect(authorizers[1]).toBeUndefined();
    expect(() => authorizers[0]!()).not.toThrow();
    await t.send({ type: "call.end", callId: id });
    expect(() => authorizers[0]!()).toThrow("ended");
  });

  test("ended calls are trimmed but a live one is never dropped", async () => {
    const t = setup();
    for (let i = 0; i < 55; i++) {
      const id = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
      await t.send({ type: "call.end", callId: id });
    }
    const live = (await t.send({ type: "call.start", ghostId: t.ghost.id, engine: "local" })).callId as string;
    const calls = t.core.calls.list();
    expect(calls).toHaveLength(51);
    expect(calls.filter((call) => call.status === "connecting").map((call) => call.id)).toEqual([live]);
  });
});
