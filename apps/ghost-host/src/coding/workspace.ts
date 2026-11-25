import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { CodingImage, CodingSession } from "@ghost/contract";
import type { ImageContent } from "@earendil-works/pi-ai";
import { invalid } from "../core/errors.ts";
import { gitArgv, gitEnv, readGit } from "../sandbox/git.ts";
import { gitRefPlumbing, insidePath, secretPaths } from "../sandbox/seatbelt.ts";
import { assertNoSymlinkGrants, repositoryOf } from "../sandbox/worktree.ts";
import type { CodingChanges } from "./ports.ts";

const imageExtensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const diffLimit = 40_000;
// Darwin open(2) can reject symlink traversal in any component atomically, not only at the leaf.
const noFollow = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;

/** Reject traversal and *all* symlink components, even links that happen to point inside now. */
export function safePath(root: string, path: string, missing = false): string {
  const refuse = () => invalid("path must stay inside the coding directory (no traversal or symlinks)");
  if (!path || path.includes("\0") || path.split("/").includes("..") || path.startsWith("~") || path.startsWith("@")) throw refuse();
  const target = resolve(root, path);
  if (!insidePath(target, root) || realpathSync(root) !== root) throw refuse();
  let current = root;
  const tail = relative(root, target);
  if (!tail) return root;
  for (const part of tail.split("/")) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info && missing) break;
    if (!info || info.isSymbolicLink()) throw refuse();
  }
  return target;
}

export function fileIn(root: string, path: string): { path: string; mimeType: string } | null {
  if (isAbsolute(path) || path.length > 1024) return null;
  try {
    const file = safePath(root, path);
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1) return null;
    return { path: file, mimeType: Bun.file(file).type };
  } catch { return null; }
}

/** Read the opened inode, not the path after it was checked. */
export function readRegular(path: string, max = Infinity): Buffer {
  const fd = openSync(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > max) throw invalid("not a readable regular file within the size limit");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function writeRegular(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | noFollow | constants.O_NONBLOCK, 0o644);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw invalid("not a writable regular file");
    // Do not truncate until the opened file has passed the inode checks.
    writeFileSync(fd, content);
    // writeFileSync on an fd writes at offset zero but does not truncate it.
    ftruncateSync(fd, Buffer.byteLength(content));
  } finally { closeSync(fd); }
}

function git(cwd: string, args: string[]): string {
  const child = Bun.spawnSync(gitArgv(cwd, args), { env: gitEnv(), stdout: "pipe", stderr: "pipe" });
  if (!child.success) throw invalid(child.stderr.toString().trim().slice(0, 600) || "git command failed");
  return child.stdout.toString().trim();
}

export function prepareWorkspace(root: string, directory: string, sessionDir: string, id: string, isolate: boolean, requestedBranch?: string): Pick<CodingSession, "cwd" | "repo" | "branch" | "base"> {
  if (!isAbsolute(directory)) throw invalid("작업 폴더는 절대 경로여야 합니다.");
  let cwd: string;
  try {
    cwd = realpathSync(directory);
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch { throw invalid("작업 폴더가 없습니다."); }
  if ([...secretPaths(homedir(), root), join(homedir(), ".pi")].some(secret => insidePath(cwd, secret) || insidePath(secret, cwd))) {
    throw invalid("Ghost 상태나 자격 증명이 있는 폴더는 작업 폴더로 쓸 수 없습니다. 다른 폴더를 고르거나 샌드박스를 쓰세요.");
  }
  if (!isolate) return { cwd, repo: null, branch: null, base: null };
  let repo: string;
  try { repo = repositoryOf(cwd); } catch (error) { throw invalid(String(error)); }
  if (insidePath(root, repo) || insidePath(repo, root)) throw invalid("Ghost 상태 폴더와 겹치는 저장소는 쓸 수 없습니다.");
  const slug = basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "repo";
  const branch = requestedBranch ?? `ghost/${slug}-${id.replace(/-/g, "").slice(-12)}`;
  if (branch.startsWith("-") || git(repo, ["check-ref-format", "--branch", branch]) !== branch) throw invalid("invalid branch name");
  const base = git(repo, ["rev-parse", "--verify", "HEAD"]);
  const checkout = join(sessionDir, `worktree-${id}`);
  // Never reuse a branch or checkout from a partially completed create. The caller can inspect it.
  git(repo, ["worktree", "add", "-b", branch, checkout, base]);
  return { cwd: realpathSync(checkout), repo, branch, base };
}

export function worktreeGit(session: Pick<CodingSession, "cwd" | "repo" | "branch">): { common: string; admin: string; branch: string | null } | null {
  const { cwd, repo, branch } = session;
  if (!repo) return null;
  const common = realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const admin = safePath(common, join("worktrees", basename(cwd)));
  const link = readRegular(safePath(cwd, ".git"), 8192).toString("utf8").trim();
  if (!link.startsWith("gitdir: ") || resolve(cwd, link.slice(8)) !== admin) throw invalid("coding worktree git metadata was replaced");
  // The admin directory must still name this repository and this worktree. A rewritten
  // commondir or gitdir would send the Host's own git calls (which run outside the session's
  // sandbox) to a repository the session picked, and that repository's config can run a
  // command. Refuse the session instead of following it.
  const metadata = (file: string): string => readRegular(safePath(admin, file), 8192).toString("utf8").trim();
  try {
    if (realpathSync(resolve(admin, metadata("commondir"))) !== common) throw new Error("commondir");
    if (realpathSync(metadata("gitdir")) !== join(cwd, ".git")) throw new Error("gitdir");
  } catch { throw invalid("coding worktree git metadata was replaced"); }
  // The worktree may have been moved to another branch since the session started. Only the
  // session's own branch may be written; any other HEAD earns no git write access at all.
  const head = metadata("HEAD");
  const own = branch && head === `ref: refs/heads/${branch}` ? branch : null;
  // No grant may be reached through a symlink: a link swapped in place would otherwise promote
  // its target into a writable path.
  const grants = [join(common, "objects"), admin];
  if (own) grants.push(...gitRefPlumbing([join(common, "refs/heads", own)]));
  try { assertNoSymlinkGrants(grants, common); } catch { throw invalid("coding worktree git metadata was replaced"); }
  // Pass the verified admin directory explicitly to git. A later change to the worktree's .git
  // pointer must not make an owner GET endpoint operate on a different repository.
  return { common, admin, branch: own };
}

export class CodingFiles {
  constructor(readonly cwd: string, readonly artifacts: string) {}

  get(path: string) {
    if (path.startsWith("artifacts/")) {
      const name = path.slice("artifacts/".length);
      if (/^[0-9a-f]{64}\.(png|jpg|webp|gif)$/.test(name)) return fileIn(this.artifacts, name);
    }
    return fileIn(this.cwd, path);
  }

  attach(image: ImageContent, label?: string): CodingImage {
    const extension = imageExtensions[image.mimeType];
    if (!extension || !image.data || image.data.length > 12_000_000 || !/^[A-Za-z\d+/]+={0,2}$/.test(image.data) || image.data.length % 4 === 1) throw invalid("unsupported or invalid coding image");
    const bytes = Buffer.from(image.data, "base64");
    const name = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
    mkdirSync(this.artifacts, { recursive: true, mode: 0o700 });
    const target = join(this.artifacts, name);
    if (!lstatSync(target, { throwIfNoEntry: false })) writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    const path = `artifacts/${name}`;
    return { path, mimeType: image.mimeType, ...(label ? { label } : {}) };
  }

  preview(path: string, kind: "image" | "html") {
    const file = fileIn(this.cwd, path);
    if (!file || (kind === "image" ? !file.mimeType.startsWith("image/") : ![".htm", ".html"].includes(extname(path).toLowerCase()))) {
      throw invalid(`${kind} preview must name a ${kind} file inside the coding directory`);
    }
    return file;
  }
}

/** A bounded unified patch for write (Pi's edit already supplies its own unified patch). */
export function writePatch(path: string, before: string | null, after: string): string | undefined {
  if (before === after || (before?.includes("\0") ?? false) || after.includes("\0")) return undefined;
  const lines = (value: string) => value === "" ? [] : value.replace(/\n$/, "").split("\n");
  const oldLines = lines(before ?? ""), newLines = lines(after);
  const range = (list: string[]) => list.length === 0 ? "0,0" : `1,${list.length}`;
  const block = (list: string[], prefix: string, original: string) => list.map(line => `${prefix}${line}\n`).join("") + (list.length && !original.endsWith("\n") ? "\\ No newline at end of file\n" : "");
  return (`--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n@@ -${range(oldLines)} +${range(newLines)} @@\n` + block(oldLines, "-", before ?? "") + block(newLines, "+", after)).slice(0, diffLimit);
}

async function gitRead(cwd: string, args: string[], limit: number): Promise<{ value: string; truncated: boolean }> {
  const result = await readGit(cwd, args, limit);
  if (result.code !== 0 && !result.truncated) throw invalid("cannot read coding worktree changes");
  return result;
}

export async function changesFor(session: CodingSession): Promise<CodingChanges> {
  const { cwd, base } = session;
  if (!base) return { files: [], diff: "", truncated: false, commits: [], dirty: false };
  const metadata = worktreeGit(session);
  const gitFlags = metadata ? [`--git-dir=${metadata.admin}`, `--work-tree=${cwd}`] : [];
  const diffArgs = [...gitFlags, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", base];
  const [names, counts, untracked, diff, commits, status] = await Promise.all([
    gitRead(cwd, [...diffArgs, "--name-status", "-z", "--"], 64_000),
    gitRead(cwd, [...diffArgs, "--numstat", "-z", "--"], 64_000),
    gitRead(cwd, [...gitFlags, "ls-files", "--others", "--exclude-standard", "-z", "--"], 64_000),
    gitRead(cwd, [...diffArgs, "--", "."], diffLimit),
    gitRead(cwd, [...gitFlags, "log", "-30", "--format=%s", `${base}..HEAD`, "--"], 16_000),
    gitRead(cwd, [...gitFlags, "status", "--porcelain=v1", "--untracked-files=normal"], 4_000),
  ]);
  const fields = (s: string) => s.slice(0, s.lastIndexOf("\0") + 1).split("\0").slice(0, -1);
  const numbers = new Map<string, { additions: number; deletions: number }>();
  const stats = fields(counts.value);
  for (let i = 0; i < stats.length; i++) {
    const [, plus, minus, name] = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[i]!) ?? [];
    if (plus === undefined) continue;
    const path = name === "" ? stats[i += 2] : name;
    if (path) numbers.set(path, { additions: Number(plus) || 0, deletions: Number(minus) || 0 });
  }
  const files: CodingChanges["files"] = [];
  const paths = fields(names.value);
  for (let i = 0; i < paths.length;) {
    const tag = paths[i++]![0];
    if (tag === "R" || tag === "C") i++;
    const path = paths[i++];
    if (path) files.push({ path, status: tag === "R" ? "renamed" : tag === "A" || tag === "C" ? "added" : tag === "D" ? "deleted" : "modified", ...(numbers.get(path) ?? { additions: 0, deletions: 0 }) });
  }
  for (const path of fields(untracked.value)) files.push({ path, status: "untracked", additions: 0, deletions: 0 });
  return { files, diff: diff.value, truncated: [names, counts, untracked, diff, commits].some(part => part.truncated), commits: commits.value.trimEnd().split("\n").filter(Boolean), dirty: status.value.length > 0 };
}
