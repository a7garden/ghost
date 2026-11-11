import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { Buffer } from "node:buffer";
import type { DeviceAlerts, Notification } from "@ghost/contract";
import type { Config } from "../config.ts";
import type { Core } from "../core/core.ts";

const APNS_HOSTS = { sandbox: "api.sandbox.push.apple.com", production: "api.push.apple.com" } as const;
const TICK_MS = 5_000;
/** APNs rejects provider tokens older than an hour; refresh every half hour. */
const JWT_TTL_S = 1_800;
const EXPIRATION_S = 7 * 24 * 3_600;
const SEND_DEADLINE_MS = 15_000;
const PAYLOAD_LIMIT_BYTES = 4_096;
const HEX_TOKEN = /^[0-9a-f]{32,128}$/;

/** APNs needs the raw 64-byte r||s signature; Node emits DER. */
function rawSignature(der: Buffer): Buffer {
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error("invalid DER signature");
  let offset = 2;
  const parts: Buffer[] = [];
  while (parts.length < 2) {
    if (der[offset] !== 0x02) throw new Error("invalid DER signature integer");
    const size = der[offset + 1]!;
    const value = der.subarray(offset + 2, offset + 2 + size);
    if (value.length !== size) throw new Error("invalid DER signature integer");
    const trimmed = value[0] === 0 ? value.subarray(1) : value;
    if (trimmed.length > 32) throw new Error("invalid signature integer length");
    parts.push(Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]));
    offset += 2 + size;
  }
  return Buffer.concat(parts);
}

function providerJWT(key: string, keyId: string, teamId: string, issuedAt: number): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: issuedAt })}`;
  const signature = rawSignature(createSign("sha256").update(signingInput).sign(key));
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

/** Bound only the APNs preview; the full, unread notification stays in the ledger. */
function payload(notification: Notification): string {
  const value = {
    aps: { alert: { title: notification.title, body: notification.body }, sound: "default" },
    notification_id: notification.id,
  };
  const full = JSON.stringify(value);
  if (Buffer.byteLength(full, "utf8") <= PAYLOAD_LIMIT_BYTES) return full;

  // Contract-sized title/id always fit, even fully JSON-escaped. Search body codepoints
  // only, measuring the entire serialized envelope so escapes and UTF-8 both count.
  const points = Array.from(notification.body);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    value.aps.alert.body = points.slice(0, middle).join("");
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= PAYLOAD_LIMIT_BYTES) low = middle;
    else high = middle - 1;
  }
  value.aps.alert.body = points.slice(0, low).join("");
  return JSON.stringify(value);
}

/** A device's mute preferences drop its own pushes only: muted kinds and muted Ghosts; a null ghostId has no Ghost to mute. */
export function shouldPush(notification: Notification, alerts: DeviceAlerts): boolean {
  if (alerts.mutedKinds.includes(notification.kind)) return false;
  return notification.ghostId === null || !alerts.mutedGhostIds.includes(notification.ghostId);
}

/**
 * HTTP/2 delivery against api[.sandbox].push.apple.com. One settlement per call: the deadline
 * resets the stream and destroys the session, and an oversized response is an error.
 */
function sendAlert(
  host: string,
  jwt: string,
  topic: string,
  token: string,
  body: string,
): Promise<{ status: number; reason: string | null }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; reason: string | null }>();
  if (!HEX_TOKEN.test(token)) {
    reject(new Error("invalid APNs device token"));
    return promise;
  }
  let settled = false;
  let request: ClientHttp2Stream | null = null;
  let session: ClientHttp2Session | null = null;
  let status = 0;
  const settle = (outcome: { status: number; reason: string | null } | null = null, failure: Error | null = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    try {
      request?.close();
    } catch {
      // already reset
    }
    try {
      session?.close();
    } catch {
      // already closed
    }
    // A graceful h2 close waits on open streams; the deferred destroy guarantees a
    // stalled socket cannot outlive the settled operation.
    setTimeout(() => {
      try {
        session?.destroy();
      } catch {
        // gone
      }
    }, 1_000).unref();
    if (failure !== null) reject(failure);
    else resolve(outcome!);
  };
  const deadline = setTimeout(() => settle(null, new Error("apns_timeout")), SEND_DEADLINE_MS);
  deadline.unref();
  session = connect(`https://${host}`);
  session.on("error", (failure: Error) => settle(null, failure));
  session.on("connect", () => {
    const stream = session!.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `Bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(Math.floor(Date.now() / 1000) + EXPIRATION_S),
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    request = stream;
    stream.setEncoding("utf8");
    let response = "";
    stream.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 4_096) settle(null, new Error("apns_response_overflow"));
    });
    stream.on("response", (headers: Record<string, unknown>) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.on("end", () => {
      let reason: string | null = null;
      try {
        reason = response.length > 0 ? (JSON.parse(response) as { reason?: string }).reason ?? null : null;
      } catch {
        reason = null;
      }
      settle({ status, reason });
    });
    stream.on("error", (failure: Error) => settle(null, failure));
    stream.end(body);
  });
  return promise;
}

/**
 * Every 5 s, sends each unpushed notification to the push targets it postdates, then marks it
 * pushed. A receiver created after a notification — its `activatedAt` cutoff — never receives
 * that backlog: the notification stays unread in the owner's inbox but is marked pushed so a
 * stale registration cannot replay it later. A 410 clears that device's token; transport
 * failures are logged, never repeated automatically. Ticks never overlap: while one fanout is
 * in flight, the next timer tick is a no-op, so a slow send cannot be duplicated.
 */
export function startPush(core: Core, config: Config, send: typeof sendAlert = sendAlert): { stop(): void; tick(): Promise<void> } | null {
  const apns = config.apns;
  if (apns === null) return null;
  const key = readFileSync(apns.keyPath, "utf8");
  let cached: { token: string; issuedAt: number } | null = null;
  const tokenFor = () => {
    const now = Math.floor(Date.now() / 1000);
    if (cached === null || now - cached.issuedAt > JWT_TTL_S) cached = { token: providerJWT(key, apns.keyId, apns.teamId, now), issuedAt: now };
    return cached.token;
  };

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const notifications = core.ledger.unpushedNotifications();
      if (notifications.length === 0) return;
      const targets = core.ledger.pushTargets();
      if (targets.length === 0) return;
      for (const notification of notifications) {
        const jwt = tokenFor();
        const body = payload(notification);
        for (const target of targets) {
          // A preceding send yielded: registration, revocation, and preferences may have changed.
          const receiver = core.ledger.pushTargets(target.deviceId)[0];
          if (!receiver || notification.createdAt < receiver.activatedAt) continue;
          if (!shouldPush(notification, receiver.alerts)) continue;
          try {
            const outcome = await send(APNS_HOSTS[receiver.environment], jwt, apns.topic, receiver.token, body);
            if (outcome.status === 410) {
              const current = core.ledger.pushTargets(receiver.deviceId)[0];
              if (current?.token === receiver.token && current.environment === receiver.environment) {
                core.ledger.tx(() => core.ledger.setPushToken(receiver.deviceId, null, null));
              }
            } else if (outcome.status < 200 || outcome.status >= 300) {
              core.log(`push ${notification.id} rejected by ${receiver.deviceId}`, outcome);
            }
          } catch (failure) {
            core.log(`push ${notification.id} to ${receiver.deviceId} failed`, failure);
          }
        }
        core.ledger.markPushed(notification.id, Date.now());
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((failure) => core.log("push tick failed", failure));
  }, TICK_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
    tick,
  };
}
