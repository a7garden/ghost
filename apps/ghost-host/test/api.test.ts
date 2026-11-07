import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  LedgerEvent as LedgerEventSchema,
  Notification as NotificationSchema,
  type LedgerEvent,
  type State,
  parse,
  validate,
} from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { isLoopbackAddress, startServer } from "../src/api/server.ts";
import { PairingLimiter } from "../src/api/pairing-limit.ts";
import { Core } from "../src/core/core.ts";
import type { ConversationSetup, Engine, Submission, TranscriptPage } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const OWNER_TOKEN = "owner-test-token";
const VERSION = "2.0.0";

class FakeEngine implements Engine {
  readonly opened: ConversationSetup[] = [];
  readonly submitted: { conversationId: string; submission: Submission }[] = [];

  async open(setup: ConversationSetup): Promise<void> {
    this.opened.push(setup);
  }

  async submit(conversationId: string, submission: Submission): Promise<void> {
    this.submitted.push({ conversationId, submission });
  }

  async abort(): Promise<void> {}

  async page(_conversationId: string, _before: string | null, _limit: number): Promise<TranscriptPage> {
    return { messages: [], before: null, live: null };
  }

  watch(): () => void {
    return () => {};
  }

  status(): { ready: boolean; detail: string } {
    return { ready: true, detail: "test engine" };
  }

  async appendHistory(): Promise<void> {}

  resume(): void {}

  async close(): Promise<void> {}
}

const root = mkdtempSync(join(tmpdir(), "ghost-api-"));
const uiDir = join(root, "ui");
mkdirSync(uiDir, { recursive: true });
writeFileSync(join(uiDir, "index.html"), "<!doctype html><html><head><title>Ghost</title></head><body>ui</body></html>");
writeFileSync(join(uiDir, "app.js"), "console.log(1);");

const engine = new FakeEngine();
const ledger = new Ledger(":memory:");
const core = new Core({
  ledger,
  artifacts: new FsArtifactStore(join(root, "state")),
  sandbox: {
    status: (ghostId: string) => ({ ghostId, state: "none" as const, detail: "" }),
    control: async () => {},
  },
  secrets: new FileSecrets(root),
  log: () => {},
});
core.attach(engine);

const config: Config = {
  root,
  host: "127.0.0.1",
  port: 0,
  publicOrigin: "http://127.0.0.1",
  uiDir,
  sandbox: { kind: "local" },
  memory: null,
  voice: null,
  apns: null,
};
const server = startServer({ core, config, ownerToken: OWNER_TOKEN, documents: null });
const base = `http://127.0.0.1:${server.port}`;
const port = server.port;

afterAll(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

// HTTP helpers

const get = (path: string, token?: string) =>
  fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

const postJson = (path: string, body: unknown, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

const runCommand = (command: Record<string, unknown>, token: string) =>
  postJson("/api/commands", { requestId: randomUUID(), command }, token);

/** Server-sent events fetch; the abort deadline bounds reads instead of in-test timers. */
const sse = (path: string, token: string) =>
  fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
    signal: AbortSignal.timeout(10_000),
  });

/** Raw request with an arbitrary Host header (fetch forbids overriding Host). */
function rawRequest(host: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.on("end", () => resolveRequest({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on("error", rejectRequest);
    outgoing.end();
  });
}

// SSE helpers

interface Frame {
  event: string;
  id: number | null;
  data: unknown;
}

const mentions = (event: LedgerEvent, id: string) => JSON.stringify(event.data).includes(id);

class EventStream {
  readonly frames: Frame[] = [];
  private buffer = "";
  private readonly decoder = new TextDecoder();
  private readonly source: ReadableStreamDefaultReader<Uint8Array>;

  constructor(response: Response) {
    this.source = response.body!.getReader();
  }

  /** Next protocol frame, or null once the stream closes (fetches carry a 10 s abort deadline). */
  async next(): Promise<Frame | null> {
    for (;;) {
      const ready = this.take();
      if (ready !== null) return ready;
      const chunk = await this.source.read();
      if (chunk.done) return null;
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Reads frames until `predicate` matches; every frame seen along the way lands in `frames`. */
  async drainUntil(predicate: (frame: Frame) => boolean): Promise<Frame | null> {
    for (;;) {
      const frame = await this.next();
      if (frame === null) return null;
      if (predicate(frame)) return frame;
    }
  }

  private take(): Frame | null {
    for (;;) {
      const index = this.buffer.indexOf("\n\n");
      if (index < 0) return null;
      const block = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (block.length === 0 || block.startsWith(":")) continue;
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:"));
      // Skip protocol blocks without a frame payload, such as the `retry:` preamble.
      if (eventLine === undefined) continue;
      const idLine = lines.find((line) => line.startsWith("id:"));
      const dataLine = lines.find((line) => line.startsWith("data:"))!;
      const frame: Frame = {
        event: eventLine.slice("event:".length).trim(),
        id: idLine === undefined ? null : Number(idLine.slice("id:".length)),
        data: JSON.parse(dataLine.slice("data:".length)),
      };
      this.frames.push(frame);
      return frame;
    }
  }

  close(): void {
    void this.source.cancel().catch(() => {});
  }
}

const ledgerFrame = (frame: Frame) => parse(LedgerEventSchema, frame.data);
const seqFrame = (frame: Frame) => parse(Type.Object({ seq: Type.Integer() }), frame.data);
const NotificationEventData = Type.Object({ type: Type.Literal("notification"), notification: NotificationSchema });
/** Null when the frame carries any other entity, so stream predicates can skip it. */
const notificationId = (frame: Frame): string | null => {
  const data = ledgerFrame(frame).data;
  if (!validate(NotificationEventData, data)) return null;
  return data.notification.id;
};

const notify = (id: string, ghostId: string | null) =>
  ledger.tx(() =>
    ledger.putNotification({
      id,
      kind: "work_done",
      ghostId,
      conversationId: null,
      workId: null,
      decisionId: null,
      title: `t-${id}`,
      body: "b",
      createdAt: Date.now(),
      readAt: null,
    }),
  );

/** Starts pairing and claims the code, yielding a fresh device identity. Successes never touch the failure budget. */
async function pairDevice(name: string, ghostId: string): Promise<{ deviceId: string; token: string }> {
  const started = (await (
    await runCommand({ type: "device.pairing_start", name, grants: [{ ghostId, conversationId: null }] }, OWNER_TOKEN)
  ).json()) as { ok: boolean; result: { code: string } };
  expect(started.ok).toBe(true);
  const claim = await postJson("/api/pairing/claim", { code: started.result.code, deviceName: name });
  expect(claim.status).toBe(200);
  return (await claim.json()) as { deviceId: string; token: string };
}

// Shared fixtures

let alphaId = "";
let alphaDirectId = "";
let deviceId = "";
let deviceToken = "";
let betaId = "";

describe("API server", () => {
  test("health needs no auth", async () => {
    const response = await get("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: VERSION });
  });

  test("requests without a valid token are refused", async () => {
    expect((await get("/api/state")).status).toBe(401);
    expect((await get("/api/state", "wrong-token")).status).toBe(401);
    expect((await postJson("/api/commands", {}, "wrong-token")).status).toBe(401);
  });

  test("owner creates a Ghost and sees it in state", async () => {
    const response = await runCommand({ type: "ghost.create", name: "Alpha", persona: "helpful" }, OWNER_TOKEN);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; result: { ghostId: string } };
    expect(body.ok).toBe(true);
    alphaId = body.result.ghostId;
    const state = (await (await get("/api/state", OWNER_TOKEN)).json()) as State;
    alphaDirectId = state.ghosts[0]!.directConversationId;
    expect(state.ghosts.map((ghost) => ghost.name)).toEqual(["Alpha"]);
    expect(state.runtime.ready).toBe(true);
    expect(state.principal).toEqual({ kind: "owner" });
  });

  test("a repeated requestId returns the recorded outcome and runs once", async () => {
    const requestId = randomUUID();
    const command = { type: "ghost.create", name: "Once", persona: "once" };
    const first = (await (await postJson("/api/commands", { requestId, command }, OWNER_TOKEN)).json()) as {
      ok: boolean;
      result: { ghostId: string };
    };
    const second = (await (await postJson("/api/commands", { requestId, command }, OWNER_TOKEN)).json()) as typeof first;
    expect(second).toEqual(first);
    const state = (await (await get("/api/state", OWNER_TOKEN)).json()) as State;
    expect(state.ghosts.filter((ghost) => ghost.name === "Once")).toHaveLength(1);
    const conflict = await postJson("/api/commands", { requestId, command: { ...command, name: "Other" } }, OWNER_TOKEN);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });

  test("pairing: owner starts, device claims once", async () => {
    const started = (await (
      await runCommand({ type: "device.pairing_start", name: "Test Phone", grants: [{ ghostId: alphaId, conversationId: alphaDirectId }] }, OWNER_TOKEN)
    ).json()) as { ok: boolean; result: { code: string; expiresAt: number; origin: string } };
    expect(started.ok).toBe(true);
    expect(started.result.origin).toBe("http://127.0.0.1");

    const claim = await postJson("/api/pairing/claim", { code: started.result.code, deviceName: "Test Phone" });
    expect(claim.status).toBe(200);
    const granted = (await claim.json()) as { deviceId: string; token: string };
    deviceId = granted.deviceId;
    deviceToken = granted.token;
    expect(deviceToken.length).toBeGreaterThan(30);

    const repeat = await postJson("/api/pairing/claim", { code: started.result.code, deviceName: "Test Phone" });
    expect(repeat.status).toBe(404);
    const forged = await postJson("/api/pairing/claim", { code: "ZZZZZZZZ", deviceName: "Nope" });
    expect(forged.status).toBe(404);
  });

  test("a paired device sees only its granted Ghost", async () => {
    betaId = ((await (await runCommand({ type: "ghost.create", name: "Beta", persona: "quiet" }, OWNER_TOKEN)).json()) as {
      result: { ghostId: string };
    }).result.ghostId;

    const state = (await (await get("/api/state", deviceToken)).json()) as State;
    expect(state.ghosts.map((ghost) => ghost.id)).toEqual([alphaId]);
    expect(state.conversations.map((conversation) => conversation.id)).toEqual([alphaDirectId]);
    expect(state.principal).toEqual({ kind: "device", deviceId, name: "Test Phone", grants: [{ ghostId: alphaId, conversationId: alphaDirectId }] });
    expect(state.schedules).toEqual([]);
    expect(state.devices.map((device) => device.id)).toEqual([deviceId]);

    const ownerState = (await (await get("/api/state", OWNER_TOKEN)).json()) as State;
    const ownerGhostIds = ownerState.ghosts.map((ghost) => ghost.id);
    expect(ownerGhostIds).toContain(alphaId);
    expect(ownerGhostIds).toContain(betaId);
  });

  test("a device cannot send owner commands", async () => {
    const response = await runCommand({ type: "ghost.create", name: "Rogue", persona: "no" }, deviceToken);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden");
  });

  test("transcript pages are access-checked", async () => {
    const owner = await get(`/api/conversations/${alphaDirectId}`, OWNER_TOKEN);
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { conversation: { id: string } }).conversation.id).toBe(alphaDirectId);
    const device = await get(`/api/conversations/${alphaDirectId}`, deviceToken);
    expect(device.status).toBe(200);
  });

  test("artifact access follows Work visibility", async () => {
    const created = (await (
      await runCommand({ type: "conversation.create", ghostId: alphaId, title: "Second direct" }, OWNER_TOKEN)
    ).json()) as { result: { conversationId: string } };
    const secondDirect = created.result.conversationId;
    const work = (await (
      await runCommand({ type: "work.create", ghostId: alphaId, originConversationId: secondDirect, title: "Hidden", brief: "b" }, OWNER_TOKEN)
    ).json()) as { result: { workId: string } };
    const workId = work.result.workId;

    const content = new TextEncoder().encode("artifact-bytes");
    const ref = await core.artifacts.put(content, "out.txt", "text/plain");
    ledger.tx(() => ledger.addArtifact(workId, ref));

    const ownerResponse = await get(`/api/artifacts/${ref.digest}`, OWNER_TOKEN);
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.headers.get("content-type")).toBe("text/plain");
    expect(ownerResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await ownerResponse.arrayBuffer())).toEqual(content);

    const deviceResponse = await get(`/api/artifacts/${ref.digest}`, deviceToken);
    expect(deviceResponse.status).toBe(404);
    expect((await get(`/api/artifacts/${ref.digest}`)).status).toBe(401);
    expect((await get(`/api/works/${workId}`, deviceToken)).status).toBe(404);
    expect((await get(`/api/artifacts/${"z".repeat(64)}`, OWNER_TOKEN)).status).toBe(404);
  });

  test("avatar images are visible to devices", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const image = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const avatarResponse = await runCommand({ type: "avatar.create", name: "Mask", description: "d", image }, OWNER_TOKEN);
    expect(avatarResponse.status).toBe(200);
    const created = (await avatarResponse.json()) as { result: { avatarId: string } };
    expect(created.result.avatarId).toBeString();
    const state = (await (await get("/api/state", deviceToken)).json()) as State;
    const digest = state.avatars[0]!.imageDigest;
    const response = await get(`/api/artifacts/${digest}`, deviceToken);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  test("SSE delivers ledger events created after connecting", async () => {
    const after = ledger.seq();
    const response = await sse(`/api/events?after=${after}`, OWNER_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const stream = new EventStream(response);
    notify("sse-live-1", alphaId);
    const frame = await stream.drainUntil((candidate) => candidate.event === "ledger" && notificationId(candidate) === "sse-live-1");
    expect(frame).not.toBeNull();
    expect(frame!.id).toBeGreaterThan(after);
    stream.close();
  });

  test("a device stream never sees events for ungranted Ghosts", async () => {
    const notification = "sse-device-1";
    notify(notification, alphaId);
    const replayStream = new EventStream(await sse("/api/events?after=0", deviceToken));
    const seen = await replayStream.drainUntil((frame) => frame.event === "ledger" && notificationId(frame) === notification);
    expect(seen).not.toBeNull();
    for (const frame of replayStream.frames) {
      if (frame.event !== "ledger") continue;
      expect(mentions(ledgerFrame(frame), betaId)).toBe(false);
    }
    replayStream.close();

    const gap = ledger.seq();
    const gammaId = ((await (await runCommand({ type: "ghost.create", name: "Gamma", persona: "shy" }, OWNER_TOKEN)).json()) as {
      result: { ghostId: string };
    }).result.ghostId;
    const live = "sse-device-2";
    notify(live, alphaId);
    const liveStream = new EventStream(await sse(`/api/events?after=${gap}`, deviceToken));
    const next = await liveStream.next();
    expect(next).not.toBeNull();
    expect(next!.event).toBe("ledger");
    expect(notificationId(next!)).toBe(live);
    expect(mentions(ledgerFrame(next!), gammaId)).toBe(false);
    liveStream.close();
  });

  test("a stale replay cursor gets a reset frame", async () => {
    ledger.db.query("DELETE FROM events WHERE seq = (SELECT MIN(seq) FROM events)").run();
    const stream = new EventStream(await sse("/api/events?after=0", OWNER_TOKEN));
    const frame = await stream.next();
    expect(frame).not.toBeNull();
    expect(frame!.event).toBe("reset");
    expect(seqFrame(frame!).seq).toBe(ledger.seq());
    stream.close();
  });

  test("static UI injects the owner token only for loopback hosts", async () => {
    const local = await get("/");
    expect(local.status).toBe(200);
    expect(local.headers.get("content-type")).toContain("text/html");
    expect(local.headers.get("cache-control")).toBe("no-store");
    expect(await local.text()).toContain(`window.__GHOST_TOKEN__="${OWNER_TOKEN}"`);

    const script = await get("/app.js");
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).not.toContain("__GHOST_TOKEN__");

    const viaPublicOrigin = await rawRequest("127.0.0.1", "/");
    expect(viaPublicOrigin.status).toBe(200);
    expect(viaPublicOrigin.body).not.toContain("__GHOST_TOKEN__");

    const rebound = await rawRequest("evil.example", "/api/health");
    expect(rebound.status).toBe(403);

    const missing = await rawRequest("127.0.0.1", "/no-such-page");
    expect(missing.status).toBe(200);
    expect(missing.body).toContain("<title>Ghost</title>");

    expect((await get("/.env", OWNER_TOKEN)).status).toBe(404);
    // The URL parser normalizes encoded dot segments into plain paths, so "/%2e%2e/..." resolves
    // inside uiDir and falls back to index.html; in-segment encoded traversals are refused outright.
    const normalizedTraversal = await rawRequest("127.0.0.1", "/%2e%2e/%2e%2e/etc/passwd");
    expect(normalizedTraversal.status).toBe(200);
    expect(normalizedTraversal.body).toContain("<title>Ghost</title>");
    const segmentTraversal = await rawRequest("127.0.0.1", "/ui%2f%2e%2e%2fsecrets");
    expect(segmentTraversal.status).toBe(404);
    // Encoded traversal inside an /api path never matches the digest shape.
    expect((await get("/api/artifacts/%2e%2e%2fledger.db", OWNER_TOKEN)).status).toBe(404);
  });

  test("the owner's stream shows notifications without a Ghost, like the snapshot", async () => {
    const stream = new EventStream(await sse(`/api/events?after=${ledger.seq()}`, OWNER_TOKEN));
    notify("sse-null-ghost", null);
    const frame = await stream.drainUntil((candidate) => candidate.event === "ledger" && notificationId(candidate) === "sse-null-ghost");
    expect(frame).not.toBeNull();
    stream.close();
  });

  test("revoking a device closes its open event stream", async () => {
    const paired = await pairDevice("Stream Phone", alphaId);
    const stream = new EventStream(await sse(`/api/events?after=${ledger.seq()}`, paired.token));
    notify("revoke-marker", alphaId);
    const seen = await stream.drainUntil((frame) => frame.event === "ledger" && notificationId(frame) === "revoke-marker");
    expect(seen).not.toBeNull();

    const revoked = await runCommand({ type: "device.revoke", deviceId: paired.deviceId }, OWNER_TOKEN);
    expect(revoked.status).toBe(200);
    // The server closes the stream on device.removed; later events cannot arrive on it.
    expect(await stream.next()).toBeNull();
    notify("after-revoke", alphaId);
    expect(await stream.next()).toBeNull();
  });

  test("narrowing a device's grants stops events for the removed Ghost", async () => {
    const createdA = (await (await runCommand({ type: "ghost.create", name: "StreamA", persona: "calm" }, OWNER_TOKEN)).json()) as {
      result: { ghostId: string };
    };
    const ghostA = createdA.result.ghostId;
    const createdB = (await (await runCommand({ type: "ghost.create", name: "StreamB", persona: "warm" }, OWNER_TOKEN)).json()) as {
      result: { ghostId: string };
    };
    const ghostB = createdB.result.ghostId;
    const paired = await pairDevice("Narrow Phone", ghostA);
    const stream = new EventStream(await sse(`/api/events?after=${ledger.seq()}`, paired.token));
    notify("narrow-before", ghostA);
    const before = await stream.drainUntil((frame) => frame.event === "ledger" && notificationId(frame) === "narrow-before");
    expect(before).not.toBeNull();

    const updated = await runCommand({ type: "device.update", deviceId: paired.deviceId, grants: [{ ghostId: ghostB, conversationId: null }] }, OWNER_TOKEN);
    expect(updated.status).toBe(200);
    // Consume the device event itself so the grants rebuild has definitely been applied.
    await stream.drainUntil((frame) => frame.event === "ledger" && mentions(ledgerFrame(frame), paired.deviceId));

    notify("narrow-a-hidden", ghostA);
    notify("narrow-b-shown", ghostB);
    const shown = await stream.drainUntil((frame) => frame.event === "ledger" && notificationId(frame) === "narrow-b-shown");
    expect(shown).not.toBeNull();
    // Frames are ordered by seq, so the later B event proves the earlier A event was filtered.
    expect(stream.frames.filter((frame) => frame.event === "ledger" && notificationId(frame) === "narrow-a-hidden")).toHaveLength(0);
    stream.close();
  });

  test("UI read errors return the JSON error shape", async () => {
    writeFileSync(join(uiDir, "denied.html"), "<p>unreadable</p>");
    chmodSync(join(uiDir, "denied.html"), 0o000);
    const response = await rawRequest("127.0.0.1", "/denied.html");
    chmodSync(join(uiDir, "denied.html"), 0o644);
    expect(response.status).toBe(500);
    const body = JSON.parse(response.body) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal");
  });

  test("token injection needs a loopback peer address", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.10")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.10")).toBe(false);
  });

  test("the pairing limiter caps per address, globally, and prunes expired windows", () => {
    const limiter = new PairingLimiter(2, 3);
    const t0 = 1_000_000;
    expect(limiter.allows("a", t0)).toBe(true);
    limiter.noteFailure("a", t0);
    limiter.noteFailure("a", t0);
    expect(limiter.allows("a", t0)).toBe(false);
    // Attempts alone consume nothing; only the recorded failures above did.
    expect(limiter.allows("b", t0)).toBe(true);
    expect(limiter.allows("b", t0)).toBe(true);
    limiter.noteFailure("b", t0);
    // The global cap (3) is now reached, so even a fresh address is refused.
    expect(limiter.allows("c", t0)).toBe(false);
    expect(limiter.allows("d", t0)).toBe(false);
    expect(limiter.allows("b", t0)).toBe(false);
    // A fresh window starts for everyone once the old one expires.
    expect(limiter.allows("a", t0 + 60_000)).toBe(true);
    limiter.noteFailure("a", t0 + 60_000);
    expect(limiter.allows("a", t0 + 60_001)).toBe(true);
    expect(limiter.allows("b", t0 + 60_001)).toBe(true);
  });

  test("pairing claims are rate limited by failed attempts", async () => {
    // Successes never count: the only earlier failures are the repeat and forged claims
    // from the pairing test, so the eighth attempt here crosses the per-address limit.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      statuses.push((await postJson("/api/pairing/claim", { code: "AAAAAAAA", deviceName: "flood" })).status);
    }
    expect(statuses.slice(0, 8)).toEqual(Array.from({ length: 8 }, () => 404));
    expect(statuses.slice(8)).toEqual(Array.from({ length: 2 }, () => 429));
  });
});
