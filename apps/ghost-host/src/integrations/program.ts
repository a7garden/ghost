import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isExecutable = (path: string) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** A program by name: where its installer puts it, then PATH. */
export function findProgram(name: string, dirs?: string[]): string | null {
  const home = homedir();
  const path = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs ?? [...new Set([join(home, ".bun/bin"), join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...path])]) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}
