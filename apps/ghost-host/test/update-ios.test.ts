import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateFixture, type FixtureOptions, type UpdateFixture } from "./fixtures/update-helper.ts";
import { Core } from "../src/core/core.ts";
import { hashSecret } from "../src/core/commands.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FsArtifactStore } from "../src/stores/artifacts.ts";
import { FileSecrets } from "../src/stores/secrets.ts";
import { startServer } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";
import { Updater } from "../src/update/index.ts";
import { MAX_ASSET_BYTES, parseManifest, type ReleaseManifest } from "../src/update/github.ts";
import { escapeXml, iosPlist, type IosInstall } from "../src/update/ios.ts";

const publicOrigin = "https://ghost.example";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(options: FixtureOptions = {}) {
  const f = await updateFixture({ ios: true, publicOrigin, ...options });
  const ledger = new Ledger(":memory:");
  const core = new Core({ ledger, artifacts: new FsArtifactStore(f.root), sandbox: { status: (ghostId) => ({ ghostId, state: "none", detail: "" }), control: async () => {} }, secrets: new FileSecrets(f.root), log: () => {} });
  ledger.tx(() => ledger.insertDevice({ id: "ios-test-device", name: "iPhone", pushEnabled: false, alerts: { mutedKinds: [], mutedGhostIds: [] }, createdAt: Date.now(), lastSeenAt: null }, hashSecret("device-token")));
  const servers: { stop(): Promise<void> }[] = [];
  const updaters: Updater[] = [f.updater];
  function serve(updater = f.updater) {
    const server = startServer({ core, config: { ...loadConfig({}, f.root), publicOrigin, host: "127.0.0.1", port: 0 }, ownerToken: "owner-token", documents: null, skills: null, updater });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const request = (path: string, method = "GET", bearer?: string) => fetch(`${origin}${path}`, { method, ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) });
    return { request };
  }
  cleanups.push(async () => {
    await Promise.all(updaters.map((updater) => updater.close()));
    await Promise.all(servers.map((server) => server.stop()));
    core.stop(); ledger.close(); rmSync(f.temp, { recursive: true, force: true });
  });
  return { f, ...serve(), serve, updaters };
}

const manifest: ReleaseManifest = {
  format: "ghost-release/1", version: "2.2.0", commit: "new123", notes: "", publishedAt: "2026-11-10T12:00:00Z", storage: "test-storage",
  host: { asset: "ghost.tar.gz", sha256: "a".repeat(64), bytes: 10 },
  shell: { version: "0.3.0", asset: "Ghost.app.tar.gz", signature: "signature", notes: "" },
};
const ios: NonNullable<ReleaseManifest["ios"]> = { version: "0.1.0", build: 9, bundleId: "io.a7garden.ghost", asset: "Ghost.ipa", sha256: "b".repeat(64), bytes: 9, notes: "iPhone 앱 업데이트" };
const parse = (value: unknown) => parseManifest(Buffer.from(JSON.stringify(value)));
const tokenPath = (link: { page: string }, name: string) => `/api/update/ios/${name}${new URL(link.page).search}`;
const cacheFiles = (f: UpdateFixture) => { const path = join(f.root, "update", "cache"); return existsSync(path) ? readdirSync(path) : []; };

test("release manifest accepts old releases and strictly validates optional iOS metadata", () => {
  expect(parse(manifest).ios).toBeUndefined();
  expect(parse({ ...manifest, ios }).ios).toEqual(ios);
  expect(parse({ ...manifest, ios: { ...ios, sha256: ios.sha256.toUpperCase() } }).ios?.sha256).toBe(ios.sha256.toUpperCase());
  for (const value of [null, false, [], "ios", {},
    ...Object.entries({ version: [null, 1, "1.0", "1.0.0<script>"], build: [0, -1, 1.5, "9", Number.MAX_SAFE_INTEGER + 1], bundleId: [null, "ghost", "io..ghost", "io.ghost/app", "io.ghost_", "-io.ghost", "io.ghost-"], asset: ["Other.ipa", "../Ghost.ipa"], sha256: [null, "x".repeat(64), "a".repeat(63)], bytes: [0, -1, 1.5, MAX_ASSET_BYTES + 1, "9"], notes: [null, 1] }).flatMap(([field, values]) => values.map((value) => ({ ...ios, [field]: value }))),
    ...Object.keys(ios).map((field) => Object.fromEntries(Object.entries(ios).filter(([key]) => key !== field))),
  ]) expect(() => parse({ ...manifest, ios: value })).toThrow();
});

test("status exposes only verified iOS metadata, including cached state and old releases", async () => {
  const { f, updaters } = await setup();
  expect(f.updater.status().ios).toBeNull();
  expect((await f.updater.check()).ios).toEqual({ version: ios.version, build: ios.build, notes: ios.notes });
  const restarted = new Updater(f.updaterOptions); updaters.push(restarted);
  expect(restarted.status().ios).toEqual(f.updater.status().ios);
  delete f.manifest.ios;
  expect((await f.updater.check()).ios).toBeNull();
});

test("link returns 503 without a verified iOS release, HTTPS public origin, credentials, or enabled updater", async () => {
  const { f, request, serve, updaters } = await setup();
  expect((await request("/api/update/ios/link", "POST", "owner-token")).status).toBe(503);
  await f.updater.check();
  for (const origin of [undefined, null, "", "http://ghost.example", "not a url", "https://user:secret@ghost.example", "https://ghost.example/path", "https://ghost.example/?query=1"]) {
    const updater = new Updater({ ...f.updaterOptions, publicOrigin: origin }); updaters.push(updater);
    expect((await serve(updater).request("/api/update/ios/link", "POST", "owner-token")).status).toBe(503);
  }
  for (const overrides of [{ repository: null }, { env: {} }]) {
    const updater = new Updater({ ...f.updaterOptions, ...overrides }); updaters.push(updater);
    expect(updater.status().ios).not.toBeNull();
    expect((await serve(updater).request("/api/update/ios/link", "POST", "owner-token")).status).toBe(503);
  }
  f.updater.settings({ token: null });
  expect((await request("/api/update/ios/link", "POST", "owner-token")).status).toBe(503);
  f.updater.settings({ token: "test-token" });
  delete f.manifest.ios; await f.updater.check();
  expect((await request("/api/update/ios/link", "POST", "owner-token")).status).toBe(503);
});

test("owner and device mint shared-token OTA links; only token routes bypass bearer auth", async () => {
  const { f, request } = await setup();
  await f.updater.check();
  for (const path of ["/api/update", "/api/update/ios/link", "/api/update/check", "/api/update/settings", "/api/update/shell/latest.json", "/api/update/ios/unknown"]) {
    expect((await request(path, path.endsWith("link") || path.endsWith("check") ? "POST" : "GET")).status).toBe(401);
  }
  for (const bearer of ["owner-token", "device-token"]) {
    const response = await request("/api/update/ios/link", "POST", bearer);
    expect(response.status).toBe(200);
    const link = await response.json();
    const pageUrl = new URL(link.page), install = new URL(link.install);
    expect(pageUrl.origin).toBe(publicOrigin);
    expect(pageUrl.pathname).toBe("/api/update/ios/install");
    expect(pageUrl.searchParams.get("t")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(install.protocol).toBe("itms-services:");
    expect(install.searchParams.get("action")).toBe("download-manifest");
    expect(install.searchParams.get("url")).toBe(`${publicOrigin}${tokenPath(link, "manifest.plist")}`);
    const page = await request(tokenPath(link, "install"));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("Ghost 앱 0.1.0 (9)"); expect(html).toContain(">설치</a>");
    expect(html).toContain(escapeXml(link.install)); expect(html).not.toContain("<script");
    const plist = await request(tokenPath(link, "manifest.plist"));
    expect(plist.status).toBe(200); expect(plist.headers.get("content-type")).toBe("application/xml");
    const xml = await plist.text();
    expect(xml).toContain(`<string>${publicOrigin}${tokenPath(link, "Ghost.ipa")}</string>`);
    expect(xml).toContain("<key>bundle-identifier</key><string>io.a7garden.ghost</string>");
    expect(xml).toContain("<key>bundle-version</key><string>0.1.0</string>");
    expect(xml).toContain("<string>software-package</string>");
    const ipa = await request(tokenPath(link, "Ghost.ipa"));
    expect(ipa.status).toBe(200); expect(ipa.headers.get("content-type")).toBe("application/octet-stream"); expect(await ipa.text()).toBe("ios-asset");
  }
});

test("plist XML escapes every dynamic value", () => {
  const dangerous = `a&<>"'`;
  const entry: IosInstall = { token: dangerous, origin: `https://${dangerous}`, manifest: { ...manifest, ios: { ...ios, bundleId: dangerous, version: dangerous } }, expiresAt: 1 };
  const xml = iosPlist(entry);
  expect(xml).toContain(`<key>bundle-identifier</key><string>${escapeXml(dangerous)}</string>`);
  expect(xml).toContain(`<key>bundle-version</key><string>${escapeXml(dangerous)}</string>`);
  expect(xml).toContain(`https://${escapeXml(dangerous)}/api/update/ios/Ghost.ipa?t=${escapeXml(encodeURIComponent(dangerous))}`);
});

test("expired, evicted, unknown and absent tokens return detail-free 404 on every token route", async () => {
  let now = 1_000;
  const { f, request } = await setup({ now: () => now }); await f.updater.check();
  const first = f.updater.iosLink();
  for (let i = 0; i < 16; i++) f.updater.iosLink();
  const active = f.updater.iosLink();
  for (const name of ["install", "manifest.plist", "Ghost.ipa"]) {
    for (const path of [tokenPath(first, name), `/api/update/ios/${name}`, `/api/update/ios/${name}?t=${"x".repeat(43)}`, `/api/update/ios/${name}?t=short`]) {
      const response = await request(path); expect(response.status).toBe(404); expect(await response.text()).toBe("");
    }
    expect((await request(tokenPath(active, name), "POST")).status).toBe(404);
  }
  now += 15 * 60_000;
  for (const name of ["install", "manifest.plist", "Ghost.ipa"]) {
    const response = await request(tokenPath(active, name)); expect(response.status).toBe(404); expect(await response.text()).toBe("");
  }
});

test("IPA cache is populated only after hash and size verification and is checked before reuse", async () => {
  const { f, request } = await setup();
  f.manifest.ios!.sha256 = f.manifest.ios!.sha256.toUpperCase();
  await f.updater.check();
  const link = f.updater.iosLink(), path = tokenPath(link, "Ghost.ipa");
  f.setIpa(Buffer.from("bad-asset"));
  expect((await request(path)).status).toBe(500); expect(cacheFiles(f)).toEqual([]);
  f.setIpa(Buffer.from("short"));
  expect((await request(path)).status).toBe(500); expect(cacheFiles(f)).toEqual([]);
  f.setIpa(Buffer.from("larger-than-manifest"));
  expect((await request(path)).status).toBe(500); expect(cacheFiles(f)).toEqual([]);
  f.setIpa(Buffer.from("ios-asset"));
  const responses = await Promise.all([request(path), request(path)]);
  for (const response of responses) { expect(response.status).toBe(200); expect(await response.text()).toBe("ios-asset"); }
  expect(cacheFiles(f)).toHaveLength(1);
  const cached = join(f.root, "update", "cache", cacheFiles(f)[0]!);
  expect(readFileSync(cached, "utf8")).toBe("ios-asset");
  const calls = f.calls.length;
  expect(await (await request(path)).text()).toBe("ios-asset"); expect(f.calls.length).toBe(calls);
  writeFileSync(cached, "bad-asset"); f.setIpa(Buffer.from("bad-asset"));
  expect((await request(path)).status).toBe(500); expect(cacheFiles(f)).toEqual([]);
});

test("token routes retain the host-header guard", async () => {
  const { f, request } = await setup(); await f.updater.check();
  const link = f.updater.iosLink();
  // Directly exercising the guard requires a Host header different from the request URL.
  const target = new URL((await request("/api/health")).url);
  target.pathname = "/api/update/ios/install"; target.search = new URL(link.page).search;
  expect((await fetch(target, { headers: { host: "untrusted.example" } })).status).toBe(403);
});
