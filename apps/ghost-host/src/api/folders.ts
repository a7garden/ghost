import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { FolderListing } from "@ghost/contract";
import { CommandError, invalid } from "../core/errors.ts";
import { insidePath, secretPaths } from "../sandbox/seatbelt.ts";

const ENTRY_LIMIT = 500;

export interface FolderOptions {
  home?: string;
  stateRoot: string;
  /** Folders the owner already works in (project paths, workbench roots), offered as shortcuts. */
  known?: readonly string[];
  hidden?: boolean;
}

const isDirectory = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/**
 * The sub-folders of one directory, names only. Files are never listed and credential folders
 * (the Host state root, ~/.ssh and the like) are left out, so choosing a folder cannot become
 * a way to read what the sandbox keeps closed.
 */
export function listFolders(requested: string | null, options: FolderOptions): FolderListing {
  const home = realpathSync(options.home ?? homedir());
  const secrets = secretPaths(home, options.stateRoot).filter(existsSync).map((path) => realpathSync(path));
  const hidden = (path: string): boolean => secrets.some((secret) => insidePath(path, secret));
  let path: string;
  if (requested === null || requested === "") path = home;
  else {
    if (!requested.startsWith("/") && requested !== "~" && !requested.startsWith("~/")) throw invalid("폴더 경로는 절대 경로여야 합니다.");
    const expanded = requested === "~" ? home : requested.startsWith("~/") ? join(home, requested.slice(2)) : requested;
    try { path = realpathSync(resolve(expanded)); } catch { throw new CommandError("not_found", "폴더를 찾을 수 없습니다."); }
  }
  if (!isDirectory(path)) throw invalid("폴더가 아닙니다.");
  if (hidden(path)) throw new CommandError("forbidden", "이 폴더는 열 수 없습니다.");
  let names: string[];
  try { names = readdirSync(path); } catch { throw new CommandError("forbidden", "이 폴더를 읽을 수 없습니다. macOS 설정에서 접근을 허용했는지 확인해 주세요."); }
  const entries: FolderListing["entries"] = [];
  let truncated = false;
  for (const name of names.sort((a, b) => a.localeCompare(b, "ko"))) {
    if (!options.hidden && name.startsWith(".")) continue;
    const child = join(path, name);
    if (!isDirectory(child)) continue;
    let real: string;
    try { real = realpathSync(child); } catch { continue; }
    if (hidden(real)) continue;
    if (entries.length >= ENTRY_LIMIT) { truncated = true; break; }
    entries.push({ name, path: child, git: existsSync(join(child, ".git")) });
  }
  const seen = new Set<string>();
  const shortcuts: FolderListing["shortcuts"] = [];
  const offer = (label: string, folder: string) => {
    let real: string;
    try { real = realpathSync(folder); } catch { return; }
    if (seen.has(real) || !isDirectory(real) || hidden(real)) return;
    seen.add(real);
    shortcuts.push({ label, path: real });
  };
  offer("홈", home);
  for (const name of ["Workspace/Projects", "Workspace", "Projects", "Developer", "src"]) offer(name.split("/").pop()!, join(home, name));
  for (const folder of options.known ?? []) offer(basename(folder) || folder, folder);
  return { path, parent: path === "/" ? null : dirname(path), home, truncated, entries, shortcuts };
}
