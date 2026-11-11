import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { updateFixture } from "./fixtures/update-helper.ts";
import { Core } from "../src/core/core.ts";
import { hashSecret } from "../src/core/commands.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";
import { startServer } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";

const f = await updateFixture({ idle: () => false });
const ledger = new Ledger(":memory:");
const core = new Core({ ledger, artifacts: new FsArtifactStore(f.root), sandbox: { status: (ghostId) => ({ ghostId, state: "none", detail: "" }), control: async () => {} }, secrets: new FileSecrets(f.root), log: () => {} });
ledger.tx(() => ledger.insertDevice({ id: "test-device", name: "iPhone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null }, hashSecret("device-token")));
const server = startServer({ core, config: { ...loadConfig({}, f.root), host: "127.0.0.1", port: 0 }, ownerToken: "owner-token", documents: null, skills: null, updater: f.updater });
const origin = `http://127.0.0.1:${server.port}`;
const request = (path: string, method = "GET", body?: unknown, token = "owner-token") => fetch(`${origin}/api/update${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

afterAll(async () => { await f.updater.close(); await server.stop(); core.stop(); ledger.close(); rmSync(f.temp, { recursive: true, force: true }); });

test("owner and paired device can use update routes; unauthenticated requests cannot", async () => {
  expect((await request("", "GET", undefined, "invalid")).status).toBe(401);
  for (const token of ["owner-token", "device-token"]) {
    const response = await request("", "GET", undefined, token);
    expect(response.status).toBe(200); expect((await response.json()).current.version).toBe("2.1.0");
    expect((await request("/settings", "PUT", { autoCheck: false }, token)).status).toBe(200);
  }
});

test("body validation returns the standard 400 error envelope", async () => {
  for (const [path, method, body] of [
    ["/settings", "PUT", { autoCheck: "yes" }], ["/settings", "PUT", { token: "contains space" }], ["/settings", "PUT", { token: "" }],
    ["/settings", "PUT", { unknown: true }], ["/settings", "PUT", []], ["/install", "POST", {}], ["/install", "POST", { version: "../../escape" }],
  ] as const) {
    const response = await request(path, method, body);
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("invalid");
  }
  const malformed = await fetch(`${origin}/api/update/settings`, { method: "PUT", headers: { authorization: "Bearer owner-token" }, body: "{" });
  expect(malformed.status).toBe(400);
});

test("check, shell dynamic response and cached asset proxy", async () => {
  expect((await request("/shell/latest.json")).status).toBe(204);
  const checked = await request("/check", "POST"); expect(checked.status).toBe(200);
  expect((await checked.json()).latest.version).toBe("2.2.0");
  const latest = await (await request("/shell/latest.json")).json();
  expect(latest.version).toBe("0.3.0");
  expect(latest.platforms["darwin-aarch64"].url).toBe(`${origin}/api/update/shell/Ghost.app.tar.gz`);
  const first = await request("/shell/Ghost.app.tar.gz"); expect(await first.text()).toBe("shell-asset");
  const calls = f.calls.length;
  expect(await (await request("/shell/Ghost.app.tar.gz")).text()).toBe("shell-asset"); expect(f.calls.length).toBe(calls);
});

test("wrong version and active install return 409; install returns 202 and can cancel", async () => {
  const wrong = await request("/install", "POST", { version: "9.9.9" }); expect(wrong.status).toBe(409);
  expect((await wrong.json()).error.code).toBe("conflict");
  const accepted = await request("/install", "POST", { version: "2.2.0" }); expect(accepted.status).toBe(202);
  const conflict = await request("/install", "POST", { version: "2.2.0" }); expect(conflict.status).toBe(409);
  expect((await request("/settings", "PUT", { autoCheck: false })).status).toBe(409);
  const cancelled = await request("/cancel", "POST"); expect(cancelled.status).toBe(200); expect((await cancelled.json()).phase).toBe("idle");
  expect((await request("/settings", "PUT", { token: null })).status).toBe(200);
  expect((await request("/install", "POST", { version: "2.2.0" })).status).toBe(503);
});
