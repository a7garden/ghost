import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  ArtifactRef,
  CommandResponse,
  DEFAULT_GHOST_TOOLS,
  LedgerEvent as LedgerEventSchema,
  Notification as NotificationSchema,
  ProviderCatalog,
  Settings,
  type DeviceAlerts,
  type LedgerEvent,
  State,
  parse,
  validate,
} from "@ghost/contract";
import type { Config } from "../src/config.ts";
import { isLoopbackAddress, startServer } from "../src/api/server.ts";
import { PairingLimiter } from "../src/api/pairing-limit.ts";
import { shouldPush } from "../src/api/push.ts";
import { Core } from "../src/core/core.ts";
import type { ConversationSetup, Engine, Submission, TranscriptPage } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";
import { ProviderCatalog as HostProviderCatalog } from "../src/integrations/provider-catalog.ts";
import { HOST_VERSION } from "../src/update/identity.ts";

const OWNER_TOKEN = "owner-test-token";
const VERSION = HOST_VERSION;

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
  catalog: new HostProviderCatalog({
    fetch: (async () => Response.json({
      "zai-coding-plan": { models: {
        "glm-api-discovery": {
          id: "glm-api-discovery", name: "Discovered GLM", tool_call: true, reasoning: true,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 256_000, output: 32_000 },
        },
      } },
    })),
  }),
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
  voice: null,
  apns: null,
  skills: null,
  reach: null,
  browser: null,
};
const server = startServer({ core, config, ownerToken: OWNER_TOKEN, documents: null, skills: null });
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
async function pairDevice(name: string): Promise<{ deviceId: string; token: string }> {
  const started = (await (
    await runCommand({ type: "device.pairing_start" }, OWNER_TOKEN)
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

  test("ghost tools reject unknown names and duplicates through the schema", async () => {
    const expectInvalid = async (command: Record<string, unknown>) => {
      const response = parse(CommandResponse, await (await runCommand(command, OWNER_TOKEN)).json());
      if (response.ok || response.error.code !== "invalid") throw new Error(`expected an invalid error for ${String(command.type)}`);
    };
    await expectInvalid({ type: "ghost.create", name: "Bad", persona: "", tools: ["time_travel"] });
    await expectInvalid({ type: "ghost.create", name: "Dup", persona: "", tools: ["read", "read"] });
    await expectInvalid({ type: "ghost.update", ghostId: alphaId, tools: ["bash", "bash"] });
    const state = parse(State, await (await get("/api/state", OWNER_TOKEN)).json());
    expect(state.ghosts.filter((ghost) => ghost.name === "Bad" || ghost.name === "Dup")).toHaveLength(0);
  });

  test("ghost.create defaults to every tool except host tools; ghost.update narrows it", async () => {
    const created = parse(CommandResponse, await (await runCommand({ type: "ghost.create", name: "Tooled", persona: "flexible" }, OWNER_TOKEN)).json());
    if (!created.ok || typeof created.result.ghostId !== "string") throw new Error("ghost.create failed");
    const tooledId = created.result.ghostId;
    const readTools = async () => {
      const state = parse(State, await (await get("/api/state", OWNER_TOKEN)).json());
      const ghost = state.ghosts.find((candidate) => candidate.id === tooledId);
      if (!ghost) throw new Error("the created Ghost is missing from state");
      return ghost.tools;
    };
    expect(await readTools()).toEqual([...DEFAULT_GHOST_TOOLS]);
    expect(DEFAULT_GHOST_TOOLS.some((tool) => tool.startsWith("host_"))).toBe(false);
    const narrowed = parse(CommandResponse, await (await runCommand({ type: "ghost.update", ghostId: tooledId, tools: ["work_list"] }, OWNER_TOKEN)).json());
    expect(narrowed.ok).toBe(true);
    expect(await readTools()).toEqual(["work_list"]);
  });

  test("a Ghost's look keeps its body shape and accessory; unknown values are refused", async () => {
    const look = { avatarId: null, body: "#59a08b", shape: "sheet", face: "dots", mark: "headphones" } as const;
    const updated = parse(CommandResponse, await (await runCommand({ type: "ghost.update", ghostId: alphaId, look }, OWNER_TOKEN)).json());
    expect(updated.ok).toBe(true);
    const readLook = async () => parse(State, await (await get("/api/state", OWNER_TOKEN)).json()).ghosts.find((ghost) => ghost.id === alphaId)?.look;
    expect(await readLook()).toEqual(look);
    for (const bad of [{ ...look, shape: "star" }, { ...look, mark: "cape" }]) {
      const refused = parse(CommandResponse, await (await runCommand({ type: "ghost.update", ghostId: alphaId, look: bad }, OWNER_TOKEN)).json());
      expect(refused.ok ? "ok" : refused.error.code).toBe("invalid");
    }
    expect(await readLook()).toEqual(look);
  });

  test("pairing: owner starts, device claims once", async () => {
    const started = (await (
      await runCommand({ type: "device.pairing_start" }, OWNER_TOKEN)
    ).json()) as { ok: boolean; result: { code: string; expiresAt: number; origin: string } };
    expect(started.ok).toBe(true);
    expect(started.result.origin).toBe("http://127.0.0.1");

    const claim = await postJson("/api/pairing/claim", { code: started.result.code, deviceName: "  Test Phone  " });
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

  test("a paired device sees every Ghost and the same collections as the owner, including new ones", async () => {
    betaId = ((await (await runCommand({ type: "ghost.create", name: "Beta", persona: "quiet" }, OWNER_TOKEN)).json()) as {
      result: { ghostId: string };
    }).result.ghostId;
    await pairDevice("Other Phone");
    ledger.tx(() => {
      ledger.putSpace({ id: "owner-vault", name: "Vault", path: root, createdAt: Date.now() });
      ledger.putSchedule({
        id: "owner-schedule", ghostId: betaId, conversationId: ledger.ghost(betaId).directConversationId,
        prompt: "Later", spec: { kind: "at", at: Date.now() + 60_000 }, nextAt: Date.now() + 60_000,
        state: "active", createdAt: Date.now(),
      });
    });
    const state = parse(State, await (await get("/api/state", deviceToken)).json());
    const ownerState = parse(State, await (await get("/api/state", OWNER_TOKEN)).json());
    for (const key of ["ghosts", "conversations", "works", "decisions", "notifications", "schedules", "spaces", "settings", "devices", "sandboxes", "activities", "activityRuns", "connections"] as const) {
      expect(state[key]).toEqual(ownerState[key]);
    }
    expect(state.ghosts.map((ghost) => ghost.id)).toContain(betaId);
    expect(state.principal).toEqual({ kind: "device", deviceId, name: "Test Phone" });
    expect(ledger.device(deviceId).name).toBe("Test Phone");
    expect(state.schedules.length).toBeGreaterThan(0);
    expect(state.spaces.length).toBeGreaterThan(0);
    expect(state.devices.length).toBeGreaterThan(1);
    expect(state.devices[0]).not.toHaveProperty("grants");
  });

  test("pairing claims name the device, default empty names, and retain readable legacy columns", async () => {
    for (const name of ["", "   ", "x".repeat(128)]) {
      const paired = await pairDevice(name);
      expect(ledger.device(paired.deviceId).name).toBe(name.trim() || "iPhone");
      expect(ledger.db.query("SELECT grants FROM devices WHERE id = ?").get(paired.deviceId)).toEqual({ grants: "[]" });
    }
    expect(ledger.db.query("SELECT DISTINCT grants FROM pairings").all()).toEqual([{ grants: "[]" }]);
    const started = (await (await runCommand({ type: "device.pairing_start" }, OWNER_TOKEN)).json()) as { result: { code: string } };
    expect((await postJson("/api/pairing/claim", { code: started.result.code, deviceName: "x".repeat(129) })).status).toBe(400);
    expect((await postJson("/api/pairing/claim", { code: started.result.code, deviceName: "Valid" })).status).toBe(200);
  });

  test("device management stays owner-only; a device may still act like the owner elsewhere", async () => {
    const other = await pairDevice("Managed Phone");
    for (const command of [
      { type: "device.pairing_start" },
      { type: "device.update", deviceId, name: "Cannot rename myself" },
      { type: "device.revoke", deviceId: other.deviceId },
    ]) {
      const response = await runCommand(command, deviceToken);
      expect(response.status).toBe(403);
      const body = parse(CommandResponse, await response.json());
      expect(body.ok ? "ok" : body.error.message).toBe(`${command.type} needs the owner`);
    }
    // Owner-equivalent elsewhere: the device creates a Ghost and a schedule like the owner can.
    const created = parse(CommandResponse, await (await runCommand({ type: "ghost.create", name: "By Device", persona: "" }, deviceToken)).json());
    expect(created.ok).toBe(true);
    if (!created.ok || typeof created.result.ghostId !== "string") throw new Error("ghost.create returned no ghostId");
    const ghostId = created.result.ghostId;
    const scheduled = parse(CommandResponse, await (await runCommand({
      type: "schedule.create", ghostId, conversationId: ledger.ghost(ghostId).directConversationId,
      prompt: "From the phone", spec: { kind: "at", at: Date.now() + 60_000 },
    }, deviceToken)).json());
    expect(scheduled.ok).toBe(true);
  });

  test("paired devices register push targets without per-Ghost filtering", async () => {
    const paired = await pairDevice("Push Phone");
    const response = await runCommand({
      type: "device.push_register", token: "ab".repeat(32), environment: "sandbox",
    }, paired.token);
    expect(response.status).toBe(200);
    expect(ledger.pushTargets()).toEqual([{ deviceId: paired.deviceId, token: "ab".repeat(32), environment: "sandbox", alerts: { mutedKinds: [], mutedGhostIds: [] } }]);
    expect(ledger.device(paired.deviceId).pushEnabled).toBe(true);
    expect((await runCommand({ type: "device.revoke", deviceId: paired.deviceId }, OWNER_TOKEN)).status).toBe(200);
    expect(ledger.pushTargets()).toEqual([]);
  });
  test("a device mutes kinds and Ghosts for its own pushes and the owner cannot set them", async () => {
    const paired = await pairDevice("Quiet Phone");
    const alerts: DeviceAlerts = { mutedKinds: ["decision", "work_failed"], mutedGhostIds: ["ghost-to-mute"] };
    expect((await runCommand({ type: "device.alerts_update", alerts }, paired.token)).status).toBe(200);
    const state = parse(State, await (await get("/api/state", paired.token)).json());
    expect(state.devices.find((device) => device.id === paired.deviceId)?.alerts).toEqual(alerts);

    const ownerResponse = await runCommand({ type: "device.alerts_update", alerts: { mutedKinds: [], mutedGhostIds: [] } }, OWNER_TOKEN);
    expect(ownerResponse.status).toBe(400);
    const body = parse(CommandResponse, await ownerResponse.json());
    expect(body.ok ? "ok" : body.error.message).toBe("only a paired device sets its alerts");
    expect(ledger.device(paired.deviceId).alerts).toEqual(alerts);
  });
  test("a device's stored alert preferences read back and their settings key is deleted on revoke", async () => {
    const paired = await pairDevice("Pref Phone");
    const alerts: DeviceAlerts = { mutedKinds: ["work_done"], mutedGhostIds: ["ghost-to-mute"] };
    expect((await runCommand({ type: "device.alerts_update", alerts }, paired.token)).status).toBe(200);
    expect(ledger.device(paired.deviceId).alerts).toEqual(alerts);
    const key = `device.alerts:${paired.deviceId}`;
    expect(ledger.db.query("SELECT value FROM settings WHERE key = ?").get(key)).toEqual({ value: JSON.stringify(alerts) });
    expect((await runCommand({ type: "device.revoke", deviceId: paired.deviceId }, OWNER_TOKEN)).status).toBe(200);
    expect(ledger.db.query("SELECT value FROM settings WHERE key = ?").get(key)).toBeNull();
  });
  test("shouldPush drops only the muted kinds and muted Ghosts of that device", () => {
    const alerts: DeviceAlerts = { mutedKinds: ["decision"], mutedGhostIds: ["g-mute"] };
    expect(shouldPush({ id: "n1", kind: "decision", ghostId: null, conversationId: null, workId: null, decisionId: null, title: "t", body: "b", createdAt: 1, readAt: null }, alerts)).toBe(false);
    expect(shouldPush({ id: "n2", kind: "work_done", ghostId: "g-mute", conversationId: null, workId: null, decisionId: null, title: "t", body: "b", createdAt: 1, readAt: null }, alerts)).toBe(false);
    expect(shouldPush({ id: "n3", kind: "work_done", ghostId: null, conversationId: null, workId: null, decisionId: null, title: "t", body: "b", createdAt: 1, readAt: null }, alerts)).toBe(true);
    expect(shouldPush({ id: "n4", kind: "work_done", ghostId: "g-other", conversationId: null, workId: null, decisionId: null, title: "t", body: "b", createdAt: 1, readAt: null }, alerts)).toBe(true);
    expect(shouldPush({ id: "n5", kind: "decision", ghostId: "g-other", conversationId: null, workId: null, decisionId: null, title: "t", body: "b", createdAt: 1, readAt: null }, { mutedKinds: [], mutedGhostIds: [] })).toBe(true);
  });
  test("owner uploads raw artifacts and reads them without a Work row", async () => {
    const bytes = new TextEncoder().encode("첨부 파일 내용");
    const response = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "text/plain; charset=utf-8", "x-ghost-file-name": encodeURIComponent("자료.txt") },
      body: bytes,
    });
    expect(response.status).toBe(201);
    const artifact = parse(ArtifactRef, await response.json());
    expect(artifact).toMatchObject({ name: "자료.txt", mediaType: "text/plain; charset=utf-8", size: bytes.byteLength });
    expect(ledger.artifactsForDigest(artifact.digest)).toEqual([]);
    // Any stored digest is readable by every authenticated principal, unregistered ones included.
    const downloaded = await get(`/api/artifacts/${artifact.digest}`, OWNER_TOKEN);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect((await get(`/api/artifacts/${artifact.digest}`, deviceToken)).status).toBe(200);
    expect(new Uint8Array(await (await get(`/api/artifacts/${artifact.digest}`, deviceToken)).arrayBuffer())).toEqual(bytes);
    expect((await runCommand({ type: "message.send", conversationId: alphaDirectId, text: "첨부 확인", attachments: [artifact] }, OWNER_TOKEN)).status).toBe(200);
    expect(engine.submitted.at(-1)?.submission.attachments).toEqual([artifact]);
    expect((await get(`/api/artifacts/${artifact.digest}`, OWNER_TOKEN)).status).toBe(200);
  });

  test("a device uploads raw artifacts and reads them without a Work row", async () => {
    const bytes = new TextEncoder().encode("기기에서 올린 파일");
    const response = await fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "text/plain; charset=utf-8", "x-ghost-file-name": encodeURIComponent("기기자료.txt") },
      body: bytes,
    });
    expect(response.status).toBe(201);
    const artifact = parse(ArtifactRef, await response.json());
    expect(artifact).toMatchObject({ name: "기기자료.txt", mediaType: "text/plain; charset=utf-8", size: bytes.byteLength });
    const downloaded = await get(`/api/artifacts/${artifact.digest}`, deviceToken);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });

  test("artifact uploads reject missing auth, invalid metadata and bodies above 20 MiB", async () => {
    const upload = (token: string | undefined, name: string, mediaType: string, body: BodyInit = "bytes") => fetch(`${base}/api/artifacts`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": mediaType, "x-ghost-file-name": name },
      body,
    });
    expect((await upload(undefined, "test.txt", "text/plain")).status).toBe(401);
    for (const [name, mediaType] of [["", "text/plain"], ["x".repeat(257), "text/plain"], ["%broken", "text/plain"], ["bad%00name", "text/plain"], ["test", "not-a-type"], ["test", `text/${"x".repeat(124)}`]]) {
      const response = await upload(OWNER_TOKEN, name!, mediaType!);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
    }
    const limit = 20 * 1024 * 1024;
    const exact = await upload(OWNER_TOKEN, "limit.bin", "application/octet-stream", new Uint8Array(limit));
    expect(exact.status).toBe(201);
    expect(parse(ArtifactRef, await exact.json()).size).toBe(limit);
    const oversized = await upload(OWNER_TOKEN, "large.bin", "application/octet-stream", new Uint8Array(limit + 1));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "invalid" } });
    const streamed = await upload(OWNER_TOKEN, "streamed.bin", "application/octet-stream", new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(limit));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }));
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toMatchObject({ error: { code: "invalid" } });
  });


  test("provider login routes treat a device like the owner", async () => {
    const path = `${base}/api/providers/codex/oauth`;
    for (const method of ["GET", "POST", "DELETE"]) {
      expect((await fetch(path, { method })).status).toBe(401);
      // Unknown provider answers 404: the device passed the principal gate.
      expect((await fetch(path, { method, headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(404);
    }
  });

  test("OAuth rejects custom endpoints before starting a login", async () => {
    await runCommand({ type: "provider.upsert", id: "oauth-custom", kind: "openai", name: "Custom", baseUrl: "https://attacker.invalid", models: [] }, OWNER_TOKEN);
    const response = await postJson("/api/providers/oauth-custom/oauth", {}, OWNER_TOKEN);
    expect(response.status).toBe(400);
    expect(core.secrets.has("oauth-custom")).toBe(false);
  });

  test("the provider catalog serves every principal and recommends only listed models", async () => {
    expect((await get("/api/providers/catalog")).status).toBe(401);
    const deviceResponse = await get("/api/providers/catalog", deviceToken);
    expect(deviceResponse.status).toBe(200);
    expect(parse(ProviderCatalog, await deviceResponse.json())).toEqual(parse(ProviderCatalog, await (await get("/api/providers/catalog", OWNER_TOKEN)).json()));
    const response = await get("/api/providers/catalog", OWNER_TOKEN);
    expect(response.status).toBe(200);
    const catalog = parse(ProviderCatalog, await response.json());
    for (const preset of catalog) {
      if (preset.recommendedModelId !== null) expect(preset.models.some((model) => model.id === preset.recommendedModelId)).toBe(true);
      if (preset.recommendedOAuthModelId !== null) expect(preset.oauthModels.some((model) => model.id === preset.recommendedOAuthModelId)).toBe(true);
    }
  });

  test("owner settings and provider catalog expose discovered models without saving an allowlist", async () => {
    await core.catalog.refresh();
    const presets = parse(ProviderCatalog, await (await get("/api/providers/catalog", OWNER_TOKEN)).json());
    expect(presets.find(preset => preset.kind === "zai")?.models.find(model => model.id === "glm-api-discovery")).toMatchObject({
      input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000,
    });
    await runCommand({
      type: "provider.upsert", id: "dynamic-zai", kind: "zai", name: "Dynamic Z.AI",
      models: [{ id: "manual-saved", name: "Manual" }], apiKey: "not-returned",
    }, OWNER_TOKEN);
    const snapshot = parse(State, await (await get("/api/state", OWNER_TOKEN)).json());
    const provider = snapshot.settings.providers.find(provider => provider.id === "dynamic-zai");
    expect(provider?.models.some(model => model.id === "glm-api-discovery")).toBe(true);
    expect(provider?.configuredModels).toEqual([{ id: "manual-saved", name: "Manual" }]);
    expect(provider?.models.some(model => model.id === "manual-saved")).toBe(true);
    expect(provider?.manualModelIds).toEqual(["manual-saved"]);
    expect(provider?.automaticModels).toBe(true);
    expect(ledger.settings().providers.find(provider => provider.id === "dynamic-zai")?.models).toEqual([{ id: "manual-saved", name: "Manual" }]);
    await runCommand({ type: "settings.update", reviewModel: { provider: "dynamic-zai", model: "glm-api-discovery" } }, OWNER_TOKEN);
    expect(parse(State, await (await get("/api/state", OWNER_TOKEN)).json()).settings.reviewModel).toEqual({ provider: "dynamic-zai", model: "glm-api-discovery" });
    expect(JSON.stringify(snapshot.settings)).not.toContain("not-returned");
    await runCommand({ type: "settings.update", reviewModel: null }, OWNER_TOKEN);
    await runCommand({ type: "provider.delete", providerId: "dynamic-zai" }, OWNER_TOKEN);
  });

  test("provider settings carry the credential's auth type for the owner only", async () => {
    const settingsOf = async (token: string) => parse(State, await (await get("/api/state", token)).json()).settings;
    await runCommand({ type: "provider.upsert", id: "auth-typed", kind: "openai", name: "Typed", models: [] }, OWNER_TOKEN);

    // Without a credential the auth type is absent.
    let provider = (await settingsOf(OWNER_TOKEN)).providers.find((row) => row.id === "auth-typed");
    expect(provider?.hasCredential).toBe(false);
    expect(provider !== undefined && "authType" in provider).toBe(false);

    // An API key credential reports api_key.
    core.secrets.put("auth-typed", "sk-test");
    provider = (await settingsOf(OWNER_TOKEN)).providers.find((row) => row.id === "auth-typed");
    expect(provider?.hasCredential).toBe(true);
    expect(provider?.authType).toBe("api_key");

    // An OAuth credential reports oauth.
    await core.secrets.modify("auth-typed", async () => ({ type: "oauth", refresh: "r", access: "a", expires: Date.now() + 60_000 }));
    provider = (await settingsOf(OWNER_TOKEN)).providers.find((row) => row.id === "auth-typed");
    expect(provider?.authType).toBe("oauth");

    // The settings event emitted with the credential change carries the same metadata.
    const events: LedgerEvent[] = [];
    const unwatch = core.ledger.subscribe((event) => events.push(event));
    await runCommand({ type: "provider.upsert", id: "auth-typed", kind: "openai", name: "Typed", models: [], apiKey: "sk-test-2" }, OWNER_TOKEN);
    unwatch();
    const settingsEventData = Type.Object({ type: Type.Literal("settings"), settings: Settings });
    const settingsEvent = events.filter((event) => event.data.type === "settings").map((event) => parse(settingsEventData, event.data)).at(-1);
    expect(settingsEvent?.settings.providers.find((row) => row.id === "auth-typed")?.authType).toBe("api_key");

    // Device snapshots carry the same provider rows, so auth type metadata reaches them too.
    expect((await settingsOf(deviceToken)).providers).toEqual((await settingsOf(OWNER_TOKEN)).providers);

    await runCommand({ type: "provider.delete", providerId: "auth-typed" }, OWNER_TOKEN);
    expect(core.secrets.has("auth-typed")).toBe(false);
  });

  test("devices can read every Ghost's transcript pages", async () => {
    const owner = await get(`/api/conversations/${alphaDirectId}`, OWNER_TOKEN);
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { conversation: { id: string } }).conversation.id).toBe(alphaDirectId);
    const device = await get(`/api/conversations/${alphaDirectId}`, deviceToken);
    expect(device.status).toBe(200);
    const beta = await get(`/api/conversations/${ledger.ghost(betaId).directConversationId}`, deviceToken);
    expect(beta.status).toBe(200);
  });

  test("devices can read Work and artifacts from conversations created after pairing", async () => {
    const created = (await (
      await runCommand({ type: "conversation.create", ghostId: alphaId, title: "Second direct" }, OWNER_TOKEN)
    ).json()) as { result: { conversationId: string } };
    const secondDirect = created.result.conversationId;
    const work = (await (
      await runCommand({ type: "work.create", ghostId: alphaId, originConversationId: secondDirect, title: "Shared", brief: "b" }, deviceToken)
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
    expect(deviceResponse.status).toBe(200);
    expect(new Uint8Array(await deviceResponse.arrayBuffer())).toEqual(content);
    expect((await get(`/api/artifacts/${ref.digest}`)).status).toBe(401);
    expect((await get(`/api/works/${workId}`, deviceToken)).status).toBe(200);
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

  test("a device stream replays every Ghost and receives new Ghosts, Work, decisions and notifications live", async () => {
    notify("sse-device-replay", betaId);
    const replay = new EventStream(await sse("/api/events?after=0", deviceToken));
    expect(await replay.drainUntil((frame) => notificationId(frame) === "sse-device-replay")).not.toBeNull();
    expect(replay.frames.some((frame) => frame.event === "ledger" && mentions(ledgerFrame(frame), betaId))).toBe(true);
    replay.close();

    const stream = new EventStream(await sse(`/api/events?after=${ledger.seq()}`, deviceToken));
    const gamma = core.createGhost({ name: "Gamma", persona: "shy" });
    const work = (await (await runCommand({ type: "work.create", ghostId: gamma.id, title: "New Work", brief: "b" }, deviceToken)).json()) as {
      result: { workId: string };
    };
    const question = core.decisions.ask(gamma.directConversationId, "Which?", "Pick one", ["A", "B"]);
    notify("sse-device-global", null);
    expect(await stream.drainUntil((frame) => notificationId(frame) === "sse-device-global")).not.toBeNull();
    for (const id of [gamma.id, gamma.directConversationId, work.result.workId, question.id]) {
      expect(stream.frames.some((frame) => frame.event === "ledger" && mentions(ledgerFrame(frame), id))).toBe(true);
    }
    expect((await runCommand({ type: "decision.resolve", decisionId: question.id, outcome: "answer", answer: "B" }, deviceToken)).status).toBe(200);
    expect((await runCommand({ type: "notification.read", notificationIds: ["sse-device-global"] }, deviceToken)).status).toBe(200);
    expect(ledger.notification("sse-device-global").readAt).not.toBeNull();
    const state = parse(State, await (await get("/api/state", deviceToken)).json());
    expect(state.notifications.some((notification) => notification.id === "sse-device-global")).toBe(true);
    stream.close();
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
    const paired = await pairDevice("Stream Phone");
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
    expect((await get("/api/state", paired.token)).status).toBe(401);
  });

  test("renaming preserves device visibility and the device sees every owner event", async () => {
    const paired = await pairDevice("Rename Phone");
    const stream = new EventStream(await sse(`/api/events?after=${ledger.seq()}`, paired.token));
    const other = await pairDevice("Private Phone");
    expect((await runCommand({ type: "device.update", deviceId: paired.deviceId, name: "Renamed" }, OWNER_TOKEN)).status).toBe(200);
    expect(await stream.drainUntil((frame) => frame.event === "ledger" && mentions(ledgerFrame(frame), paired.deviceId))).not.toBeNull();
    const state = parse(State, await (await get("/api/state", paired.token)).json());
    expect(state.principal).toEqual({ kind: "device", deviceId: paired.deviceId, name: "Renamed" });
    ledger.tx(() => {
      ledger.putSchedule({ ...ledger.schedule("owner-schedule"), prompt: "Private schedule" });
      ledger.putSpace({ ...ledger.space("owner-vault"), name: "Private vault" });
      ledger.emit({ type: "settings", settings: ledger.settings() });
      ledger.emit({ type: "sandbox", sandbox: { ghostId: alphaId, state: "none", detail: "" } });
    });
    notify("rename-alpha", alphaId);
    notify("rename-beta", betaId);
    expect(await stream.drainUntil((frame) => notificationId(frame) === "rename-beta")).not.toBeNull();
    const events = stream.frames.filter((frame) => frame.event === "ledger").map(ledgerFrame);
    expect(events.some((event) => mentions(event, other.deviceId))).toBe(true);
    expect(events.some((event) => ["schedule", "space", "settings", "sandbox"].includes(event.data.type))).toBe(true);
    expect(stream.frames.some((frame) => notificationId(frame) === "rename-alpha")).toBe(true);
    stream.close();
  });

  test("a device revokes itself, its stream closes and its token is rejected", async () => {
    const paired = await pairDevice("Self-revoking Phone");
    const stream = new EventStream(await sse(`/api/events?after=${ledger.seq()}`, paired.token));
    notify("self-revoke-marker", alphaId);
    expect(await stream.drainUntil((frame) => frame.event === "ledger" && notificationId(frame) === "self-revoke-marker")).not.toBeNull();

    const revoked = await runCommand({ type: "device.revoke", deviceId: paired.deviceId }, paired.token);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true, result: {} });
    // The server closes the stream on device.removed; later events cannot arrive on it.
    expect(await stream.next()).toBeNull();
    notify("after-self-revoke", alphaId);
    expect(await stream.next()).toBeNull();
    expect((await get("/api/state", paired.token)).status).toBe(401);
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
    // Successes never count: earlier failures are the repeat, forged and overlong-name claims.
    // Seven more failures exhaust the per-address budget.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      statuses.push((await postJson("/api/pairing/claim", { code: "AAAAAAAA", deviceName: "flood" })).status);
    }
    expect(statuses.slice(0, 7)).toEqual(Array.from({ length: 7 }, () => 404));
    expect(statuses.slice(7)).toEqual(Array.from({ length: 3 }, () => 429));
  });
});
