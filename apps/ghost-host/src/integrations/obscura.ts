import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { CommandError } from "../core/errors.ts";

// The engine can open its private CDP listener and connect to the one Host proxy port.
// File permissions deliberately omit the Host's HOME, state root and the release directory.
export const OBSCURA_SANDBOX = `(version 1)
(deny default)
(allow process-exec (literal (param "ENGINE")))
(allow process-info* (target self))
(allow sysctl-read)
(allow file-map-executable (literal (param "ENGINE")) (subpath "/System/Library") (subpath "/usr/lib"))
(allow file-read* (literal "/") (literal (param "ENGINE")) (subpath "/System/Library") (subpath "/usr/lib")
  (subpath "/private/var/db/timezone") (subpath "/Library/Fonts") (literal "/dev/null") (literal "/dev/urandom"))
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

export async function startObscura(executable: string, proxy: string): Promise<ObscuraProcess> {
  if (process.platform !== "darwin") throw new CommandError("unavailable", "Obscura requires the macOS browser sandbox");
  const engine = realpathSync(executable);
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const token = randomBytes(32).toString("hex");
  const headers = { Authorization: `Bearer ${token}` };
  const endpoint = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(["/bin/bash", "-c", supervise, "ghost-obscura",
    "/usr/bin/sandbox-exec", "-D", `ENGINE=${engine}`, "-D", `CDP=localhost:${port}`,
    "-D", `PROXY=localhost:${new URL(proxy).port}`, "-p", OBSCURA_SANDBOX,
    engine, "serve", "--host", "127.0.0.1", "--port", String(port), "--proxy", proxy], {
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
