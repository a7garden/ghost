import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notification } from "@ghost/contract";
import { startPush } from "../src/api/push.ts";
import type { Config } from "../src/config.ts";
import { Core } from "../src/core/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const notification = (id: string, kind: Notification["kind"], createdAt: number): Notification => ({
  id,
  kind,
  ghostId: null,
  conversationId: null,
  workId: null,
  decisionId: null,
  title: `t-${id}`,
  body: `b-${id}`,
  createdAt,
  readAt: null,
});

interface PushFixture {
  ledger: Ledger;
  sent: { token: string; id: string; body: string }[];
  statuses: Map<string, number>;
  hold(): void;
  release(): void;
  tick(): Promise<void>;
  addDevice(id: string): void;
  register(id: string, token: string, at: number, environment?: "sandbox" | "production"): void;
  addNotification(id: string, kind: Notification["kind"], at: number): void;
  cutoff(id: string): number | null;
  storedToken(id: string): string | null;
  delivered(token: string): string[];
  expectJournaled(...ids: string[]): void;
  close(): Promise<void>;
}

// Each test owns the real ledger, core, and fanout. Only the external APNs send is injected.
function createFixture(): PushFixture {
  const root = mkdtempSync(join(tmpdir(), "ghost-push-activation-"));
  const keyPath = join(root, "apns-auth-key.p8");
  writeFileSync(keyPath, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }));
  const ledger = new Ledger(":memory:");
  const core = new Core({
    ledger,
    artifacts: new FsArtifactStore(join(root, "state")),
    sandbox: { status: (ghostId: string) => ({ ghostId, state: "none" as const, detail: "" }), control: async () => {} },
    secrets: new FileSecrets(root),
    log: () => {},
  });
  const config: Config = {
    root,
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    uiDir: root,
    sandbox: { kind: "local" },
    voice: null,
    apns: { teamId: "test-team", keyId: "test-key", keyPath, topic: "dev.ghost.test" },
    skills: null,
    reach: null,
    browser: null,
  };
  const sent: PushFixture["sent"] = [];
  const statuses = new Map<string, number>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  const handle = startPush(core, config, async (_host, _jwt, _topic, token, body) => {
    sent.push({ token, id: JSON.parse(body).notification_id, body });
    const status = statuses.get(token) ?? 200;
    if (held) await gate.promise;
    return { status, reason: status === 410 ? "Unregistered" : null };
  })!;
  const pending: Promise<void>[] = [];
  return {
    ledger,
    sent,
    statuses,
    hold: () => { held = true; },
    release: () => {
      held = false;
      gate.resolve();
    },
    tick: () => {
      const tick = handle.tick();
      pending.push(tick);
      return tick;
    },
    addDevice: (id: string) => ledger.tx(() => ledger.insertDevice(
      { id, name: id, pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: 0, lastSeenAt: null },
      `hash-${id}`,
    )),
    register: (id: string, token: string, at: number, environment: "sandbox" | "production" = "sandbox") =>
      ledger.tx(() => ledger.setPushToken(id, token, environment, at)),
    addNotification: (id: string, kind: Notification["kind"], at: number) => ledger.tx(() => ledger.putNotification(notification(id, kind, at))),
    cutoff: (id: string) => ledger.setting<number | null>(`device.push.since:${id}`, null),
    storedToken: (id: string) => ledger.db.query<{ push_token: string | null }, [string]>("SELECT push_token FROM devices WHERE id = ?").get(id)!.push_token,
    delivered: (token: string) => sent.filter((row) => row.token === token).map((row) => row.id),
    expectJournaled: (...ids: string[]) => {
      for (const id of ids) {
        expect(ledger.db.query("SELECT pushed_at, read_at FROM notifications WHERE id = ?").get(id)).toEqual({ pushed_at: expect.any(Number), read_at: null });
      }
      expect(ledger.unpushedNotifications()).toEqual([]);
    },
    close: async () => {
      handle.stop();
      held = false;
      gate.resolve();
      await Promise.allSettled(pending);
      try {
        ledger.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

async function withFixture(run: (fixture: PushFixture) => Promise<void>) {
  const fixture = createFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

describe("push activation", () => {
  for (const content of [
    { name: "Hangul", id: "한".repeat(128), title: "제목".repeat(128), body: "한".repeat(2_048) },
    { name: "emoji", id: "emoji", title: "😀".repeat(128), body: "🚀".repeat(1_024) },
    { name: "JSON escapes", id: '"\\'.repeat(64), title: "\u0000".repeat(256), body: '\u0002"\\\n'.repeat(512) },
  ]) {
    test(`oversized ${content.name} previews fit the APNs wire limit without changing the inbox`, () => withFixture(async (f) => {
      const token = "aa".repeat(32);
      f.addDevice("phone");
      f.register("phone", token, 1_000);
      const original = { ...notification(content.id, "decision", 2_000), title: content.title, body: content.body };
      f.ledger.tx(() => f.ledger.putNotification(original));
      const fullEnvelope = {
        aps: { alert: { title: original.title, body: original.body }, sound: "default" },
        notification_id: original.id,
      };
      expect(Buffer.byteLength(JSON.stringify(fullEnvelope), "utf8")).toBeGreaterThan(4_096);

      await f.tick();

      expect(f.sent).toHaveLength(1);
      const wire = f.sent[0]!.body;
      expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(4_096);
      const parsed = JSON.parse(wire);
      const preview: string = parsed.aps.alert.body;
      expect(parsed).toEqual({ ...fullEnvelope, aps: { ...fullEnvelope.aps, alert: { title: original.title, body: preview } } });
      expect(preview.length).toBeGreaterThan(0);
      expect(preview.length).toBeLessThan(original.body.length);
      expect(original.body.startsWith(preview)).toBe(true);
      expect(Buffer.from(preview, "utf8").toString("utf8")).toBe(preview);
      expect(f.ledger.notification(original.id)).toEqual(original);
      f.expectJournaled(original.id);
    }));
  }

  for (const fits of [true, false]) {
    test(`${fits ? "an exact-limit" : "a just-over-limit"} emoji boundary preserves whole codepoints and durable text`, () => withFixture(async (f) => {
      const token = "aa".repeat(32);
      f.addDevice("phone");
      f.register("phone", token, 1_000);
      const original = notification("unicode-boundary", "work_done", 2_000);
      const emptyEnvelope = {
        aps: { alert: { title: original.title, body: "" }, sound: "default" },
        notification_id: original.id,
      };
      const budget = 4_096 - Buffer.byteLength(JSON.stringify(emptyEnvelope), "utf8");
      const prefixBytes = budget - (fits ? 4 : 2);
      const prefix = "한".repeat(Math.floor(prefixBytes / 3)) + "a".repeat(prefixBytes % 3);
      original.body = `${prefix}😀`;
      f.ledger.tx(() => f.ledger.putNotification(original));

      await f.tick();

      expect(f.sent).toHaveLength(1);
      const wire = f.sent[0]!.body;
      const expectedBody = fits ? original.body : prefix;
      expect(Buffer.byteLength(wire, "utf8")).toBe(fits ? 4_096 : 4_094);
      expect(JSON.parse(wire)).toEqual({
        ...emptyEnvelope,
        aps: { ...emptyEnvelope.aps, alert: { title: original.title, body: expectedBody } },
      });
      if (fits) {
        expect(wire).toBe(JSON.stringify({
          ...emptyEnvelope,
          aps: { ...emptyEnvelope.aps, alert: { title: original.title, body: original.body } },
        }));
      }
      expect(f.ledger.notification(original.id)).toEqual(original);
      f.expectJournaled(original.id);
    }));
  }

  test("a fresh registration suppresses backlog but delivers new decisions and completions without reading them", () => withFixture(async (f) => {
    const token = "aa".repeat(32);
    f.addDevice("phone");
    f.register("phone", token, 2_000);
    f.addNotification("backlog", "work_done", 1_000);
    f.addNotification("decision", "decision", 3_000);
    f.addNotification("completion", "work_done", 4_000);

    await f.tick();

    expect(f.delivered(token)).toEqual(["decision", "completion"]);
    f.expectJournaled("backlog", "decision", "completion");
  }));

  test("reopening and rotating a registered token retain queued eligible notifications", () => withFixture(async (f) => {
    const original = "aa".repeat(32);
    const rotated = "bb".repeat(32);
    f.addDevice("phone");
    f.register("phone", original, 1_000);
    f.addNotification("queued-decision", "decision", 2_000);
    f.register("phone", original, 3_000);
    await f.tick();
    f.addNotification("queued-completion", "work_done", 4_000);
    f.register("phone", rotated, 5_000, "production");
    await f.tick();

    expect(f.delivered(original)).toEqual(["queued-decision"]);
    expect(f.delivered(rotated)).toEqual(["queued-completion"]);
    expect(f.cutoff("phone")).toBe(1_000);
    f.expectJournaled("queued-decision", "queued-completion");
  }));

  test("clearing and registering again suppresses notifications from the inactive interval", () => withFixture(async (f) => {
    const original = "aa".repeat(32);
    const replacement = "bb".repeat(32);
    f.addDevice("phone");
    f.register("phone", original, 1_000);
    f.ledger.tx(() => f.ledger.setPushToken("phone", null, null, 2_000));
    expect(f.cutoff("phone")).toBeNull();
    expect(f.storedToken("phone")).toBeNull();
    f.addNotification("inactive", "work_done", 3_000);
    f.register("phone", replacement, 4_000);
    f.addNotification("reactivated", "decision", 5_000);
    await f.tick();

    expect(f.delivered(original)).toEqual([]);
    expect(f.delivered(replacement)).toEqual(["reactivated"]);
    expect(f.cutoff("phone")).toBe(4_000);
    f.expectJournaled("inactive", "reactivated");
  }));

  test("revocation drops eligibility and a newly paired device starts with its own cutoff", () => withFixture(async (f) => {
    const revoked = "aa".repeat(32);
    const replacement = "bb".repeat(32);
    f.addDevice("revoked");
    f.register("revoked", revoked, 1_000);
    f.ledger.tx(() => f.ledger.revokeDevice("revoked", 2_000));
    f.addNotification("before-pairing", "work_done", 3_000);
    f.addDevice("replacement");
    f.register("replacement", replacement, 4_000);
    f.addNotification("after-pairing", "decision", 5_000);
    await f.tick();

    expect(f.delivered(revoked)).toEqual([]);
    expect(f.delivered(replacement)).toEqual(["after-pairing"]);
    expect(f.cutoff("revoked")).toBeNull();
    expect(f.storedToken("revoked")).toBeNull();
    f.expectJournaled("before-pairing", "after-pairing");
  }));

  test("legacy active tokens retain queued alerts when re-registering or rotating without a cutoff", () => withFixture(async (f) => {
    const original = "aa".repeat(32);
    const rotated = "bb".repeat(32);
    f.addDevice("legacy");
    // Reproduce an already opted-in installation from before activation tracking existed.
    f.ledger.db.query("UPDATE devices SET push_token = ?, push_environment = 'sandbox' WHERE id = ?").run(original, "legacy");
    f.addNotification("legacy-decision", "decision", 1_000);
    f.register("legacy", original, 3_000);
    await f.tick();
    f.addNotification("legacy-completion", "work_done", 4_000);
    f.register("legacy", rotated, 5_000, "production");
    await f.tick();

    expect(f.delivered(original)).toEqual(["legacy-decision"]);
    expect(f.delivered(rotated)).toEqual(["legacy-completion"]);
    expect(f.cutoff("legacy")).toBeNull();
    f.expectJournaled("legacy-decision", "legacy-completion");
  }));

  test("overlapping ticks send only once while the first send is pending", () => withFixture(async (f) => {
    const token = "aa".repeat(32);
    f.addDevice("phone");
    f.register("phone", token, 1_000);
    f.addNotification("slow", "work_done", 2_000);
    f.hold();
    const first = f.tick();
    await f.tick();
    expect(f.delivered(token)).toEqual(["slow"]);
    f.release();
    await first;

    expect(f.delivered(token)).toEqual(["slow"]);
    f.expectJournaled("slow");
  }));

  test("a 410 removes token and cutoff before later notifications in the same fanout", () => withFixture(async (f) => {
    const stale = "aa".repeat(32);
    const healthy = "bb".repeat(32);
    const replacement = "cc".repeat(32);
    f.addDevice("stale");
    f.register("stale", stale, 1_000);
    f.addDevice("healthy");
    f.register("healthy", healthy, 1_000);
    f.statuses.set(stale, 410);
    f.addNotification("first", "decision", 2_000);
    f.addNotification("second", "work_done", 3_000);
    await f.tick();

    expect(f.delivered(stale)).toEqual(["first"]);
    expect(f.delivered(healthy)).toEqual(["first", "second"]);
    expect(f.storedToken("stale")).toBeNull();
    expect(f.cutoff("stale")).toBeNull();
    f.expectJournaled("first", "second");

    f.addNotification("before-reactivation", "work_done", 8_000);
    f.register("stale", replacement, 9_000);
    f.addNotification("after-reactivation", "decision", 10_000);
    await f.tick();
    expect(f.delivered(stale)).toEqual(["first"]);
    expect(f.delivered(replacement)).toEqual(["after-reactivation"]);
    expect(f.cutoff("stale")).toBe(9_000);
    f.expectJournaled("first", "second", "before-reactivation", "after-reactivation");
  }));

  for (const action of ["clear", "rotate", "revoke"] as const) {
    for (const position of ["sending", "waiting"] as const) {
      test(`${action} during an awaited send refreshes the ${position} receiver before further I/O`, () => withFixture(async (f) => {
        const devices = [
          { id: "phone-a", token: "aa".repeat(32) },
          { id: "phone-b", token: "bb".repeat(32) },
        ];
        const replacement = "cc".repeat(32);
        for (const device of devices) {
          f.addDevice(device.id);
          f.register(device.id, device.token, 1_000);
        }
        f.addNotification("first", "decision", 2_000);
        f.addNotification("second", "work_done", 3_000);
        f.hold();
        const pending = f.tick();
        expect(f.sent).toHaveLength(1);
        const sendingToken = f.sent[0]!.token;
        const affected = devices.find((device) => (device.token === sendingToken) === (position === "sending"))!;
        const unaffected = devices.find((device) => device.id !== affected.id)!;
        if (action === "clear") f.ledger.tx(() => f.ledger.setPushToken(affected.id, null, null, 4_000));
        else if (action === "revoke") f.ledger.tx(() => f.ledger.revokeDevice(affected.id, 4_000));
        else f.register(affected.id, replacement, 4_000, "production");
        f.release();
        await pending;

        expect(f.delivered(affected.token)).toEqual(position === "sending" ? ["first"] : []);
        expect(f.delivered(unaffected.token)).toEqual(["first", "second"]);
        if (action === "rotate") {
          expect(f.delivered(replacement)).toEqual(position === "sending" ? ["second"] : ["first", "second"]);
          expect(f.storedToken(affected.id)).toBe(replacement);
          expect(f.cutoff(affected.id)).toBe(1_000);
        } else {
          expect(f.storedToken(affected.id)).toBeNull();
          expect(f.cutoff(affected.id)).toBeNull();
        }
        f.expectJournaled("first", "second");
      }));
    }
  }

  test("a delayed 410 for the old token cannot clear a token rotated during that send", () => withFixture(async (f) => {
    const original = "aa".repeat(32);
    const rotated = "bb".repeat(32);
    f.addDevice("phone");
    f.register("phone", original, 1_000);
    f.statuses.set(original, 410);
    f.addNotification("first", "decision", 2_000);
    f.addNotification("second", "work_done", 3_000);
    f.hold();
    const pending = f.tick();
    f.register("phone", rotated, 4_000, "production");
    f.release();
    await pending;

    expect(f.delivered(original)).toEqual(["first"]);
    expect(f.delivered(rotated)).toEqual(["second"]);
    expect(f.storedToken("phone")).toBe(rotated);
    expect(f.cutoff("phone")).toBe(1_000);
    f.expectJournaled("first", "second");
  }));
});
