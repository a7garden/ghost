import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, constants as FS, copyFileSync, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandError } from "../core/errors.ts";

const KOREAN_FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc";
const FONT_FILE = "AppleSDGothicNeo.ttc";
const FONT_SOURCE = "source.json";
const STAGED_CACHE_FILE = /^\.(font|source)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Cache one OS-owned font locally; never redistribute it or scan the system's full font collection. */
export function prepareObscuraFonts(root: string): string {
  let source;
  try { source = lstatSync(KOREAN_FONT); }
  catch { throw new CommandError("unavailable", "Obscura Korean font is unavailable: AppleSDGothicNeo.ttc is required"); }
  if (!source.isFile() || source.isSymbolicLink() || source.size === 0) throw new CommandError("unavailable", "Obscura Korean font is unavailable: AppleSDGothicNeo.ttc must be a regular system file");
  const base = realpathSync(root);
  const directory = join(base, "browser", "fonts");
  for (const path of [join(base, "browser"), directory]) {
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) throw new CommandError("unavailable", "Unsafe Obscura font cache directory");
  }
  for (const name of readdirSync(directory)) {
    if (name !== FONT_FILE && name !== FONT_SOURCE) {
      const kind = STAGED_CACHE_FILE.exec(name)?.[1];
      if (!kind) throw new CommandError("unavailable", "Unexpected Obscura font cache entry");
      const path = join(directory, name), staged = lstatSync(path), mode = staged.mode & 0o7777;
      // copyFileSync can leave the system font's read permissions if the process dies before chmod.
      const safeMode = kind === "font" ? (mode & ~0o644) === 0 : mode === 0o600;
      if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 || staged.uid !== process.getuid?.() || !safeMode) throw new CommandError("unavailable", "Unsafe Obscura font cache staging file");
      rmSync(path, { force: true });
      continue;
    }
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw new CommandError("unavailable", "Unsafe Obscura font cache file");
  }
  const font = join(directory, FONT_FILE), metadata = join(directory, FONT_SOURCE);
  const fingerprint = JSON.stringify({ path: KOREAN_FONT, size: source.size, mtimeMs: source.mtimeMs });
  const cachedFont = lstatSync(font, { throwIfNoEntry: false });
  if (cachedFont?.size === source.size && lstatSync(metadata, { throwIfNoEntry: false })) {
    const fd = openSync(metadata, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2048 || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600) throw new CommandError("unavailable", "Unsafe Obscura font cache fingerprint");
      if (readFileSync(fd, "utf8") === fingerprint) return directory;
    } finally { closeSync(fd); }
  }
  const stagedFont = join(directory, `.font-${randomUUID()}`), stagedMetadata = join(directory, `.source-${randomUUID()}`);
  try {
    // COPYFILE_FICLONE uses a CoW clone when available, and falls back to an ordinary copy otherwise.
    copyFileSync(KOREAN_FONT, stagedFont, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
    chmodSync(stagedFont, 0o600);
    const current = lstatSync(KOREAN_FONT);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== source.dev || current.ino !== source.ino || current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new CommandError("unavailable", "Obscura Korean system font changed while being cached");
    writeFileSync(stagedMetadata, fingerprint, { flag: "wx", mode: 0o600 });
    renameSync(stagedFont, font);
    renameSync(stagedMetadata, metadata);
    return directory;
  } finally { rmSync(stagedFont, { force: true }); rmSync(stagedMetadata, { force: true }); }
}
// The engine can open its private CDP listener and connect to the one Host proxy port.
// File permissions deliberately omit the Host's HOME, state root and the release directory.
export const OBSCURA_SANDBOX = `(version 1)
(deny default)
(allow process-exec (literal (param "ENGINE")))
(allow process-info* (target self))
(allow sysctl-read)
(allow file-map-executable (literal (param "ENGINE")) (subpath "/System/Library") (subpath "/usr/lib"))
(allow file-read* (literal "/") (literal (param "ENGINE")) (subpath "/System/Library") (subpath "/usr/lib")
  (subpath "/private/var/db/timezone") (subpath (param "FONTS")) (literal "/dev/null") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null"))
(allow network-bind (local ip (param "CDP")))
(allow network-inbound (local ip (param "CDP")))
(allow network-outbound (remote ip (param "PROXY")))
`;

// Closing the Host's pipe stops the engine even if the Host exits without its cleanup handler.
const supervise = `
exec 3<&0
"$@" </dev/null >/dev/null 3<&- &
engine=$!
printf '%s\n' "$engine"
exec 1>/dev/null
( IFS= read -r _ <&3; kill -KILL "$engine" 2>/dev/null ) &
watch=$!
trap 'kill -KILL "$engine" 2>/dev/null' TERM INT
wait "$engine"
result=$?
kill "$watch" 2>/dev/null
wait "$watch" 2>/dev/null
exit "$result"
`;

export interface ObscuraProcess {
  endpoint: string;
  websocket: string;
  headers: Record<string, string>;
  running(): boolean;
  stop(): Promise<void>;
}

export async function startObscura(executable: string, proxy: string, root: string): Promise<ObscuraProcess> {
  if (process.platform !== "darwin") throw new CommandError("unavailable", "Obscura requires the macOS browser sandbox");
  const engine = realpathSync(executable);
  const fonts = prepareObscuraFonts(root);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const token = randomBytes(32).toString("hex");
  const headers = { Authorization: `Bearer ${token}` };
  const endpoint = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["/bin/bash", "-c", supervise, "ghost-obscura",
    "/usr/bin/sandbox-exec", "-D", `ENGINE=${engine}`, "-D", `CDP=localhost:${port}`,
    "-D", `PROXY=localhost:${new URL(proxy).port}`, "-D", `FONTS=${fonts}`, "-p", OBSCURA_SANDBOX,
    engine, "serve", "--host", "127.0.0.1", "--port", String(port), "--proxy", proxy, "--font-dir", fonts], {
    cwd: "/var/empty", env: { HOME: "/var/empty", PATH: "/usr/bin:/bin", OBSCURA_CDP_TOKEN: token },
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  let stopping: Promise<void> | null = null;
  const stop = () => stopping ??= (async () => {
    child.stdin.end();
    await child.exited;
  })();
  try {
    const pid = (await new Response(child.stdout).text()).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) throw new CommandError("unavailable", "Isolated Obscura did not start");
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && Date.now() < deadline) {
      try {
        const denied = await fetch(`${endpoint}/json/version`, { redirect: "error", signal: AbortSignal.timeout(300) });
        await denied.body?.cancel();
        if (denied.status === 401 || denied.status === 403) {
          // The selected port was released before spawning. Prove the listener belongs
          // to our engine before supplying the token, even when another bind races it.
          const probe = Bun.spawn(["/usr/sbin/lsof", "-nP", "-a", "-p", pid, `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], {
            env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "ignore",
          });
          const [bindings, exit] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
          if (exit !== 0 || !bindings.split("\n").includes(`n127.0.0.1:${port}`)) break;
          const ready = await fetch(`${endpoint}/json/version`, { headers, redirect: "error", signal: AbortSignal.timeout(300) });
          if (ready.ok && child.exitCode === null) {
            const { webSocketDebuggerUrl } = await ready.json() as { webSocketDebuggerUrl?: string };
            const websocket = `ws://127.0.0.1:${port}/devtools/browser`;
            if (webSocketDebuggerUrl !== websocket) break;
            return { endpoint, websocket, headers, running: () => child.exitCode === null, stop };
          }
          await ready.body?.cancel();
        }
      } catch { /* Listener may still be starting. */ }
      await Bun.sleep(50);
    }
    throw new CommandError("unavailable", "Isolated Obscura did not start");
  } catch (error) {
    await stop();
    throw error;
  }
}
