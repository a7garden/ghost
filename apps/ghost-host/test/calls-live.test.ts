import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Message } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import { CommandError } from "../src/core/errors.ts";
import { createEngine } from "../src/engine/index.ts";
import { createLiveCallEngine } from "../src/integrations/calls-live.ts";
import { harness, tempDir } from "./support.ts";

const KEY = "sk-private-host-key";
const OFFER = "v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=setup:actpass\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
const ANSWER = OFFER.replace("actpass", "active");
const owner = new Access({ kind: "owner" });
const device = new Access({ kind: "device", deviceId: "device-id", name: "iPhone" });
const sessionResult = () => Response.json({ session: { id: "live_id" }, transport: { type: "webrtc", sdp: ANSWER } }, { status: 201 });

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  closes = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly commands = new EventTarget();

  constructor(readonly url: URL, readonly options: { headers: Record<string, string> }) {
    super();
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("not open");
    const value = JSON.parse(data);
    this.sent.push(value);
    this.commands.dispatchEvent(new MessageEvent("command", { data: value }));
  }

  close() {
    this.closes++;
    this.drop();
  }

  drop() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  receive(event: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  transcript(id: string, text: string, start: number, speaker: "input" | "output" = "input") {
    this.receive({ type: `session.${speaker}_transcript.delta`, event_id: id, delta: text, start_ms: start, end_ms: start + 100 });
  }

  delegate(id: string, offset: number) {
    this.receive({ type: "session.delegation.created", event_id: `event-${id}`, offset_ms: offset, delegation: { type: "delegation", target: "client", id } });
  }

  nextCommand(type: string) {
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    const listener = (event: Event) => {
      const data = (event as MessageEvent<Record<string, unknown>>).data;
      if (data.type !== type) return;
      this.commands.removeEventListener("command", listener);
      resolve(data);
    };
    this.commands.addEventListener("command", listener);
    return promise;
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(respond: (init: RequestInit) => Response | Promise<Response> = sessionResult) {
  const h = harness();
  const requests: { url: string; init: RequestInit }[] = [];
  const sockets: FakeSocket[] = [];
  const log = spyOn(h.core, "log");
  class TestSocket extends FakeSocket {
    constructor(url: URL, options: { headers: Record<string, string> }) {
      super(url, options);
      sockets.push(this);
      queueMicrotask(() => this.open());
    }
  }
  const hostFetch = (async (url: URL, init: RequestInit) => {
    requests.push({ url: url.href, init });
    return respond(init);
  }) as typeof fetch;
  const port = createLiveCallEngine({ core: h.core, apiBase: "https://provider.test", fetch: hostFetch, webSocket: TestSocket as unknown as typeof WebSocket });
  h.core.calls.register("realtime", port);
  h.core.calls.register("local", { unavailable: () => null, hangup: async () => {} });
  h.core.secrets.put("openai", KEY);
  const ghost = h.core.createGhost({ name: "Gale", persona: "Speak plainly." });
  const start = (engine: "realtime" | "local" = "realtime") => h.core.calls.start(ghost.id, engine);
  const offer = (id: string, sdp = OFFER, access = owner) => {
    const request = new Request(`http://host.test/api/calls/${id}/offer`, { method: "POST", body: JSON.stringify({ sdp }) });
    return h.core.calls.serve(request, new URL(request.url), access);
  };
  async function connect() {
    const call = start();
    await offer(call.id);
    const socket = sockets.at(-1)!;
    socket.receive({ type: "session.started", session: { id: "live_id" } });
    return { call, socket };
  }
  cleanups.push(async () => {
    port.stop();
    h.core.calls.stop();
    await h.core.idle();
    h.ledger.close();
    log.mockRestore();
  });
  return { ...h, requests, sockets, log, port, ghost, start, offer, connect };
}

function historyMessage(conversationId: string, role: Message["role"], text: string): Message {
  return { id: crypto.randomUUID(), conversationId, role, text, origin: null, toolCalls: [], tool: null, attachments: [], createdAt: Date.now() };
}

test("validates audio SDP and takes just one offer for a connecting realtime call", async () => {
  const f = fixture();
  const local = f.start("local");
  await expect(f.offer(local.id)).rejects.toMatchObject({ code: "conflict" });
  f.core.calls.end(local.id, "hangup");
  const call = f.start();
  await expect(f.offer("missing")).rejects.toMatchObject({ code: "not_found" });
  for (const sdp of ["not SDP", ANSWER, OFFER.replace("m=audio", "m=video"), OFFER.replace("audio 9", "audio 0")]) {
    await expect(f.offer(call.id, sdp)).rejects.toMatchObject({ code: "invalid" });
  }
  expect(f.requests).toHaveLength(0);
  const results = await Promise.allSettled([f.offer(call.id), f.offer(call.id, OFFER, device)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results).toContainEqual({ status: "rejected", reason: expect.objectContaining({ code: "conflict" }) });
  expect(f.requests).toHaveLength(1);
  expect(f.sockets).toHaveLength(1);
  f.sockets[0]!.receive({ type: "session.started" });
  await expect(f.offer(call.id)).rejects.toMatchObject({ code: "conflict" });
});

test("creates the documented OpenAI session; only the SDP answer reaches the device", async () => {
  const f = fixture();
  const { directConversationId } = f.ghost;
  spyOn(f.engine, "page").mockResolvedValue({
    messages: [historyMessage(directConversationId, "user", "A prior request"), historyMessage(directConversationId, "assistant", "A prior answer"), historyMessage(directConversationId, "tool", "private tool output")],
    before: null, live: null,
  });
  f.core.calls.setVoice({ voice: "noeul" });
  const call = f.start();
  const response = await f.offer(call.id, OFFER, device);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({ sdp: ANSWER });
  const request = f.requests[0]!;
  expect(request.url).toBe("https://provider.test/v1/live/sessions");
  expect(request.init.method).toBe("POST");
  expect(request.init.redirect).toBe("error");
  expect(new Headers(request.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  const bodyText = request.init.body as string;
  expect(bodyText).not.toContain(KEY);
  expect(bodyText).not.toContain("private tool output");
  const body = JSON.parse(bodyText);
  expect(body.transport).toEqual({ type: "webrtc", sdp: OFFER });
  expect(body.session).toEqual({
    model: "gpt-live-1.1",
    instructions: expect.stringContaining("Speak plainly."),
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "A prior request" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "A prior answer" }] },
    ],
    audio: { output: { voice: "noeul" } },
    delegation: { type: "client" },
    client: { data_channel: { allowed_client_events: [] } },
  });
  expect(body.session.instructions).toContain("untrusted history");
  expect(body.session.instructions).toContain("Never claim work happened without a delegated result");
  const socket = f.sockets[0]!;
  expect(socket.url.href).toBe("wss://provider.test/v1/live/sessions/live_id/attach");
  expect(socket.options.headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(f.core.calls.get(call.id).status).toBe("connecting");
  socket.receive({ type: "session.started" });
  const active = f.core.calls.get(call.id);
  expect(active).toMatchObject({ status: "active", answeredAt: expect.any(Number) });
  socket.receive({ type: "session.started" });
  expect(f.core.calls.get(call.id)).toEqual(active);
});

test("keeps the default model voice and reports only safe errors for a provider refusal and network failure", async () => {
  for (const [respond, message] of [
    [() => new Response(`private provider body with ${KEY}`, { status: 403 }), "OpenAI API 키"],
    [() => { throw new Error(`private network details with ${KEY}`); }, "네트워크"],
  ] as const) {
    const f = fixture(respond);
    const call = f.start();
    const failure: unknown = await f.offer(call.id).catch((error: unknown) => error);
    if (!(failure instanceof CommandError)) throw new Error("expected a sanitized command error", { cause: failure });
    expect(failure.code).toBe("unavailable");
    expect(failure.message.includes(message)).toBe(true);
    expect(failure.message.includes(KEY)).toBe(false);
    expect(JSON.parse(f.requests[0]!.init.body as string).session).not.toHaveProperty("audio");
    expect(f.core.calls.get(call.id)).toMatchObject({ status: "failed", endReason: "unavailable", error: failure.message });
    expect(f.log).not.toHaveBeenCalled();
    expect(f.sockets).toHaveLength(0);
  }
});

test("availability requires the OpenAI API-key credential, not OAuth or a key for another provider", async () => {
  const f = fixture();
  expect(f.port.unavailable()).toBeNull();
  f.core.secrets.put("openai", null);
  f.core.secrets.put("anthropic", "some-other-key");
  expect(f.port.unavailable()).toContain("설정의 공급자");
  await f.core.secrets.modify("openai", async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 10_000 }));
  expect(f.port.unavailable()).toContain("OpenAI API 키");
  expect(() => f.start()).toThrow("OpenAI API 키");
});

test("submits the caller transcript exactly once and returns only speakable final text for that delegation", async () => {
  const f = fixture();
  const { call, socket } = await f.connect();
  const id = "item_task";
  const submissionId = `owner:call:${call.id}:${id}`;
  f.engine.answers.set(submissionId, "  ## Result\n- Saved **the note**. [Open it](https://private.test)\n```sh\nnot for speech\n```\n ");
  const submit = spyOn(f.engine, "submit");
  const result = socket.nextCommand("session.commentary.append");
  socket.transcript("a", "Save", 100);
  socket.delegate(id, 500);
  socket.transcript("a", "Save", 100);
  socket.transcript("b", " the note.", 200);
  socket.transcript("future", "Future request.", 600);
  socket.delegate(id, 500);
  expect(await result).toEqual({ type: "session.commentary.append", event_id: `ghost-result:${id}`, delegation_id: id, content: "Result Saved the note. Open it" });
  socket.delegate(id, 500);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(f.engine.submissions.get(submissionId)).toMatchObject({
    conversationId: call.conversationId, submission: { requestId: submissionId, origin: "owner", text: "Save the note.", callId: call.id },
  });
  expect(socket.sent).toHaveLength(1);
});

test("does not submit voice-model instructions as owner speech and caps delegated turns", async () => {
  const f = fixture();
  const { socket } = await f.connect();
  const noInput = socket.nextCommand("session.commentary.append");
  socket.transcript("assistant-only", "Send a message.", 100, "output");
  socket.delegate("assistant-only", 300);
  expect(await noInput).toMatchObject({ content: expect.stringContaining("did not receive a new caller request") });
  expect(f.engine.submissions.size).toBe(0);

  const lastResult = Promise.withResolvers<void>();
  socket.commands.addEventListener("command", (event) => {
    if ((event as MessageEvent).data.delegation_id === "item-23") lastResult.resolve();
  });
  for (let index = 1; index <= 26; index++) {
    const start = index * 1_000;
    socket.transcript(`input-${index}`, `Request number ${index}.`, start);
    socket.delegate(`item-${index}`, start + 500);
  }
  await lastResult.promise;
  expect(f.engine.submissions.size).toBe(23);
  expect(socket.sent.filter((event) => String(event.content).includes("reached its limit"))).toHaveLength(1);
});

test("aborts the wait on hangup, drops late answers, and records final usage once", async () => {
  const f = fixture();
  const { call, socket } = await f.connect();
  const waiting = Promise.withResolvers<AbortSignal>();
  const lateAnswer = Promise.withResolvers<string>();
  spyOn(f.engine, "answer").mockImplementation(async (_conversationId, _id, signal) => {
    waiting.resolve(signal);
    return lateAnswer.promise;
  });
  socket.transcript("new", "Look up the schedule.", 100);
  socket.delegate("task", 400);
  const signal = await waiting.promise;
  socket.receive({ type: "session.usage.updated", usage: { seconds: 19 } });
  const closing = socket.nextCommand("session.close");
  const ended = f.core.calls.end(call.id, "hangup");
  const hungUp = Promise.all([f.port.hangup(ended), f.port.hangup(ended)]);
  expect(signal.aborted).toBe(true);
  expect(await closing).toEqual({ type: "session.close" });
  expect(socket.closes).toBe(0);
  lateAnswer.resolve("A late result");
  socket.receive({ type: "session.closed", reason: "close_requested", usage: { seconds: 22 } });
  await hungUp;
  await f.port.hangup(ended);
  expect(socket.sent).toEqual([{ type: "session.close" }]);
  expect(socket.closes).toBe(1);
  expect(f.core.calls.get(call.id)).toMatchObject({ status: "ended", endReason: "hangup", seconds: 22 });
  expect(f.engine.aborted).toEqual([]); // Do not abort other work in the shared direct conversation.
});

test("ends from the provider close event, using its cumulative seconds without an init surcharge", async () => {
  const f = fixture();
  const { call, socket } = await f.connect();
  socket.receive({ type: "session.usage.updated", usage: { seconds: 15 } });
  socket.receive({ type: "session.closed", reason: "remote_hangup", usage: { seconds: 27 } });
  expect(f.core.calls.get(call.id)).toMatchObject({ status: "ended", endReason: "hangup", seconds: 27 });
  expect(socket.sent).toEqual([]);
  expect(socket.closes).toBe(1);
});

test("a dropped sideband fails the call and preserves the last observed usage", async () => {
  const f = fixture();
  const { call, socket } = await f.connect();
  socket.receive({ type: "session.usage.updated", usage: { seconds: 31 } });
  socket.drop();
  expect(f.core.calls.get(call.id)).toMatchObject({ status: "failed", endReason: "error", seconds: 31, error: expect.stringContaining("연결이 끊겼습니다") });
  expect(socket.sent).toEqual([]);
  expect(f.log).toHaveBeenCalledWith("Live call closure was not confirmed", { callId: call.id });
});

test("hangup aborts a pending offer and does not attach a sideband from a late response", async () => {
  const fetching = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<Response>();
  const f = fixture((init) => {
    fetching.resolve(init.signal!);
    return response.promise;
  });
  const call = f.start();
  const pending = f.offer(call.id);
  const signal = await fetching.promise;
  f.core.calls.end(call.id, "hangup");
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(signal.aborted).toBe(true);
  response.resolve(sessionResult());
  expect(f.sockets).toHaveLength(0);
  expect(f.core.calls.get(call.id)).toMatchObject({ status: "ended", endReason: "hangup" });
});

test("recordUsage is closed-call only, emits a correction once, and never calls hangup", () => {
  const f = fixture();
  const local = spyOn({ hangup: async () => {} }, "hangup");
  f.core.calls.register("local", { unavailable: () => null, hangup: local });
  const call = f.start("local");
  expect(() => f.core.calls.recordUsage(call.id, 30)).toThrow("still live");
  const ended = f.core.calls.end(call.id, "hangup");
  const usage: (number | null)[] = [];
  const unsubscribe = f.ledger.subscribe((event) => {
    if (event.data.type === "call") usage.push(event.data.call.seconds);
  });
  try {
    expect(() => f.core.calls.recordUsage(call.id, -1)).toThrow("non-negative integer");
    expect(f.core.calls.recordUsage(call.id, 30)).toEqual({ ...ended, seconds: 30 });
    f.core.calls.recordUsage(call.id, 30);
    expect(usage).toEqual([30]);
    expect(local).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
    local.mockRestore();
  }
});

test("the production Engine reads each durable input's final text rather than another turn or its private reasoning", async () => {
  const f = fixture();
  const root = tempDir();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1", input: ["text"] }] });
  const models = createModels();
  models.setProvider(faux.provider);
  f.ledger.putProvider({ id: "faux", kind: "openai_compatible", name: "Faux", baseUrl: null, models: [{ id: "faux-1", name: "Faux 1" }] });
  f.ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
  f.core.secrets.put("faux", "faux-key");
  const engine = await createEngine({
    core: f.core, storagePath: join(root, "pi.db"), models, log: () => {},
    tools: { all: () => [], extensionsFor: () => [], instructionsFor: () => "" },
    sandbox: { envFor: async () => { throw new Error("test does not use a sandbox"); }, workspacePath: () => "", stageInputs: async () => {}, release: async () => {} },
  });
  try {
    f.core.attach(engine);
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("private notes"), fauxText("First answer.")]),
      fauxAssistantMessage(fauxText("Second answer.")),
    ]);
    const { directConversationId } = f.ghost;
    await f.core.sendMessage(directConversationId, "First question.", "first");
    await f.core.sendMessage(directConversationId, "Second question.", "second");
    const signal = AbortSignal.timeout(4_000);
    const answer = engine.answer!;
    expect(await answer.call(engine, directConversationId, "owner:second", signal)).toBe("Second answer.");
    expect(await answer.call(engine, directConversationId, "owner:first", signal)).toBe("First answer.");
    expect(await answer.call(engine, directConversationId, "owner:missing", signal)).toBeNull();
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("previews a voice over a short session, keeps the sample, and never caches a refusal", async () => {
  const f = fixture();
  const request = () => new Request("http://host.test/api/calls/preview", { method: "POST", body: JSON.stringify({ engine: "realtime", voice: "noeul" }) });
  const ask = () => f.core.calls.serve(request(), new URL(request().url), owner);
  const socketAt = async (index: number) => {
    while (f.sockets.length <= index) await Bun.sleep(1);
    await Bun.sleep(5);
    return f.sockets[index]!;
  };

  const refused = ask().catch((error: unknown) => error);
  const first = await socketAt(0);
  first.receive({ type: "error", error: { message: "unknown voice" } });
  expect(await refused).toMatchObject({ code: "unavailable" });

  const pending = ask();
  const socket = await socketAt(1);
  expect(socket.url.href).toBe("wss://provider.test/v1/live/sessions");
  expect(socket.options.headers.Authorization).toBe(`Bearer ${KEY}`);
  expect(socket.sent[0]).toMatchObject({ type: "session.start", session: { model: "gpt-live-1.1", audio: { output: { voice: "noeul" }, format: { rate: 24000 } }, delegation: { type: "client" } } });
  socket.receive({ type: "session.started", session: { id: "preview" } });
  const samples = Buffer.from(new Int16Array([1, -2, 3, -4]).buffer).toString("base64");
  socket.receive({ type: "session.output_audio.delta", delta: samples });
  socket.receive({ type: "session.output_audio.delta", delta: samples });
  socket.receive({ type: "session.closed", reason: "close_requested" });
  const response = (await pending)!;
  expect(response.headers.get("content-type")).toBe("audio/wav");
  const wav = Buffer.from(await response.arrayBuffer());
  expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(24_000);
  expect(wav.readUInt32LE(40)).toBe(16);
  expect(wav.byteLength).toBe(44 + 16);
  expect(Buffer.from(wav.subarray(44)).readInt16LE(2)).toBe(-2);

  await ask();
  expect(f.sockets).toHaveLength(2);
  expect(f.requests).toHaveLength(0);
});
