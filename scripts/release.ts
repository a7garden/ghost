// Builds a Ghost release on this Mac and, with --publish, tags it and uploads it
// as a GitHub Release. Installed Hosts see it on their next check and offer it
// to the owner; nothing installs without the owner pressing 「설치」.
//
//   bun scripts/release.ts            build + verify into dist/release/<version>/
//   bun scripts/release.ts --publish  also tag v<version> and create the Release
//
// Needs: the Developer ID Application identity in the login keychain (or
// GHOST_SIGNING_IDENTITY), the updater key ~/.tauri/ghost.key (or
// GHOST_UPDATER_KEY), Xcode signed in to the same team (the iPhone IPA uses its
// automatic development profile), and `gh` logged in for --publish.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
// The same checks an installed Host runs before it installs a release.
import { validateTarball, verifyReleaseDirectory } from "../apps/ghost-host/src/update/archive.ts";
import { HOST_BUNDLE, HOST_EXECUTABLE } from "../apps/ghost-host/src/update/storage.ts";
import { parseManifest } from "../apps/ghost-host/src/update/github.ts";
import { verifyMinisign } from "../apps/ghost-host/src/update/signature.ts";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const publish = process.argv.includes("--publish");
// CI builds the macOS release only: the iPhone IPA is uploaded to TestFlight by
// a separate job, so the release script skips the Xcode archive and export when
// GHOST_SKIP_IOS=1 is set. Unset means the local behaviour is unchanged.
const skipIos = process.env.GHOST_SKIP_IOS === "1";
// CI starts from the pushed tag, so there the tag must already exist and name
// this commit; locally the tag must not exist yet (gh release creates it).
const tagPushed = process.env.GHOST_RELEASE_TAG_PUSHED === "1";


function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; capture?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})`);
  return options.capture ? result.stdout.trim() : "";
}

const step = (title: string) => console.log(`\n▸ ${title}`);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`release payload must not contain symlinks: ${path}`);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function signingIdentity(): string {
  if (process.env.GHOST_SIGNING_IDENTITY) return process.env.GHOST_SIGNING_IDENTITY;
  const found = run("security", ["find-identity", "-v", "-p", "codesigning"], { capture: true })
    .split("\n")
    .map(line => /"(Developer ID Application: [^"]+)"/.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));
  if (found.length !== 1) throw new Error(`expected exactly one Developer ID Application identity, found ${found.length}; set GHOST_SIGNING_IDENTITY`);
  return found[0]!;
}

/** The GitHub repository releases go to, and the local remote that points at it. */
function githubRemote(): { repository: string; remote: string } {
  const wanted = process.env.GHOST_RELEASE_REPOSITORY;
  const remotes = run("git", ["remote"], { capture: true }).split("\n").filter(Boolean);
  for (const remote of remotes) {
    const url = run("git", ["remote", "get-url", remote], { capture: true });
    const repository = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url)?.[1];
    if (repository && (!wanted || repository === wanted)) return { repository, remote };
  }
  throw new Error(wanted ? `no git remote points at ${wanted}` : "no GitHub remote");
}

/** Numeric x.y.z comparison; pre-release suffixes are not used for Ghost releases. */
function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!parts) throw new Error(`not a release version: ${value}`);
    return parts.slice(1).map(Number);
  };
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index]! - y[index]!;
  return 0;
}

// ── Identity ────────────────────────────────────────────────────────────────
const version: string = readJson("apps/ghost-host/package.json").version;
const shellVersion: string = readJson("apps/ghost-desktop/src-tauri/tauri.conf.json").version;
const fullCommit = run("git", ["rev-parse", "HEAD"], { capture: true });
const commit = fullCommit.slice(0, 7);
const tag = `v${version}`;
const { repository, remote } = githubRemote();
const keyPath = process.env.GHOST_UPDATER_KEY ?? join(homedir(), ".tauri/ghost.key");
const pubkey = readFileSync(`${keyPath}.pub`, "utf8").trim();
const configuredPubkey: string = readJson("apps/ghost-desktop/src-tauri/tauri.conf.json").plugins.updater.pubkey;
if (configuredPubkey !== pubkey) throw new Error(`${keyPath}.pub does not match tauri.conf.json plugins.updater.pubkey`);
const identity = signingIdentity();
const signerEnv = { TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.GHOST_UPDATER_KEY_PASSWORD ?? "" };
const tauri = join(repoRoot, "apps/ghost-desktop/node_modules/.bin/tauri");

console.log(`Ghost ${version} (${commit}) · shell ${shellVersion} · ${repository}`);

run("git", ["fetch", "--quiet", "--tags", remote]);
const latest = spawnSync("gh", ["release", "view", "--repo", repository, "--json", "tagName", "-q", ".tagName"], { cwd: repoRoot, encoding: "utf8" });
const previousTag = latest.status === 0 ? latest.stdout.trim() : null;
if (previousTag && compareVersions(version, previousTag) <= 0) throw new Error(`${version} is not newer than the latest release ${previousTag}; bump apps/ghost-host/package.json`);
if (publish) {
  if (run("git", ["status", "--porcelain"], { capture: true })) throw new Error("--publish needs a clean working tree");
  const remoteTag = run("git", ["ls-remote", "--tags", remote, `refs/tags/${tag}^{}`, `refs/tags/${tag}`], { capture: true });
  if (tagPushed) {
    // An annotated tag lists its peeled commit (^{}) too; either line naming this commit is enough.
    if (!remoteTag.split("\n").some(line => line.startsWith(fullCommit))) throw new Error(`tag ${tag} on ${remote} does not name ${commit}`);
  } else if (remoteTag) throw new Error(`tag ${tag} already exists on ${remote}`);
  // The Release tags this exact commit on GitHub, so GitHub must already have it.
  if (!run("git", ["branch", "-r", "--contains", fullCommit], { capture: true }).split("\n").some(line => line.trim().startsWith(`${remote}/`))) {
    throw new Error(`push ${commit} to ${remote} before publishing`);
  }
}

const out = join(repoRoot, "dist/release", version);
const stage = join(out, "payload");
rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ── Checks ─────────────────────────────────────────────────────────────────
step("checks");
run("bun", ["run", "typecheck"]);
run("bun", ["run", "test"]);
run("bun", ["run", "typecheck"], { cwd: join(repoRoot, "apps/ghost-ui") });
run("bun", ["run", "test"], { cwd: join(repoRoot, "apps/ghost-ui") });
run("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], { cwd: join(repoRoot, "apps/ghost-desktop") });

// ── Host payload ───────────────────────────────────────────────────────────
step("host");
// macOS privacy remembers this bundle by identifier and team, so the owner's grants survive updates.
const hostBundle = join(stage, HOST_BUNDLE);
const hostBinary = join(stage, HOST_EXECUTABLE);
for (const directory of ["Contents/MacOS", "Contents/Resources"]) mkdirSync(join(hostBundle, directory), { recursive: true });
run("bun", [
  "build", "apps/ghost-host/src/main.ts", "--compile", "--outfile", hostBinary,
  "--define", `GHOST_RELEASE_REPOSITORY=${JSON.stringify(repository)}`,
  "--define", `GHOST_RELEASE_COMMIT=${JSON.stringify(commit)}`,
  "--define", `GHOST_RELEASE_PUBKEY=${JSON.stringify(pubkey)}`,
]);
chmodSync(hostBinary, 0o755);
cpSync(join(repoRoot, "apps/ghost-desktop/src-tauri/icons/icon.icns"), join(hostBundle, "Contents/Resources/Ghost.icns"));
writeFileSync(join(hostBundle, "Contents/Info.plist"), plist([
  "<key>CFBundleIdentifier</key><string>dev.projectoxi.ghost.host</string>",
  "<key>CFBundleName</key><string>Ghost Host</string>",
  "<key>CFBundleDisplayName</key><string>Ghost Host</string>",
  "<key>CFBundleExecutable</key><string>ghost</string>",
  "<key>CFBundleIconFile</key><string>Ghost</string>",
  "<key>CFBundlePackageType</key><string>APPL</string>",
  `<key>CFBundleShortVersionString</key><string>${version}</string>`,
  `<key>CFBundleVersion</key><string>${version}</string>`,
  "<key>LSMinimumSystemVersion</key><string>14.0</string>",
  "<key>LSUIElement</key><true/>",
].join("")));
run("codesign", ["--force", "--sign", identity, "--timestamp", hostBundle]);
run("codesign", ["--verify", "--strict", hostBundle]);
// Launchers, the CLI link and installed updaters run `releases/<name>/ghost`; it execs the bundle executable.
const host = join(stage, "ghost");
writeFileSync(host, `#!/bin/sh\nexec "$(dirname "$(/usr/bin/readlink -f "$0")")/${HOST_EXECUTABLE}" "$@"\n`, { mode: 0o755 });
// Build probes must not read the installed Host's configuration or credentials.
const reported = JSON.parse(run(host, ["version"], { capture: true, env: { GHOST_ROOT: join(out, "version-check") } })) as { version: string; commit: string; storage: string };
if (reported.version !== version || reported.commit !== commit) throw new Error(`built host reports ${reported.version}/${reported.commit}`);

step("ui");
run("bun", ["run", "build"], { cwd: join(repoRoot, "apps/ghost-ui") });
cpSync(join(repoRoot, "apps/ghost-ui/dist"), join(stage, "ui"), { recursive: true });

step("agent-browser 0.41.2 + connected-target/focus patch");
const browser = join(stage, "agent-browser");
run("bash", ["apps/ghost-host/scripts/stage-agent-browser.sh", stage]);
run("codesign", ["--force", "--sign", identity, "--timestamp", "--identifier", "dev.projectoxi.ghost.agent-browser", browser]);
run("codesign", ["--verify", "--strict", browser]);

step("obscura");
run("sh", ["apps/ghost-host/scripts/stage-obscura.sh", stage]);

step("pc control");
run("bash", ["apps/ghost-host/scripts/stage-desktop.sh", stage, version, identity]);
run("codesign", ["--verify", "--strict", join(stage, "Ghost Control.app")]);

const files: Record<string, string> = {};
for (const path of filesUnder(stage).sort()) files[relative(stage, path)] = sha256(path);
writeFileSync(
  join(stage, "release.json"),
  `${JSON.stringify({ format: "ghost-release-files/1", version, commit, storage: reported.storage, files }, null, 2)}\n`,
);

const hostAsset = `ghost-${version}-darwin-arm64.tar.gz`;
const hostArchive = join(out, hostAsset);
// ustar with explicit top-level names: no pax/xattr records and no "./" root entry,
// which the Host's archive check refuses.
const payloadNames = ["ghost", HOST_BUNDLE, "ui", "agent-browser", "obscura", "OBSCURA-LICENSE", "Ghost Control.app", "agent-desktop", "agent-desktop-macos-helper", "AGENT-DESKTOP-LICENSE", "geist", "release.json"];
const extra = readdirSync(stage).filter(name => !payloadNames.includes(name));
if (extra.length > 0) throw new Error(`unexpected payload entries: ${extra.join(", ")}`);
run("tar", ["--format", "ustar", "--no-mac-metadata", "--no-xattrs", "-czf", hostArchive, "-C", stage, ...payloadNames], { env: { COPYFILE_DISABLE: "1" } });

// ── Shell ──────────────────────────────────────────────────────────────────
step(`shell ${shellVersion}`);
const desktop = join(repoRoot, "apps/ghost-desktop");
run(tauri, ["build", "--bundles", "app"], { cwd: desktop, env: { ...signerEnv, APPLE_SIGNING_IDENTITY: identity } });
const bundle = join(desktop, "src-tauri/target/release/bundle/macos");
cpSync(join(bundle, "Ghost.app.tar.gz"), join(out, "Ghost.app.tar.gz"));
cpSync(join(bundle, "Ghost.app.tar.gz.sig"), join(out, "Ghost.app.tar.gz.sig"));
run("codesign", ["--verify", "--deep", "--strict", join(bundle, "Ghost.app")]);

// ── iPhone app ─────────────────────────────────────────────────────────────
// Development-signed so it installs over the air on the team's registered devices.
// The archive signs with the project's App/Ghost.entitlements, so the paid team's
// automatic development profile must carry the Push Notifications capability.
const ipa = join(out, "Ghost.ipa");
const ios = { version: "", build: 0, bundleId: "" };
if (!skipIos) {
  step("ios");
  const teamId = /\(([A-Z0-9]{10})\)$/.exec(identity)?.[1];
  if (!teamId) throw new Error(`no team ID in signing identity ${identity}`);
  const iosWork = join(out, "ios");
  mkdirSync(iosWork, { recursive: true });
  writeFileSync(join(iosWork, "export.plist"), plist(`<key>method</key><string>debugging</string><key>teamID</key><string>${teamId}</string><key>signingStyle</key><string>automatic</string><key>thinning</key><string>&lt;none&gt;</string>`));
  const iosArchive = join(iosWork, "Ghost.xcarchive");
  run("xcodebuild", [
    "-quiet", "-project", "apps/ghost-ios/Ghost.xcodeproj", "-scheme", "Ghost", "-configuration", "Release",
    "-destination", "generic/platform=iOS", "-archivePath", iosArchive, "-derivedDataPath", join(iosWork, "DerivedData"),
    `DEVELOPMENT_TEAM=${teamId}`, "-allowProvisioningUpdates", "archive",
  ]);
  run("xcodebuild", ["-quiet", "-exportArchive", "-archivePath", iosArchive, "-exportOptionsPlist", join(iosWork, "export.plist"), "-exportPath", iosWork, "-allowProvisioningUpdates"]);
  cpSync(join(iosWork, "Ghost.ipa"), ipa);
  // Read identity and signature from the exported IPA itself: export re-signs the archive.
  run("/usr/bin/ditto", ["-x", "-k", ipa, join(iosWork, "ipa")]);
  const iosApp = join(iosWork, "ipa/Payload/Ghost.app");
  const infoValue = (key: string) => run("plutil", ["-extract", key, "raw", join(iosApp, "Info.plist")], { capture: true });
  ios.version = infoValue("CFBundleShortVersionString");
  ios.build = Number(infoValue("CFBundleVersion"));
  ios.bundleId = infoValue("CFBundleIdentifier");
  if (!Number.isSafeInteger(ios.build) || ios.build < 1) throw new Error(`iPhone build number is not an integer: ${infoValue("CFBundleVersion")}`);
  run("codesign", ["--verify", "--deep", "--strict", iosApp]);
  // Export re-signs the archive, so read the push entitlement back out of the IPA
  // itself: the codesigned entitlements and the embedded profile must both grant
  // aps-environment=development, or sandbox pushes would never reach the app.
  const entitlementValue = (label: string, path: string, key: string) => {
    const found = spawnSync("plutil", ["-extract", key, "raw", path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (found.status !== 0) throw new Error(`${label} carries no aps-environment; the debugging export needs development`);
    return found.stdout.trim();
  };
  const signedEntitlements = join(iosWork, "signed-entitlements.plist");
  writeFileSync(signedEntitlements, run("codesign", ["--display", "--entitlements", ":-", iosApp], { capture: true }));
  const signedAps = entitlementValue("the exported IPA's codesigned entitlements", signedEntitlements, "aps-environment");
  if (signedAps !== "development") throw new Error(`the exported IPA is codesigned with aps-environment=${signedAps}, not development; the signing profile must carry Push Notifications`);
  const profilePlist = join(iosWork, "profile.plist");
  writeFileSync(profilePlist, run("security", ["cms", "-D", "-i", join(iosApp, "embedded.mobileprovision")], { capture: true }));
  const profileAps = entitlementValue("the exported IPA's embedded provisioning profile", profilePlist, "Entitlements.aps-environment");
  if (profileAps !== "development") throw new Error(`the embedded provisioning profile grants aps-environment=${profileAps}, not development`);
  const profileExpires = Date.parse(run("plutil", ["-extract", "ExpirationDate", "raw", profilePlist], { capture: true }));
  if (!(profileExpires > Date.now())) throw new Error("the iPhone provisioning profile has expired; refresh signing in Xcode");
  rmSync(iosWork, { recursive: true, force: true });
}

// ── Manifest ───────────────────────────────────────────────────────────────
step("manifest");
const range = previousTag ? [`${previousTag}..HEAD`] : ["-n", "30", "HEAD"];
const notes = run("git", ["log", "--no-merges", "--format=- %s", ...range], { capture: true }) || "- 변경 사항 없음";
const manifest = {
  format: "ghost-release/1",
  version,
  commit,
  notes,
  publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  storage: reported.storage,
  host: { asset: hostAsset, sha256: sha256(hostArchive), bytes: statSync(hostArchive).size },
  shell: { version: shellVersion, asset: "Ghost.app.tar.gz", signature: readFileSync(join(out, "Ghost.app.tar.gz.sig"), "utf8").trim(), notes },
  ...(skipIos ? {} : { ios: { ...ios, asset: "Ghost.ipa", sha256: sha256(ipa), bytes: statSync(ipa).size, notes } }),
};
const manifestPath = join(out, "ghost-release.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
run(tauri, ["signer", "sign", manifestPath], { cwd: desktop, env: signerEnv });
if (!existsSync(`${manifestPath}.sig`)) throw new Error("manifest signature was not written");
writeFileSync(join(out, "notes.md"), `${notes}\n`);

// ── Verify as an installed Host would ───────────────────────────────────────
step("verify");
const manifestBytes = readFileSync(manifestPath);
if (!verifyMinisign(pubkey, readFileSync(`${manifestPath}.sig`, "utf8"), manifestBytes)) throw new Error("manifest signature does not verify against the release public key");
const parsed = parseManifest(manifestBytes);
const archiveBytes = readFileSync(hostArchive);
if (sha256(hostArchive) !== parsed.host.sha256 || archiveBytes.length !== parsed.host.bytes) throw new Error("host archive does not match the manifest");
if (!skipIos && (!parsed.ios || sha256(ipa) !== parsed.ios.sha256 || statSync(ipa).size !== parsed.ios.bytes
  || parsed.ios.version !== ios.version || parsed.ios.build !== ios.build || parsed.ios.bundleId !== ios.bundleId)) throw new Error("iPhone app does not match the manifest");
await validateTarball(archiveBytes);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
run("/usr/bin/tar", ["-xzf", hostArchive, "-C", stage, "--no-same-owner"]);
verifyReleaseDirectory(stage, parsed);
// The owner's macOS grants follow these bundles' signatures; they must survive the archive round trip.
for (const bundle of [HOST_BUNDLE, "Ghost Control.app"]) run("codesign", ["--verify", "--strict", join(stage, bundle)]);
run(join(stage, "ghost"), ["version"], { capture: true, env: { GHOST_ROOT: join(out, "version-check") } });
rmSync(stage, { recursive: true, force: true });

const assets = [hostArchive, join(out, "Ghost.app.tar.gz"), join(out, "Ghost.app.tar.gz.sig"), manifestPath, `${manifestPath}.sig`].concat(skipIos ? [] : [ipa]);
console.log(`\nbuilt ${out}\n${assets.map(path => `  ${relative(out, path)}`).join("\n")}`);

// ── Publish ────────────────────────────────────────────────────────────────
// A draft first: Hosts only see the Release once every asset is uploaded.
if (publish) {
  step(`publish ${tag}`);
  run("gh", ["release", "create", tag, "--repo", repository, "--target", fullCommit, "--draft", "--title", `Ghost ${version}`, "--notes-file", join(out, "notes.md"), ...assets]);
  run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
  run("git", ["fetch", "--quiet", "--tags", remote]);
  console.log(`published https://github.com/${repository}/releases/tag/${tag}`);
}
