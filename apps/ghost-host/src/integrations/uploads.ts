import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HerdrUpload } from "@ghost/contract";
import { invalid } from "../core/errors.ts";

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 3600_000;

/** A name an agent can take as a path: no folders, no leading dot or dash, nothing a shell or a prompt would treat specially. */
export function safeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+/, "").slice(-80);
  return cleaned === "" ? "file" : cleaned;
}

/**
 * A file the owner sent from the app, kept under the state root where the agent (the same macOS user) can read it by
 * path. Files older than a week are removed whenever one arrives.
 */
export function saveUpload(root: string, name: string, bytes: Uint8Array, now = Date.now()): HerdrUpload {
  if (bytes.byteLength === 0) throw invalid("the file is empty");
  if (bytes.byteLength > UPLOAD_MAX_BYTES) throw invalid("the file is larger than 10 MB");
  const dir = join(root, "uploads");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir)) {
    try { if (now - statSync(join(dir, entry)).mtimeMs > KEEP_MS) unlinkSync(join(dir, entry)); } catch { /* gone already */ }
  }
  const safe = safeUploadName(name);
  const path = join(dir, `${crypto.randomUUID().slice(0, 8)}-${safe}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, name: safe, size: bytes.byteLength };
}

/** A composer may attach only files this Host saved, never arbitrary local paths. */
export function checkUploads(root: string, paths: readonly string[]): void {
  const dir = join(root, "uploads");
  for (const path of paths) {
    const name = basename(path);
    if (path !== join(dir, name) || !/^[a-f\d]{8}-[\p{L}\p{N}._-]+$/u.test(name) || /[\x00-\x1f\x7f-\x9f]/.test(path)) {
      throw invalid("이 호스트에 올린 파일만 첨부할 수 있습니다.");
    }
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw invalid("첨부 파일이 없거나 만료됐습니다. 다시 첨부해 주세요.");
  }
}
