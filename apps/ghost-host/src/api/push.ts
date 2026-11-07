import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { Buffer } from "node:buffer";
import type { Notification } from "@ghost/contract";
import type { Config } from "../config.ts";
import type { Core } from "../core/core.ts";

const APNS_HOSTS = { sandbox: "api.sandbox.push.apple.com", production: "api.push.apple.com" } as const;
const TICK_MS = 5_000;
/** APNs rejects provider tokens older than an hour; refresh every half hour. */
const JWT_TTL_S = 1_800;
const EXPIRATION_S = 7 * 24 * 3_600;
const SEND_DEADLINE_MS = 15_000;
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

/** The wake-up payload carries the notification id and a short phrase; no work content. */
const payload = (notification: Notification) => ({
  aps: { alert: { title: notification.title, body: notification.body }, sound: "default" },
  notification_id: notification.id,
});

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
 * Every 5 s, sends each unpushed notification to the devices whose grants cover its Ghost
 * (owner-wide notifications go to all devices), then marks it pushed. A 410 clears that
 * device's token; transport failures are logged, never repeated automatically.
 */
export function startPush(core: Core, config: Config): { stop(): void } | null {
  const apns = config.apns;
  if (apns === null) return null;
  const key = readFileSync(apns.keyPath, "utf8");
  let cached: { token: string; issuedAt: number } | null = null;
  const tokenFor = () => {
    const now = Math.floor(Date.now() / 1000);
    if (cached === null || now - cached.issuedAt > JWT_TTL_S) cached = { token: providerJWT(key, apns.keyId, apns.teamId, now), issuedAt: now };
    return cached.token;
  };

  const tick = async () => {
    const notifications = core.ledger.unpushedNotifications();
    if (notifications.length === 0) return;
    const targets = core.ledger.pushTargets();
    if (targets.length === 0) return;
    for (const notification of notifications) {
      const receivers =
        notification.ghostId === null ? targets : targets.filter((target) => target.grants.some((grant) => grant.ghostId === notification.ghostId));
      const jwt = tokenFor();
      for (const receiver of receivers) {
        try {
          const outcome = await sendAlert(APNS_HOSTS[receiver.environment], jwt, apns.topic, receiver.token, JSON.stringify(payload(notification)));
          if (outcome.status === 410) {
            core.ledger.tx(() => core.ledger.setPushToken(receiver.deviceId, null, null));
          } else if (outcome.status < 200 || outcome.status >= 300) {
            core.log(`push ${notification.id} rejected by ${receiver.deviceId}`, outcome);
          }
        } catch (failure) {
          core.log(`push ${notification.id} to ${receiver.deviceId} failed`, failure);
        }
      }
      core.ledger.markPushed(notification.id, Date.now());
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
  };
}
