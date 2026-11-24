import { homedir, tmpdir } from "node:os";

export function gitArgv(cwd: string, args: string[]): string[] {
  // Host calls run outside the coding sandbox. Do not delegate to hooks, fsmonitor or an external diff.
  return [process.platform === "darwin" ? "/usr/bin/git" : "git", "--no-pager", "-C", cwd,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args];
}

export function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), TMPDIR: tmpdir(), LANG: "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

export type GitRead = { value: string; code: number; truncated: boolean };

export async function readGit(cwd: string, args: string[], limit: number, config?: Record<string, string>): Promise<GitRead> {
  const env = { ...gitEnv(), GIT_NO_LAZY_FETCH: "1", ...config };
  const child = Bun.spawn(gitArgv(cwd, args), { env, stdout: "pipe", stderr: "ignore" });
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  for await (const chunk of child.stdout) {
    if (size < limit) chunks.push(chunk.subarray(0, limit - size));
    size += chunk.byteLength;
    if (size > limit) { truncated = true; child.kill(); break; }
  }
  const code = await child.exited;
  return { code, value: Buffer.concat(chunks).toString("utf8"), truncated };
}
