import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { Ledger } from "../../src/ledger/ledger.ts";
import { sha256 } from "../../src/update/archive.ts";
import { Updater, type UpdaterOptions } from "../../src/update/index.ts";
import { HOST_BUNDLE, HOST_EXECUTABLE } from "../../src/update/storage.ts";
import type { ReleaseManifest, UpdateFetch } from "../../src/update/github.ts";
import { backup } from "../../src/backup.ts";

export interface TestSigningKey { pubkey: string; sign(data: Uint8Array, prehash?: boolean): string }
export function signingKey(): TestSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const id = randomBytes(8);
  const pk = Buffer.concat([Buffer.from("Ed"), id, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]);
  const pubkey = Buffer.from(`untrusted comment: test key\n${pk.toString("base64")}\n`).toString("base64");
  return { pubkey, sign(data: Uint8Array, prehash = true) {
    const raw = sign(null, prehash ? new Bun.CryptoHasher("blake2b512").update(data).digest() : data, privateKey);
    const trusted = "timestamp:1794312000";
    return Buffer.from(`untrusted comment: test signature\n${Buffer.concat([Buffer.from(prehash ? "ED" : "Ed"), id, raw]).toString("base64")}\ntrusted comment: ${trusted}\n${sign(null, Buffer.concat([raw, Buffer.from(trusted)]), privateKey).toString("base64")}\n`).toString("base64");
  } };
}

export interface FixtureOptions {
  storage?: string;
  version?: string;
  preflightVersion?: string;
  unlisted?: boolean;
  releaseMismatch?: boolean;
  idle?: UpdaterOptions["idle"];
  backup?: UpdaterOptions["backup"];
  ios?: boolean;
  publicOrigin?: string | null;
  now?: UpdaterOptions["now"];
}

export interface UpdateFixture {
  temp: string; root: string; base: string; old: string; oldName: string;
  manifest: ReleaseManifest; key: TestSigningKey;
  calls: { url: string; init?: RequestInit }[];
  updater: Updater; updaterOptions: UpdaterOptions; readonly shutdowns: number;
  setFailure(value: boolean): void; setTarball(value: Buffer<ArrayBuffer>): void; setIpa(value: Buffer<ArrayBuffer>): void;
  tarball: Buffer<ArrayBuffer>;
}

export async function updateFixture(options: FixtureOptions = {}): Promise<UpdateFixture> {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "ghost-update-")));
  const root = join(temp, "state"), base = join(temp, "base");
  const oldName = "2.1.0-old", old = join(base, "releases", oldName);
  mkdirSync(dirname(join(old, HOST_EXECUTABLE)), { recursive: true });
  writeFileSync(join(old, "ghost"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(old, HOST_EXECUTABLE), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  symlinkSync(`releases/${oldName}`, join(base, "current"));
  mkdirSync(root, { recursive: true });
  const ledger = new Ledger(join(root, "ledger.db")); ledger.close();
  const pi = new Database(join(root, "pi.db")); pi.exec("CREATE TABLE test (id INTEGER)"); pi.close();
  const stage = join(temp, "source");
  mkdirSync(join(stage, "ui"), { recursive: true });
  mkdirSync(dirname(join(stage, HOST_EXECUTABLE)), { recursive: true });
  const version = options.version ?? "2.2.0", commit = "new123", storage = options.storage ?? "test-storage";
  const files: Record<string, string> = {};
  const write = (name: string, content: string, executable = false) => {
    writeFileSync(join(stage, name), content, { mode: executable ? 0o755 : 0o644 });
    files[name] = sha256(Buffer.from(content));
  };
  write("ghost", `#!/bin/sh\nif [ "$1" = version ]; then\nprintf '%s\\n' '${JSON.stringify({ version: options.preflightVersion ?? version, commit, storage })}'\nelse\nexit 1\nfi\n`, true);
  write(HOST_EXECUTABLE, "#!/bin/sh\nexit 1\n", true);
  write("ui/index.html", "<!doctype html>Ghost");
  write("agent-browser", "browser", true);
  write("obscura", "obscura", true);
  write("OBSCURA-LICENSE", "license");
  writeFileSync(join(stage, "release.json"), JSON.stringify({ format: "ghost-release-files/1", version: options.releaseMismatch ? "0.0.0" : version, commit, storage, files }));
  if (options.unlisted) writeFileSync(join(stage, "unlisted"), "not in manifest");
  const archive = join(temp, "release.tar.gz");
  const tar = Bun.spawn(["/usr/bin/tar", "--format", "ustar", "--no-mac-metadata", "--no-xattrs", "-czf", archive, "-C", stage, "ghost", HOST_BUNDLE, "ui", "agent-browser", "obscura", "OBSCURA-LICENSE", "release.json", ...(options.unlisted ? ["unlisted"] : [])], { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  let tarball = readFileSync(archive);
  const key = signingKey();
  const manifest: ReleaseManifest = { format: "ghost-release/1", version, commit, notes: "새 업데이트", publishedAt: "2026-11-10T12:00:00Z", storage,
    host: { asset: `ghost-${version}-darwin-arm64.tar.gz`, sha256: sha256(tarball), bytes: tarball.length },
    shell: { version: "0.3.0", asset: "Ghost.app.tar.gz", signature: "shell-signature", notes: "앱 업데이트" } };
  let ipa = Buffer.from("ios-asset");
  if (options.ios) manifest.ios = { version: "0.1.0", build: 9, bundleId: "io.a7garden.ghost", asset: "Ghost.ipa", sha256: sha256(ipa), bytes: ipa.length, notes: "iPhone 앱 업데이트" };
  const calls: { url: string; init?: RequestInit }[] = [];
  let fail = false;
  const names = ["ghost-release.json", "ghost-release.json.sig", manifest.host.asset, "Ghost.app.tar.gz", "Ghost.ipa"];
  const fetcher: UpdateFetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (fail) return new Response("error", { status: 503 });
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const bodies = [manifestBytes, Buffer.from(key.sign(manifestBytes)), tarball, Buffer.from("shell-asset"), ipa];
    if (url.includes("/releases/latest") || url.includes("/releases/tags/")) return Response.json({ tag_name: `v${manifest.version}`, assets: names.map((name, id) => ({ name, size: bodies[id]!.length, url: `https://api.github.com/repos/test/ghost/releases/assets/${id}` })) });
    const apiMatch = /\/releases\/assets\/(\d+)$/.exec(url);
    if (apiMatch) return new Response(null, { status: 302, headers: { location: `https://release-assets.example/${apiMatch[1]}` } });
    const asset = /^https:\/\/release-assets.example\/(\d+)$/.exec(url);
    if (asset) return new Response(bodies[Number(asset[1])]!);
    throw new Error(`unexpected fetch ${url}`);
  };
  let shutdowns = 0;
  const updaterOptions: UpdaterOptions = { root, publicOrigin: options.publicOrigin, now: options.now, repository: "test/ghost", pubkey: key.pubkey, identity: { version: "2.1.0", commit: "old", storage: "test-storage" }, execPath: join(old, HOST_EXECUTABLE), fetch: fetcher, idle: options.idle ?? (() => true), shutdown: () => { shutdowns++; }, pollMs: 5, backup: options.backup ?? backup, env: { GHOST_SERVICE: "launchd" } };
  const updater = new Updater(updaterOptions);
  updater.settings({ token: "test-token", autoCheck: false });
  return { temp, root, base, old, oldName, manifest, key, calls, updater, updaterOptions, get shutdowns() { return shutdowns; }, setFailure(value: boolean) { fail = value; }, setTarball(value: Buffer<ArrayBuffer>) { tarball = value; }, setIpa(value: Buffer<ArrayBuffer>) { ipa = value; }, tarball };
}
