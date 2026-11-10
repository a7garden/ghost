import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import type { ReleaseManifest } from "./github.ts";
import { promisify } from "node:util";

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const decompress = promisify(gunzip);

export function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path)
    && path.split("/").every((part) => part !== ".." && part !== "." && part !== "");
}

/** Parse tar headers before invoking the platform extractor; reject links and extension records. */
export async function validateTarball(compressed: Uint8Array): Promise<void> {
  const tar = await decompress(compressed, { maxOutputLength: MAX_EXPANDED_BYTES });
  const seen = new Set<string>();
  let offset = 0, ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) { ended = true; break; }
    const text = (start: number, end: number) => header.subarray(start, end).toString("utf8").split("\0", 1)[0]!;
    const prefix = text(345, 500), rawName = text(0, 100);
    const full = prefix ? `${prefix}/${rawName}` : rawName;
    const type = header[156];
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("업데이트 압축 파일에 허용되지 않은 항목이 있습니다.");
    const name = full.endsWith("/") ? full.slice(0, -1) : full;
    if (!safeRelativePath(name) || seen.has(name) || seen.size >= 100_000) throw new Error("업데이트 압축 파일 경로가 올바르지 않습니다.");
    seen.add(name);
    const sizeText = text(124, 136).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error("업데이트 압축 파일 크기가 올바르지 않습니다.");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || (type === 53 && size !== 0)) throw new Error("업데이트 압축 파일이 올바르지 않습니다.");
    const expected = Number.parseInt(text(148, 156).trim(), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (sum !== expected) throw new Error("업데이트 압축 파일이 손상되었습니다.");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > tar.length) throw new Error("업데이트 압축 파일이 잘렸습니다.");
  }
  if (!ended || tar.subarray(offset).some((byte) => byte !== 0)) throw new Error("업데이트 압축 파일이 올바르지 않습니다.");
}

export function verifyReleaseDirectory(directory: string, manifest: ReleaseManifest): void {
  const releasePath = join(directory, "release.json");
  const stat = lstatSync(releasePath);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("릴리스 파일 목록이 올바르지 않습니다.");
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  if (release.format !== "ghost-release-files/1" || release.version !== manifest.version || release.commit !== manifest.commit || release.storage !== manifest.storage
    || !release.files || Array.isArray(release.files) || typeof release.files !== "object") throw new Error("릴리스 정보가 업데이트와 일치하지 않습니다.");
  const expected = new Map<string, string>();
  for (const [name, hash] of Object.entries(release.files)) {
    if (!safeRelativePath(name) || name === "release.json" || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error("릴리스 파일 목록이 올바르지 않습니다.");
    expected.set(name, hash);
  }
  const visit = (relative: string) => {
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const entry = lstatSync(join(directory, path));
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile() || entry.nlink !== 1) throw new Error("릴리스에 허용되지 않은 파일이 있습니다.");
      if (path === "release.json") continue;
      const hash = expected.get(path);
      if (!hash || sha256(readFileSync(join(directory, path))) !== hash) throw new Error("릴리스 파일 검증에 실패했습니다.");
      expected.delete(path);
    }
  };
  visit("");
  if (expected.size || !lstatSync(join(directory, "ghost")).isFile() || !(lstatSync(join(directory, "ghost")).mode & 0o111)) throw new Error("릴리스 파일이 누락되었습니다.");
}

export async function runReleaseCommand(command: string[], signal?: AbortSignal, timeout = 30_000): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: { ...process.env, GHOST_ROOT: undefined }, signal, timeout });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`업데이트 실행 검증에 실패했습니다. ${stderr.slice(0, 300)}`);
  if (stdout.length > 64 * 1024) throw new Error("업데이트 실행 응답이 너무 큽니다.");
  return stdout;
}
