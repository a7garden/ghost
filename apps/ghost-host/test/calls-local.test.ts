import { afterEach, describe, expect, test } from "bun:test";
import type { Call } from "@ghost/contract";
import { Access } from "../src/core/access.ts";
import type { CallEnginePort } from "../src/core/calls.ts";
import { createLocalCallEngine, type LocalCallEngine } from "../src/integrations/calls-local.ts";
import { harness } from "./support.ts";

const owner = new Access({ kind: "owner" });
/** A small RIFF/PCM16 header with a few samples; the engine forwards bytes and never decodes them. */
const WAV = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 1, 0, 16, 0, 100, 97, 116, 97, 8, 0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0]);

type Seen = { method: string; path: string; headers: Headers; form: FormData | null; json: unknown };

/** Fake `ghost-voice-server`: records the exact upstream requests and can hold or fail them. */
class FakeSpeech {
  readonly requests: Seen[] = [];
  behavior: { status: number; hold: boolean } = { status: 200, hold: false };
  private readonly gates: (() => void)[] = [];
  readonly server: Bun.Server<undefined>;

  constructor(readonly health: unknown = { service: "ghost-local-speech", version: 1, offline: true, model_loaded: { stt: true, tts: true } }) {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => this.handle(request) });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json(this.health);
    const entry: Seen = { method: request.method, path: url.pathname, headers: request.headers, form: null, json: null };
    this.requests.push(entry);
    if (url.pathname === "/v1/audio/transcriptions") entry.form = await request.formData();
    if (url.pathname === "/v1/audio/speech") entry.json = await request.json();
    if (this.behavior.hold) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.gates.push(resolve);
      await promise;
    }
    if (this.behavior.status !== 200) return new Response("SECRET upstream detail", { status: this.behavior.status });
    if (url.pathname === "/v1/audio/transcriptions") return Response.json({ text: "받아쓴 문장" });
    return new Response(WAV, { headers: { "content-type": "audio/wav" } });
  }

  release() {
    for (const gate of this.gates.splice(0)) gate();
  }

  get url(): string {
    return this.server.url.href;
  }
}

const engines: LocalCallEngine[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

function setup(speechUrl: string, probeEveryMs = 20) {
  const h = harness();
  const engine = createLocalCallEngine({ core: h.core, speechUrl, probeEveryMs });
  engines.push(engine);
  h.core.calls.register("local", engine);
  const realtime: CallEnginePort = { unavailable: () => null, hangup: async () => {} };
  h.core.calls.register("realtime", realtime);
  const ghost = h.core.createGhost({ name: "Main", persona: "You lead.", model: { provider: "test", model: "test-model" }, isDefault: true });
  const raw = (target: LocalCallEngine, path: string, init: RequestInit = {}) => {
    const url = new URL(`http://127.0.0.1:9${path}`);
    return target.serve!(new Request(url, init), url, owner);
  };
  const serve = async (target: LocalCallEngine, path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await raw(target, path, init);
    if (response === null) throw new Error(`the engine claimed no route for ${path}`);
    return response;
  };
  return { ...h, engine, ghost, serve, raw };
}

// The engine's health probe runs on a real interval (that is the behavior under test), so conditions
// are polled on the platform clock: each wait ends the moment the engine's own signal arrives.
async function until(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

/** A live local call the engine will speak for; the engine must be probed ready first. */
async function liveCall(t: ReturnType<typeof setup>): Promise<Call> {
  await until(() => t.engine.unavailable() === null);
  return t.core.calls.start(t.ghost.id, "local");
}

describe("local call engine availability", () => {
  test("a non-loopback speechUrl is rejected at construction", () => {
    const { core } = harness();
    for (const bad of ["http://192.168.1.5:62076", "http://0.0.0.0:62076", "https://127.0.0.1:62076", "http://127.0.0.1:62076/v1", "http://127.0.0.1:62076/?x=1", "http://127.0.0.1:62076#f", "http://user:pw@127.0.0.1:62076", "ftp://127.0.0.1", "localhost:62076"]) {
      expect(() => createLocalCallEngine({ core, speechUrl: bad })).toThrow("loopback");
    }
    for (const good of ["http://127.0.0.1:62076", "http://localhost:62076", "http://[::1]:62076", "http://127.0.0.1:62076/"]) {
      expect(() => createLocalCallEngine({ core, speechUrl: good })).not.toThrow();
    }
  });

  test("unavailable is synchronous: pending before the first probe, then the server's answer", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    expect(t.engine.unavailable()).toContain("확인");
    t.engine.start();
    await until(() => t.engine.unavailable() === null);
    speech.server.stop(true);
    await until(() => t.engine.unavailable()?.includes("실행되고 있지 않습니다") === true);
    expect(t.engine.unavailable()).toContain(speech.url);
  });

  test("a reachable server whose backend is not loaded says so and takes no call", async () => {
    const speech = new FakeSpeech({ service: "ghost-local-speech", version: 1, offline: true, model_loaded: { stt: false, tts: true } });
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    await until(() => t.engine.unavailable()?.includes("로드되지 않았습니다") === true);
    expect(() => t.core.calls.start(t.ghost.id, "local")).toThrow("로드되지 않았습니다");
  });

  test("a health answer from another service is treated as down", async () => {
    const speech = new FakeSpeech({ service: "something-else", model_loaded: { stt: true, tts: true } });
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    await until(() => t.engine.unavailable()?.includes("실행되고 있지 않습니다") === true);
  });
});

describe("local call engine routes", () => {
  test("transcribe forwards the utterance as the speech server's multipart and returns the transcript", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    const response = await t.serve(t.engine, `/api/calls/${call.id}/transcribe?language=ko`, { method: "POST", body: WAV, headers: { "content-type": "audio/wav" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ text: "받아쓴 문장" });
    const upstream = speech.requests[0]!;
    expect(upstream.method).toBe("POST");
    expect(upstream.path).toBe("/v1/audio/transcriptions");
    expect(upstream.form!.get("model")).toBe("apple-speechanalyzer");
    expect(upstream.form!.get("language")).toBe("ko");
    const file = upstream.form!.get("file") as File;
    expect(file.type).toMatch(/^audio\//);
    expect(file.name).toBe("utterance.wav");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual(Array.from(WAV));

    const bare = await t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "POST", body: WAV, headers: { "content-type": "audio/wav" } });
    expect(bare.status).toBe(200);
    expect(speech.requests[1]!.form!.get("language")).toBeNull();
    expect((speech.requests[1]!.form!.get("file") as File).size).toBe(WAV.byteLength);
  });

  test("an unsupported language is refused before the speech server hears anything", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    const response = await t.serve(t.engine, `/api/calls/${call.id}/transcribe?language=fr`, { method: "POST", body: WAV });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid");
    expect(speech.requests).toHaveLength(0);
  });

  test("speech forwards the sentence with the configured voice and streams the WAV back", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    t.core.calls.setVoice({ voice: "f2" });
    const call = await liveCall(t);
    const response = await t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "안녕하세요." }), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(WAV));
    expect(speech.requests[0]!.json).toEqual({ model: "supertonic-3", input: "안녕하세요.", voice: "f2", response_format: "wav" });

    const oversized = await t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "가".repeat(501) }) });
    expect(oversized.status).toBe(400);
    expect(speech.requests).toHaveLength(1);
  });

  test("only a live local call may use these routes", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const stranger = await t.serve(t.engine, "/api/calls/nope/transcribe", { method: "POST", body: WAV });
    expect(stranger.status).toBe(404);

    const foreign = t.core.calls.start(t.ghost.id, "realtime");
    const wrongEngine = await t.serve(t.engine, `/api/calls/${foreign.id}/speech`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
    expect(wrongEngine.status).toBe(409);
    expect((await wrongEngine.json()).error.code).toBe("conflict");
    t.core.calls.end(foreign.id, "hangup");

    const call = await liveCall(t);
    t.core.calls.end(call.id, "hangup");
    const ended = await t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "POST", body: WAV });
    expect(ended.status).toBe(409);
    expect((await ended.json()).error.message).toContain("종료");

    const notPost = await t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "GET" });
    expect(notPost.status).toBe(405);
    expect(await t.raw(t.engine, `/api/calls/${call.id}/offer`, { method: "POST", body: "{}" })).toBeNull();
    expect(speech.requests).toHaveLength(0);
  });

  test("a body over the speech server's limit never leaves the Host", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    const huge = new Uint8Array(5 * 1024 * 1024 + 1);
    const response = await t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "POST", body: huge });
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("invalid");
    expect(speech.requests).toHaveLength(0);
  });
});

describe("local call engine under load and failure", () => {
  test("at most two upstream requests are in flight; the third is refused without piling up", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    speech.behavior.hold = true;
    const first = t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "POST", body: WAV });
    const second = t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "첫 문장." }) });
    await until(() => speech.requests.length === 2);
    const third = await t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "다음 문장." }) });
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error.code).toBe("unavailable");
    expect(third.headers.get("retry-after")).toBe("1");
    expect(speech.requests).toHaveLength(2);
    speech.release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  test("an upstream failure is a bounded unavailable error with no upstream body echoed", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    speech.behavior.status = 500;
    const stt = await t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "POST", body: WAV });
    expect(stt.status).toBe(503);
    const sttBody = await stt.json();
    expect(sttBody.error.code).toBe("unavailable");
    expect(JSON.stringify(sttBody)).not.toContain("SECRET");
    const tts = await t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "문장." }) });
    expect(tts.status).toBe(503);
    expect(JSON.stringify(await tts.json())).not.toContain("SECRET");
  });

  test("a client disconnect cancels the upstream fetch and frees the slot", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    speech.behavior.hold = true;
    const client = new AbortController();
    const hung = t.serve(t.engine, `/api/calls/${call.id}/transcribe`, { method: "POST", body: WAV, signal: client.signal });
    await until(() => speech.requests.length === 1);
    client.abort();
    const aborted = await hung;
    expect(aborted.status).toBe(503);
    expect(JSON.stringify(await aborted.json())).not.toContain("SECRET");
    // The held upstream request is still running, yet the slot is free for the next one.
    const next = t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "다시." }) });
    await until(() => speech.requests.length === 2);
    speech.release();
    expect((await next).status).toBe(200);
  });

  test("hangup aborts this call's in-flight upstream fetches, exactly once", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    const call = await liveCall(t);
    speech.behavior.hold = true;
    const hung = t.serve(t.engine, `/api/calls/${call.id}/speech`, { method: "POST", body: JSON.stringify({ text: "문장." }) });
    await until(() => speech.requests.length === 1);
    const started = Date.now();
    await t.engine.hangup(call);
    const response = await hung;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toContain("종료");
    await t.engine.hangup(call);
    expect(speech.requests).toHaveLength(1);
  });
});

describe("local voice preview", () => {
  const preview = (t: ReturnType<typeof setup>, body: unknown) => {
    const url = new URL("http://127.0.0.1:9/api/calls/preview");
    return t.core.calls.serve(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, owner);
  };

  test("speaks the chosen speaker once, then replays the kept sample", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    await until(() => t.engine.unavailable() === null);
    const first = await preview(t, { engine: "local", voice: "m3" });
    expect(first?.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await first!.arrayBuffer())).toEqual(WAV);
    expect(speech.requests).toHaveLength(1);
    expect(speech.requests[0]!.json).toMatchObject({ model: "supertonic-3", voice: "m3", response_format: "wav", input: expect.stringContaining("Ghost") });
    await preview(t, { engine: "local", voice: "m3" });
    expect(speech.requests).toHaveLength(1);
    await preview(t, { engine: "local", voice: "default" });
    expect(speech.requests).toHaveLength(2);
  });

  test("refuses a speaker the server does not have, and a failed sample is not kept", async () => {
    const speech = new FakeSpeech();
    servers.push(speech.server);
    const t = setup(speech.url);
    t.engine.start();
    await until(() => t.engine.unavailable() === null);
    await expect(preview(t, { engine: "local", voice: "x9" })).rejects.toMatchObject({ code: "invalid" });
    await expect(preview(t, { engine: "local", voice: "../etc" })).rejects.toThrow();
    expect(speech.requests).toHaveLength(0);
    speech.behavior.status = 500;
    const failure = await preview(t, { engine: "local", voice: "f2" }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(String((failure as Error).message)).not.toContain("SECRET");
    speech.behavior.status = 200;
    expect((await preview(t, { engine: "local", voice: "f2" }))?.status).toBe(200);
  });
});
