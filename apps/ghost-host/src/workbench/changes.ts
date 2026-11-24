import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WorkbenchChanges, WorkbenchFileDiff } from "@ghost/contract";
import { readRegular, safePath, writePatch } from "../coding/workspace.ts";
import { invalid, notFound } from "../core/errors.ts";
import { readGit, type GitRead } from "../sandbox/git.ts";

const FILE_LIMIT = 300;
const LIST_BYTES = 64_000;
const DIFF_BYTES = 40_000;
const STATUS = ["--literal-pathspecs", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=dirty"];
const DIFF = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--submodule=short", "--ignore-submodules=dirty"];

function records(value: string) {
  // A bounded read can end partway through a record; never expose it as a file path.
  const parts = value.split("\0");
  parts.pop();
  return parts;
}

function checked(result: GitRead) {
  if (result.code !== 0 && !result.truncated) throw invalid("Git 변경을 읽지 못했습니다.");
  return result;
}

export async function spaceChanges(root: string | null, path: string | null): Promise<WorkbenchChanges | WorkbenchFileDiff> {
  if (!root) throw invalid("스페이스에 Git 작업 폴더가 없습니다.");
  const top = await readGit(root, ["rev-parse", "--show-toplevel"], 8192);
  if (top.code !== 0 || top.truncated || !top.value) throw invalid("스페이스의 작업 폴더가 Git 저장소가 아닙니다.");
  const repo = top.value.replace(/\n$/, "");
  // Status and diff can run repository-configured clean/process filters even without an external diff driver.
  const filters = await readGit(repo, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"], 8192);
  if ((filters.code !== 0 && filters.code !== 1) || filters.truncated) throw invalid("Git 필터 설정을 읽지 못했습니다.");
  const keys = new Set(records(filters.value));
  let config: Record<string, string> | undefined;
  if (keys.size) {
    config = { GIT_CONFIG_COUNT: String(keys.size) };
    let i = 0;
    for (const key of keys) {
      config[`GIT_CONFIG_KEY_${i}`] = key;
      config[`GIT_CONFIG_VALUE_${i++}`] = key.endsWith(".required") ? "false" : "";
    }
  }
  const read = (args: string[], limit: number) => readGit(repo, args, limit, config).then(checked);
  if (path !== null) return fileDiff(repo, path, read);

  const [status, staged, unstaged, branch] = await Promise.all([
    read(STATUS, LIST_BYTES),
    read([...DIFF, "--cached", "--numstat", "-z", "--"], LIST_BYTES),
    read([...DIFF, "--numstat", "-z", "--"], LIST_BYTES),
    readGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], 4096),
  ]);
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const result of [staged, unstaged]) {
    for (const entry of records(result.value)) {
      const first = entry.indexOf("\t"), second = entry.indexOf("\t", first + 1);
      const name = entry.slice(second + 1);
      const additions = entry.slice(0, first), deletions = entry.slice(first + 1, second);
      const prior = counts.get(name);
      counts.set(name, {
        additions: additions === "-" || prior?.additions === null ? null : Number(additions) + (prior?.additions ?? 0),
        deletions: deletions === "-" || prior?.deletions === null ? null : Number(deletions) + (prior?.deletions ?? 0),
      });
    }
  }

  const entries = records(status.value);
  const files = entries.slice(0, FILE_LIMIT).map((entry): WorkbenchChanges["files"][number] => {
    const xy = entry.slice(0, 2), path = entry.slice(3);
    const status = xy === "??" ? "untracked" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : "modified";
    return { path, xy, status, ...(counts.get(path) ?? { additions: null, deletions: null }) };
  });
  return {
    branch: branch.code === 0 && !branch.truncated ? branch.value.trimEnd() : null,
    files, truncated: entries.length > FILE_LIMIT || status.truncated || staged.truncated || unstaged.truncated,
  };
}

async function fileDiff(repo: string, path: string, read: (args: string[], limit: number) => Promise<GitRead>): Promise<WorkbenchFileDiff> {
  if (!path || path.length > 4096 || path.includes("\0") || path.replace(/\/$/, "").split("/").some(part => !part || part === "." || part === "..")) {
    throw invalid("변경 파일 경로가 올바르지 않습니다.");
  }
  // Git receives a literal pathspec. Match the entire status record, not a directory or pattern.
  const status = await read([...STATUS, "--", path], LIST_BYTES);
  const entry = records(status.value).find(entry => entry.slice(3) === path);
  if (!entry) throw notFound("변경된 파일을 찾을 수 없습니다.");
  if (entry.startsWith("?? ")) {
    // Untracked content is not in the index. Read only a bounded regular file inside the checkout.
    const directory = safePath(realpathSync(repo), dirname(path));
    const file = join(directory, basename(path));
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isFile() || info.nlink !== 1) return { path, staged: "", unstaged: "", truncated: false };
    if (info.size > DIFF_BYTES) return { path, staged: "", unstaged: "", truncated: true };
    const content = readRegular(file, DIFF_BYTES).toString("utf8");
    const patch = writePatch(path, null, content) ?? "";
    return { path, staged: "", unstaged: patch, truncated: patch.length === DIFF_BYTES };
  }

  const [staged, unstaged] = await Promise.all([
    read([...DIFF, "--cached", "--", path], DIFF_BYTES),
    read([...DIFF, "--", path], DIFF_BYTES),
  ]);
  return { path, staged: staged.value, unstaged: unstaged.value, truncated: staged.truncated || unstaged.truncated };
}
