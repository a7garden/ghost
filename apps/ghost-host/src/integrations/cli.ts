import { homedir } from "node:os";

export interface CliResult { code: number; stdout: Buffer; stderr: string }
export type CliRunner = (program: string, args: string[], options?: { stdin?: Uint8Array; timeoutMs?: number }) => Promise<CliResult>;

const MAX_BYTES = 1024 * 1024;

/** JSON from a program is untrusted: narrow to an object, then check every field it is used for. */
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** One short-lived program, no shell. Output is bounded; a program that hangs is killed. Secret bytes travel on stdin/stdout only. */
export const runCli: CliRunner = async (program, args, options = {}) => {
  const child = Bun.spawn([program, ...args], {
    stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe",
    env: { HOME: homedir(), PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", LANG: "en_US.UTF-8", NO_COLOR: "1", GH_PROMPT_DISABLED: "1" },
  });
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 8000);
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) { child.kill(); break; }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  try {
    const [stdout, stderr, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    return { code, stdout, stderr: stderr.toString("utf8").slice(0, 2000) };
  } finally { clearTimeout(timer); }
};
