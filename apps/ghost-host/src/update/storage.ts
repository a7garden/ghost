import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { UpdateStatus } from "@ghost/contract";
import { RELEASE_NAME } from "./github.ts";

export interface UpdateState {
  autoCheck: boolean;
  checkedAt: number | null;
  failures: number;
  manifest?: string;
  signature?: string;
  lastResult?: UpdateStatus["lastResult"];
}

/** Atomic same-directory writes keep interrupted updates from truncating durable state. */
export function atomicWrite(path: string, content: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
export type UpdateLog = (message: string, detail?: unknown) => void;

export function validUpdateResult(value: unknown): value is NonNullable<UpdateStatus["lastResult"]> {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return ["installed", "rolled_back", "failed"].includes(String(result.outcome))
    && typeof result.from === "string" && typeof result.to === "string"
    && typeof result.at === "number" && Number.isFinite(result.at);
}

export function readState(root: string, log: UpdateLog): UpdateState {
  const defaults: UpdateState = { autoCheck: true, checkedAt: null, failures: 0 };
  const path = join(root, "update", "state.json");
  try {
    if (!existsSync(path)) return defaults;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value.autoCheck !== "boolean" || !(value.checkedAt === null || (typeof value.checkedAt === "number" && Number.isFinite(value.checkedAt)))
      || !Number.isSafeInteger(value.failures) || value.failures < 0
      || (value.manifest !== undefined && typeof value.manifest !== "string")
      || (value.signature !== undefined && typeof value.signature !== "string")
      || (value.lastResult != null && !validUpdateResult(value.lastResult))) throw new Error("invalid update state");
    return value as UpdateState;
  } catch (error) { log("업데이트 설정을 읽지 못해 기본 설정을 사용합니다.", error); return defaults; }
}

export function readCredential(root: string, log: UpdateLog): string | null {
  const path = join(root, "secrets", "update-github.json");
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value.token !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.token)) throw new Error("invalid update credential");
    chmodSync(path, 0o600);
    return value.token;
  } catch (error) { log("업데이트 인증 정보를 읽지 못했습니다.", error); return null; }
}

export interface ReleaseLayout { base: string; name: string; directory: string }
export function detectLayout(execPath = process.execPath): ReleaseLayout | null {
  try {
    const executable = realpathSync(execPath);
    const directory = dirname(executable), releases = dirname(directory), base = dirname(releases), name = basename(directory);
    if (basename(executable) !== "ghost" || basename(releases) !== "releases" || !RELEASE_NAME.test(name) || name === "." || name === "..") return null;
    if (!lstatSync(join(base, "current")).isSymbolicLink() || realpathSync(join(base, "current")) !== directory) return null;
    return { base, name, directory };
  } catch { return null; }
}

export function readPending(root: string): { previous: string; rollback: boolean; target: string } | null {
  const path = join(root, "update", "pending");
  if (!existsSync(path)) return null;
  const match = /^([A-Za-z0-9._-]+) (yes|no) ([A-Za-z0-9._-]+)\n?$/.exec(readFileSync(path, "utf8"));
  if (!match || [match[1], match[3]].some((name) => name === "." || name === "..")) throw new Error("업데이트 대기 정보가 올바르지 않습니다.");
  return { previous: match[1]!, rollback: match[2] === "yes", target: match[3]! };
}
