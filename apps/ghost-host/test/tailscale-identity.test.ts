import { afterAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTailscaleIdentity } from "../src/api/tailscale-identity.ts";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { Core } from "../src/core/core.ts";
import type { Engine } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const TAILNET = { origin: "https://mac.tail1234.ts.net:8443", logins: ["Owner@GitHub"] };
const HOST = "mac.tail1234.ts.net:8443";

describe("parseTailscaleIdentity", () => {
  test("keeps an exact HTTPS origin and lower-cased logins, rejects anything else", () => {
    expect(parseTailscaleIdentity(TAILNET).logins).toEqual(["owner@github"]);
    for (const bad of [
      null, [], { ...TAILNET, origin: "http://mac.tail1234.ts.net:8443" }, { ...TAILNET, origin: "https://mac.tail1234.ts.net:8443/" },
      { ...TAILNET, logins: [] }, { ...TAILNET, logins: ["a b"] }, { ...TAILNET, extra: 1 },
    ]) expect(() => parseTailscaleIdentity(bad)).toThrow("tailscaleIdentity");
  });
});

describe("Tailnet web origin", () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-tailnet-"));
  const uiDir = join(root, "ui");
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><html><head></head><body>ui</body></html>");
  const core = new Core({
    ledger: new Ledger(":memory:"),
    artifacts: new FsArtifactStore(join(root, "state")),
    sandbox: { status: (ghostId: string) => ({ ghostId, state: "none" as const, detail: "" }), control: async () => {} },
    secrets: new FileSecrets(root),
    log: () => {},
  });
  core.attach({
    open: async () => {}, submit: async () => {}, abort: async () => {},
    page: async () => ({ messages: [], before: null, live: null }),
    watch: () => () => {}, status: () => ({ ready: true, detail: "test engine" }),
    appendHistory: async () => {}, resume: () => {}, close: async () => {},
  } satisfies Engine);
  const config: Config = {
    root, host: "127.0.0.1", port: 0, publicOrigin: TAILNET.origin, tailscaleIdentity: parseTailscaleIdentity(TAILNET), uiDir,
    sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null,
  };
  const server = startServer({ core, config, ownerToken: "owner-test-token", documents: null, skills: null });
  afterAll(async () => {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  /** fetch forbids overriding Host; tailscale serve connects from loopback with the tailnet Host. */
  const raw = (path: string, headers: Record<string, string>, host = HOST) => {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const outgoing = httpRequest({ host: "127.0.0.1", port: server.port, path, headers: { host, ...headers } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
    return promise;
  };
  const owner = { "tailscale-user-login": "owner@github", "sec-fetch-site": "same-origin" };

  test("an allowed Tailscale login is the owner and never gets the owner token injected", async () => {
    const state = await raw("/api/state", owner);
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).principal).toEqual({ kind: "owner" });
    expect((await raw("/api/state", { "tailscale-user-login": "owner@github" })).status).toBe(200);
    expect((await raw("/api/state", { "tailscale-user-login": "owner@github", "sec-fetch-site": "none" })).status).toBe(200);
    expect((await raw("/", owner)).body).not.toContain("owner-test-token");
  });

  test("other logins, no login, other sites and other Hosts stay unauthenticated", async () => {
    expect((await raw("/api/state", { "tailscale-user-login": "stranger@github", "sec-fetch-site": "same-origin" })).status).toBe(401);
    expect((await raw("/api/state", {})).status).toBe(401);
    for (const site of ["cross-site", "same-site"]) expect((await raw("/api/state", { ...owner, "sec-fetch-site": site })).status).toBe(401);
    expect((await raw("/api/state", owner, `localhost:${server.port}`)).status).toBe(401);
  });
});
