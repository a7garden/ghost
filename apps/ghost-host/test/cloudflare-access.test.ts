import { afterAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareAccessVerifier, parseCloudflareAccess, type CloudflareAccessConfig } from "../src/api/cloudflare-access.ts";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { Core } from "../src/core/core.ts";
import type { Engine } from "../src/core/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";

const ACCESS: CloudflareAccessConfig = {
  origin: "https://ghost.example.com",
  teamDomain: "team.cloudflareaccess.com",
  audience: "795d0d71e9c7647aaed3b12dd8f6a7f96a0e2555e9ec14e62410858ebd092d38",
  emails: ["owner@example.com"],
};
const NOW = 1_800_000_000_000;

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const other = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function jwt(claims: Record<string, unknown> = {}, options: { kid?: string; alg?: string; key?: CryptoKey } = {}): Promise<string> {
  const header = part({ alg: options.alg ?? "RS256", kid: options.kid ?? "k1", typ: "JWT" });
  const payload = part({
    aud: [ACCESS.audience],
    iss: `https://${ACCESS.teamDomain}`,
    email: "owner@example.com",
    type: "app",
    iat: NOW / 1000 - 10,
    nbf: NOW / 1000 - 10,
    exp: NOW / 1000 + 3600,
    ...claims,
  });
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", options.key ?? pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

function certs(calls: string[], keys: () => unknown[] = () => [{ ...publicJwk, kid: "k1", alg: "RS256" }]) {
  return async (url: string) => {
    calls.push(url);
    return Response.json({ keys: keys(), public_cert: {}, public_certs: [] });
  };
}

const withToken = (token: string) => new Request("https://ghost.example.com/api/state", { headers: { "cf-access-jwt-assertion": token } });

describe("CloudflareAccessVerifier", () => {
  test("accepts a signed token for the configured audience, issuer and email", async () => {
    const calls: string[] = [];
    const verifier = new CloudflareAccessVerifier(ACCESS, certs(calls), () => NOW);
    expect(await verifier.verify(withToken(await jwt({ email: "Owner@Example.com" })))).toBe("owner@example.com");
    expect(calls).toEqual(["https://team.cloudflareaccess.com/cdn-cgi/access/certs"]);
  });

  test("refuses missing, foreign, expired, early and tampered tokens", async () => {
    const verifier = new CloudflareAccessVerifier(ACCESS, certs([]), () => NOW);
    expect(await verifier.verify(new Request("https://ghost.example.com/"))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({ email: "someone@example.com" })))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({ aud: ["another-app"] })))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({ iss: "https://evil.cloudflareaccess.com" })))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({ exp: NOW / 1000 - 120 })))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({ nbf: NOW / 1000 + 120 })))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({}, { key: other.privateKey })))).toBeNull();
    expect(await verifier.verify(withToken(await jwt({}, { alg: "none" })))).toBeNull();
    const [header, , signature] = (await jwt()).split(".");
    expect(await verifier.verify(withToken(`${header}.${part({ aud: [ACCESS.audience], iss: `https://${ACCESS.teamDomain}`, email: "owner@example.com", exp: NOW / 1000 + 3600 })}.${signature}`))).toBeNull();
  });

  test("a rotated key is fetched on its first use, unknown kids at most every 30 s", async () => {
    const calls: string[] = [];
    let now = NOW;
    let keys: unknown[] = [{ ...publicJwk, kid: "k1" }];
    const verifier = new CloudflareAccessVerifier(ACCESS, certs(calls, () => keys), () => now);
    expect(await verifier.verify(withToken(await jwt()))).toBe("owner@example.com");
    keys = [{ ...publicJwk, kid: "k1" }, { ...publicJwk, kid: "k2" }];
    expect(await verifier.verify(withToken(await jwt({}, { kid: "k2" })))).toBeNull();
    expect(calls).toHaveLength(1);
    now += 31_000;
    expect(await verifier.verify(withToken(await jwt({ exp: now / 1000 + 3600 }, { kid: "k2" })))).toBe("owner@example.com");
    expect(await verifier.verify(withToken(await jwt({ exp: now / 1000 + 3600 }, { kid: "forged" })))).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("config parsing rejects anything but an exact HTTPS origin and real claims", () => {
    expect(parseCloudflareAccess({ ...ACCESS, emails: ["Owner@Example.com"] }).emails).toEqual(["owner@example.com"]);
    for (const bad of [
      { ...ACCESS, origin: "http://ghost.example.com" },
      { ...ACCESS, origin: "https://ghost.example.com/" },
      { ...ACCESS, audience: "" },
      { ...ACCESS, emails: [] },
      { ...ACCESS, teamDomain: "https://team.cloudflareaccess.com" },
      { ...ACCESS, extra: true },
    ]) expect(() => parseCloudflareAccess(bad)).toThrow("cloudflareAccess");
  });
});

describe("Access web origin", () => {
  const root = mkdtempSync(join(tmpdir(), "ghost-edge-"));
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
    root, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", cloudflareAccess: ACCESS, uiDir,
    sandbox: { kind: "local" }, voice: null, apns: null, skills: null, reach: null, browser: null,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => String(input).startsWith(`https://${ACCESS.teamDomain}/`)
    ? Response.json({ keys: [{ ...publicJwk, kid: "k1" }] })
    : realFetch(input, init)) as typeof fetch;
  const server = startServer({ core, config, ownerToken: "owner-test-token", documents: null, skills: null });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  /** fetch forbids overriding Host; the tunnel connects from loopback with the public Host. */
  const raw = (path: string, headers: Record<string, string>) => {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const outgoing = httpRequest({ host: "127.0.0.1", port: server.port, path, headers: { host: "ghost.example.com", ...headers } }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
    return promise;
  };

  test("nothing, UI and unauthenticated routes included, answers without an Access session", async () => {
    for (const path of ["/", "/api/health", "/api/state"]) expect((await raw(path, {})).status).toBe(401);
    expect((await raw("/api/state", { authorization: "Bearer owner-test-token" })).status).toBe(401);
    const stranger = await jwt({ email: "someone@example.com", exp: Date.now() / 1000 + 3600, nbf: Date.now() / 1000 - 10 });
    expect((await raw("/api/state", { "cf-access-jwt-assertion": stranger })).status).toBe(401);
  });

  test("a verified Access session is the owner and never gets the owner token injected", async () => {
    const token = await jwt({ exp: Date.now() / 1000 + 3600, nbf: Date.now() / 1000 - 10 });
    const state = await raw("/api/state", { "cf-access-jwt-assertion": token });
    expect(state.status).toBe(200);
    expect(JSON.parse(state.body).principal).toEqual({ kind: "owner" });
    const page = await raw("/", { "cf-access-jwt-assertion": token });
    expect(page.status).toBe(200);
    expect(page.body).not.toContain("owner-test-token");
  });
});
