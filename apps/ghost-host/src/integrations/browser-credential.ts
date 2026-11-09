import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * `ghost browser-credential`: the agent-browser credential plugin (`agent-browser.plugin.v1`,
 * `credential.read`) that resolves a login from Shade (2026-11-09).
 *
 * agent-browser starts it once per request, writes one JSON envelope on stdin and reads one on stdout,
 * then fills the form itself; the password stays in agent-browser's memory and never reaches the model,
 * the Host's logs or a process argument.
 *
 * 왜 허락 파일인가: Shade 의 에이전트 허가는 금고 전체 단위다. Ghost 가 고른 항목만 열리게 하려면 Host 가
 * 그 호출 하나에 대한 허락(항목 · 출처 · 60초 기한)을 파일로 남기고, 플러그인은 그것을 한 번 읽고 지운다.
 * 파일 이름은 `auth login` 의 프로필 이름으로 넘어온다. 허락과 다른 항목 · 출처를 요청받으면 Shade 를 부르지 않는다.
 */

const PROTOCOL = "agent-browser.plugin.v1";
/** A Shade call that hangs (e.g. waiting for an owner unlock) fails the login instead of holding it. */
const SHADE_TIMEOUT_MS = 20_000;
const TOKEN = /^g[0-9a-f]{32}$/;

interface Grant {
  itemId: string;
  origin: string;
  expiresAt: number;
}

export interface CredentialPluginIo {
  root: string;
  shade: string;
  input: string;
  /** Test seam; production runs the Shade CLI. */
  runShade?: (args: string[], withSecretFd: boolean) => Promise<{ code: number; stdout: string; stderr: string; secret: string }>;
}

const fail = (error: string) => JSON.stringify({ protocol: PROTOCOL, success: false, error });

/** Handle one plugin request; returns the stdout envelope. Never includes a secret in an error. */
export async function credentialPlugin(io: CredentialPluginIo): Promise<string> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(io.input) as Record<string, unknown>;
  } catch {
    return fail("invalid request");
  }
  if (request.protocol !== PROTOCOL) return fail("unsupported protocol");
  if (request.type === "plugin.manifest") {
    return JSON.stringify({ protocol: PROTOCOL, success: true, manifest: { name: "shade", capabilities: ["credential.read"], description: "Shade logins the Ghost owner granted" } });
  }
  if (request.type !== "credential.resolve") return fail("unsupported request");
  const body = (request.request ?? {}) as Record<string, unknown>;
  const token = typeof body.profileName === "string" ? body.profileName : "";
  if (!TOKEN.test(token)) return fail("no grant");
  const grant = takeGrant(io.root, token);
  if (!grant || grant.expiresAt < Date.now()) return fail("no grant");
  let origin: string;
  try {
    origin = new URL(typeof body.url === "string" ? body.url : "").origin;
  } catch {
    return fail("origin mismatch");
  }
  if (body.itemRef !== grant.itemId) return fail("item mismatch");
  if (origin !== grant.origin) return fail("origin mismatch");

  const runShade = io.runShade ?? ((args, withSecretFd) => shadeCli(io.shade, args, withSecretFd));
  // Metadata first: the item must still belong to the granted origin before any secret is disclosed.
  const shown = await runShade(["item", "show", grant.itemId, "--json"], false);
  if (shown.code !== 0) return fail(`shade: ${shadeError(shown.stderr)}`);
  let item: Record<string, unknown>;
  try {
    item = ((JSON.parse(shown.stdout) as { data?: { item?: Record<string, unknown> } }).data?.item ?? {}) as Record<string, unknown>;
  } catch {
    return fail("shade: invalid response");
  }
  if (item.id !== grant.itemId || item.origin !== grant.origin) return fail("shade: item does not belong to the granted origin");
  const read = await runShade(["secret", "read", grant.itemId, "--out-fd", "3"], true);
  if (read.code !== 0 || !read.secret) return fail(`shade: ${shadeError(read.stderr)}`);
  return JSON.stringify({
    protocol: PROTOCOL,
    success: true,
    credential: { username: typeof item.username === "string" ? item.username : "", password: read.secret, url: grant.origin },
  });
}

/** Read and delete the one-shot grant; a second request with the same token finds nothing. */
function takeGrant(root: string, token: string): Grant | null {
  const path = join(root, "browser", "grants", `${token}.json`);
  let grant: Grant;
  try {
    grant = JSON.parse(readFileSync(path, "utf8")) as Grant;
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  return typeof grant.itemId === "string" && typeof grant.origin === "string" && typeof grant.expiresAt === "number" ? grant : null;
}

/** Shade prints `{status:"error", error:{code}}` on stderr; only the code is passed on (never values). */
function shadeError(stderr: string): string {
  try {
    const code = (JSON.parse(stderr.trim().split("\n").pop() ?? "") as { error?: { code?: unknown } }).error?.code;
    if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  } catch {
    // Not Shade's JSON.
  }
  return "unavailable";
}

/** Run the Shade CLI; with `withSecretFd`, the secret arrives on fd 3 (Shade refuses secrets in args or plain stdout by default). */
function shadeCli(shade: string, args: string[], withSecretFd: boolean): Promise<{ code: number; stdout: string; stderr: string; secret: string }> {
  return new Promise((resolve) => {
    const child = spawn(shade, args, {
      stdio: withSecretFd ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
    });
    const chunks: Record<"stdout" | "stderr" | "secret", Buffer[]> = { stdout: [], stderr: [], secret: [] };
    child.stdout?.on("data", (chunk: Buffer) => chunks.stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.stderr.push(chunk));
    const secretStream = withSecretFd ? (child.stdio[3] as NodeJS.ReadableStream | null) : null;
    secretStream?.on("data", (chunk: Buffer) => chunks.secret.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), SHADE_TIMEOUT_MS);
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        secret: Buffer.concat(chunks.secret).toString("utf8"),
      });
    };
    child.on("error", () => done(127));
    child.on("close", (code) => done(code ?? 1));
  });
}

/** CLI entry: `ghost browser-credential --root <root> --shade <shade>`; one request on stdin, one reply on stdout. */
export async function runCredentialPluginCli(argv: string[]): Promise<number> {
  const option = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const root = option("--root");
  const shade = option("--shade");
  if (!root || !shade) {
    process.stdout.write(`${fail("plugin is not configured")}\n`);
    return 1;
  }
  const input = await new Response(Bun.stdin.stream()).text();
  process.stdout.write(`${await credentialPlugin({ root, shade, input })}\n`);
  return 0;
}
