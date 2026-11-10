import { lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite, detectLayout } from "./storage.ts";

const quoteSh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export function launcherScript(base: string, root: string): string {
  return `#!/bin/sh
set -eu
BASE=${quoteSh(base)}
GHOST_ROOT=${quoteSh(root)}
export GHOST_ROOT
GHOST_SERVICE=launchd
export GHOST_SERVICE
UPDATE="$GHOST_ROOT/update"
valid_name() {
  case "$1" in ''|.|..|*[!A-Za-z0-9._-]*) return 1 ;; esac
}
valid=yes
if [ -f "$UPDATE/pending" ]; then
  previous= rollback= target= extra=
  IFS=' ' read -r previous rollback target extra < "$UPDATE/pending" || true
  if ! valid_name "$previous" || ! valid_name "$target" || [ -n "$extra" ]; then valid=no; fi
  case "$rollback" in yes|no) ;; *) valid=no ;; esac
fi
if [ -f "$UPDATE/pending" ] && [ "$valid" = no ]; then
  # A damaged record must not keep the Host down: start the current release without the guard.
  echo 'Ignoring invalid Ghost update pending record' >&2
  rm -f "$UPDATE/pending" "$UPDATE/attempts"
elif [ -f "$UPDATE/pending" ]; then
  attempts=0
  if [ -f "$UPDATE/attempts" ]; then
    IFS= read -r attempts < "$UPDATE/attempts" || true
  fi
  case "$attempts" in ''|*[!0-9]*|??????????*) attempts=0 ;; esac
  while [ "\${attempts#0}" != "$attempts" ]; do attempts=\${attempts#0}; done
  attempts=\${attempts:-0}
  attempts=$((attempts + 1))
  umask 077
  printf '%s\\n' "$attempts" > "$UPDATE/attempts.tmp"
  mv -f "$UPDATE/attempts.tmp" "$UPDATE/attempts"
  if [ "$attempts" -gt 3 ]; then
    outcome=failed
    if [ "$rollback" = yes ] && [ -x "$BASE/releases/$previous/ghost" ]; then
      ln -sfh "releases/$previous" "$BASE/current"
      outcome=rolled_back
    fi
    at=$(date +%s)000
    printf '{"outcome":"%s","from":"%s","to":"%s","at":%s}\\n' "$outcome" "$previous" "$target" "$at" > "$UPDATE/result.json.tmp"
    mv -f "$UPDATE/result.json.tmp" "$UPDATE/result.json"
    rm -f "$UPDATE/pending" "$UPDATE/attempts"
  fi
fi
exec "$BASE/current/ghost" serve
`;
}

export interface ServiceInstallOptions {
  root: string;
  home?: string;
  execPath?: string;
  noLoad?: boolean;
  uid?: number;
  launchctl?: (args: string[]) => Promise<{ code: number; stderr: string }>;
}

export async function installService(options: ServiceInstallOptions): Promise<{ launcher: string; plist: string; link: string }> {
  const layout = detectLayout(options.execPath);
  if (!layout) throw new Error("릴리스의 current/ghost에서 서비스를 설치해 주세요.");
  const home = options.home ?? homedir();
  const launcher = join(layout.base, "bin", "ghost-launch");
  const plist = join(home, "Library", "LaunchAgents", "com.a7.ghost.plist");
  const logs = join(home, "Library", "Logs", "Ghost");
  const link = join(home, ".local", "bin", "ghost");
  // Refuse to overwrite an owner's executable, including a dangling non-symlink path.
  try {
    if (!lstatSync(link).isSymbolicLink()) throw new Error(`${link} already exists and is not a symlink`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
  atomicWrite(launcher, launcherScript(layout.base, options.root), 0o755);
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.a7.ghost</string>
<key>ProgramArguments</key><array><string>${xml(launcher)}</string></array>
<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>ExitTimeOut</key><integer>30</integer><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, "host.out.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, "host.err.log"))}</string>
</dict></plist>
`;
  atomicWrite(plist, content);
  const temporary = `${link}.${crypto.randomUUID()}.tmp`;
  try { symlinkSync(join(layout.base, "current", "ghost"), temporary); renameSync(temporary, link); }
  finally { rmSync(temporary, { force: true }); }
  if (!options.noLoad) {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("launchd user ID is unavailable");
    const run = options.launchctl ?? (async (args: string[]) => {
      const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    });
    const domain = `gui/${uid}`;
    const stopped = await run(["bootout", `${domain}/com.a7.ghost`]);
    if (stopped.code !== 0 && stopped.code !== 3 && !/not (?:loaded|found)|no such process|could not find service/i.test(stopped.stderr)) throw new Error(`launchctl bootout: ${stopped.stderr}`);
    const loaded = await run(["bootstrap", domain, plist]);
    if (loaded.code !== 0) throw new Error(`launchctl bootstrap: ${loaded.stderr}`);
  }
  return { launcher, plist, link };
}
