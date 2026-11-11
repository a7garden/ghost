import { expect, test } from "bun:test";
import { ChromeViewportFrames } from "../src/integrations/browser-frames.ts";
import type { BrowserLiveEvent } from "../src/integrations/ports.ts";

type Frame = Extract<BrowserLiveEvent, { type: "frame" }>;
type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
type Received = Command & { at: number; reply: (result: Record<string, unknown>) => void };

// A bounded SOF metadata fixture: these protocol tests do not claim to render/decode JPEG pixels.
function jpegHeader(width: number, height: number) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return bytes.toString("base64");
}

function protocol(options: { handshake?: Promise<void> } = {}) {
  const requests: Received[] = [], queued: Received[] = [];
  const waiting: { method: string; resolve: (command: Received) => void }[] = [];
  const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  let connections = 0;
  let visual = { pageX: 19, pageY: 820, clientWidth: 356, clientHeight: 700 };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      entered.resolve();
      await options.handshake;
      if (server.upgrade(request)) return;
      return new Response("upgrade", { status: 400 });
    },
    websocket: {
      open() { connections++; },
      close() { closed.resolve(); },
      message(ws, message) {
        const command = JSON.parse(String(message)) as Command;
        const received: Received = { ...command, at: performance.now(), reply: result => { ws.send(JSON.stringify({ id: command.id, result })); } };
        requests.push(received);
        const waiter = waiting.findIndex(item => item.method === command.method);
        if (waiter < 0) queued.push(received);
        else waiting.splice(waiter, 1)[0]!.resolve(received);
        switch (command.method) {
          case "Target.attachToTarget": received.reply({ sessionId: `session-${command.params.targetId}` }); break;
          case "Target.detachFromTarget": received.reply({}); break;
          case "Page.getLayoutMetrics": received.reply({ cssVisualViewport: visual, cssContentSize: { x: 0, y: 0, width: 4000, height: 9000 } }); break;
          case "Page.captureScreenshot": break; // Tests control completion to exercise real in-flight boundaries.
          default: throw new Error(`Unexpected renderer command: ${command.method}`);
        }
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/devtools/browser/frames-test`, requests, entered: entered.promise, closed: closed.promise,
    get connections() { return connections; },
    setVisual(value: typeof visual) { visual = value; },
    next(method = "Page.captureScreenshot") {
      const index = queued.findIndex(command => command.method === method);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
      const ready = Promise.withResolvers<Received>();
      waiting.push({ method, resolve: ready.resolve });
      return ready.promise;
    },
    close() { server.stop(true); },
  };
}

const request = { targetId: "owner-tab", viewport: { width: 356, height: 700 }, maxFps: 15 };

test("Chrome captures the full requested CSS viewport at native scroll offsets, never document/physical size", async () => {
  const cdp = protocol(), frame = Promise.withResolvers<Frame>();
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame: frame.resolve, onError: () => frame.reject(new Error("capture failed")) });
  try {
    renderer.request(request);
    const shot = await cdp.next();
    expect(cdp.requests.find(command => command.method === "Target.attachToTarget")?.params).toEqual({ targetId: "owner-tab", flatten: true });
    expect(shot.sessionId).toBe("session-owner-tab");
    expect(shot.params).toEqual({ format: "jpeg", quality: 65, fromSurface: true, captureBeyondViewport: false, clip: { x: 19, y: 820, width: 356, height: 700, scale: 1 } });
    shot.reply({ data: jpegHeader(356, 700) });
    expect(await frame.promise).toEqual({ type: "frame", data: jpegHeader(356, 700), width: 356, height: 700 });
  } finally { renderer.close(); cdp.close(); }
});

test("omitted size uses the CSS visual viewport, not cssContentSize", async () => {
  const cdp = protocol(), frame = Promise.withResolvers<Frame>();
  cdp.setVisual({ pageX: 0, pageY: 1400, clientWidth: 980, clientHeight: 520 });
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame: frame.resolve, onError: () => frame.reject(new Error("capture failed")) });
  try {
    renderer.request({ targetId: "owner-tab", maxFps: 8 });
    const shot = await cdp.next();
    expect(shot.params.clip).toEqual({ x: 0, y: 1400, width: 980, height: 520, scale: 1 });
    shot.reply({ data: jpegHeader(980, 520) });
    expect(await frame.promise).toMatchObject({ width: 980, height: 520 });
  } finally { renderer.close(); cdp.close(); }
});

test("same-identity damage coalesces without starving publication and clamps capture starts to 15 FPS", async () => {
  // Real WebSocket/monotonic-clock integration: await the actual trailing capture, not a guessed sleep.
  const cdp = protocol(), frames: Frame[] = [], first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>();
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame(frame) { frames.push(frame); (frames.length === 1 ? first : second).resolve(); }, onError() { first.reject(new Error("capture failed")); second.reject(new Error("capture failed")); } });
  try {
    renderer.request({ ...request, maxFps: 1000 });
    const shot = await cdp.next();
    for (let i = 0; i < 25; i++) renderer.request({ ...request, maxFps: 1000 });
    expect(cdp.requests.filter(command => command.method === "Page.captureScreenshot")).toHaveLength(1);
    shot.reply({ data: jpegHeader(356, 700) });
    await first.promise;
    const trailing = await cdp.next();
    expect(trailing.at - shot.at).toBeGreaterThanOrEqual(64);
    trailing.reply({ data: jpegHeader(356, 700) });
    await second.promise;
    expect(frames).toHaveLength(2);
    expect(cdp.requests.filter(command => command.method === "Page.captureScreenshot")).toHaveLength(2);
    expect(cdp.connections).toBe(1);
  } finally { renderer.close(); cdp.close(); }
});

test("target/viewport changes discard old pixels, detach the old target and reuse the owned connection", async () => {
  const cdp = protocol(), frames: Frame[] = [], published = Promise.withResolvers<void>();
  let errors = 0;
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame(frame) { frames.push(frame); published.resolve(); }, onError() { errors++; } });
  try {
    renderer.request(request);
    const old = await cdp.next();
    renderer.request({ targetId: "new-owner-tab", viewport: { width: 980, height: 520 }, maxFps: 15 });
    old.reply({ data: "old-private-pixels-must-not-even-be-validated" });
    const next = await cdp.next();
    expect(frames).toEqual([]);
    expect(errors).toBe(0);
    expect(cdp.requests.find(command => command.method === "Target.detachFromTarget")?.params).toEqual({ sessionId: "session-owner-tab" });
    expect(next.sessionId).toBe("session-new-owner-tab");
    next.reply({ data: jpegHeader(980, 520) });
    await published.promise;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ width: 980, height: 520 });
    expect(cdp.connections).toBe(1);
  } finally { renderer.close(); cdp.close(); }
});

test("invalidate revokes an in-flight capture and pending dirty work but retains the private socket", async () => {
  const cdp = protocol(), frames: Frame[] = [], published = Promise.withResolvers<void>();
  let errors = 0;
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame(frame) { frames.push(frame); published.resolve(); }, onError() { errors++; } });
  try {
    renderer.request(request);
    const old = await cdp.next();
    renderer.request(request);
    renderer.invalidate();
    renderer.request(request);
    old.reply({ data: "revoked-private-pixels" });
    const next = await cdp.next();
    expect(frames).toEqual([]);
    next.reply({ data: jpegHeader(356, 700) });
    await published.promise;
    expect(errors).toBe(0);
    expect(cdp.connections).toBe(1);
    expect(cdp.requests.filter(command => command.method === "Target.attachToTarget")).toHaveLength(1);
    expect(frames).toHaveLength(1);
  } finally { renderer.close(); cdp.close(); }
});

test("isCurrent revokes publication even if the capture finishes successfully", async () => {
  const cdp = protocol(), frames: Frame[] = [], published = Promise.withResolvers<void>();
  let current = true, errors = 0;
  const revoked = Promise.withResolvers<void>();
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent() { if (!current) revoked.resolve(); return current; }, onFrame(frame) { frames.push(frame); published.resolve(); }, onError() { errors++; } });
  try {
    renderer.request(request);
    const old = await cdp.next();
    current = false;
    old.reply({ data: jpegHeader(356, 700) });
    await revoked.promise;
    expect(frames).toEqual([]);
    expect(errors).toBe(0);
    current = true;
    renderer.request(request);
    const next = await cdp.next();
    next.reply({ data: jpegHeader(356, 700) });
    await published.promise;
    expect(frames).toHaveLength(1);
  } finally { renderer.close(); cdp.close(); }
});

test("mislabeled physical-height JPEG fails closed with a fixed error callback", async () => {
  const cdp = protocol(), failed = Promise.withResolvers<void>(), frames: Frame[] = [];
  let errors = 0;
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame(frame) { frames.push(frame); }, onError() { errors++; failed.resolve(); } });
  try {
    renderer.request(request);
    const shot = await cdp.next();
    shot.reply({ data: jpegHeader(356, 498), secretProtocolDetail: "must-not-escape" });
    await failed.promise;
    await cdp.closed;
    expect(errors).toBe(1);
    expect(frames).toEqual([]);
  } finally { renderer.close(); cdp.close(); }
});

test("closing an in-flight capture cancels pending work and every late callback", async () => {
  const cdp = protocol(), callbacks: unknown[] = [];
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame: frame => { callbacks.push(frame); }, onError: () => { callbacks.push("error"); } });
  try {
    renderer.request(request);
    const shot = await cdp.next();
    renderer.request(request);
    renderer.close();
    shot.reply({ data: jpegHeader(356, 700) });
    await cdp.closed;
    renderer.request(request);
    expect(callbacks).toEqual([]);
    expect(cdp.requests.filter(command => command.method === "Page.captureScreenshot")).toHaveLength(1);
  } finally { renderer.close(); cdp.close(); }
});

test("closing while CDP connects disposes the late socket without attaching or publishing", async () => {
  const handshake = Promise.withResolvers<void>(), cdp = protocol({ handshake: handshake.promise });
  const callbacks: unknown[] = [];
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame: frame => { callbacks.push(frame); }, onError: () => { callbacks.push("error"); } });
  try {
    renderer.request(request);
    await cdp.entered;
    renderer.close();
    handshake.resolve();
    await cdp.closed;
    expect(cdp.requests).toEqual([]);
    expect(callbacks).toEqual([]);
  } finally { handshake.resolve(); renderer.close(); cdp.close(); }
});

test("the 8 MiB decoded image limit rejects the first byte beyond the boundary, including base64 padding", async () => {
  const cdp = protocol(), failed = Promise.withResolvers<void>(), frames: Frame[] = [];
  const renderer = new ChromeViewportFrames({ getCdpUrl: async () => cdp.url, isCurrent: () => true, onFrame(frame) { frames.push(frame); }, onError: failed.resolve });
  try {
    renderer.request(request);
    const shot = await cdp.next();
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
    Buffer.from(jpegHeader(356, 700), "base64").copy(oversized);
    shot.reply({ data: oversized.toString("base64") });
    await failed.promise;
    expect(frames).toEqual([]);
  } finally { renderer.close(); cdp.close(); }
});

test("an out-of-bounds CSS viewport fails before attaching or capturing", async () => {
  const failed = Promise.withResolvers<void>();
  let connections = 0, frames = 0;
  const renderer = new ChromeViewportFrames({
    getCdpUrl: async () => { connections++; return "ws://127.0.0.1:1/devtools/browser/not-used"; },
    isCurrent: () => true,
    onFrame: () => { frames++; },
    onError: failed.resolve,
  });
  try {
    renderer.request({ ...request, viewport: { width: 2561, height: 700 } });
    await failed.promise;
    expect(connections).toBe(0);
    expect(frames).toBe(0);
  } finally { renderer.close(); }
});
