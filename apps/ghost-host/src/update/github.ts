import { verifyMinisign } from "./signature.ts";

export interface ReleaseManifest {
  format: "ghost-release/1";
  version: string;
  commit: string;
  notes: string;
  publishedAt: string;
  storage: string;
  host: { asset: string; sha256: string; bytes: number };
  shell: { version: string; asset: string; signature: string; notes: string };
  ios?: { version: string; build: number; bundleId: string; asset: "Ghost.ipa"; sha256: string; bytes: number; notes: string };
}
export interface ReleaseAsset { name: string; url: string; size: number }
export interface GitHubRelease { tag_name: string; assets: ReleaseAsset[] }
export type UpdateFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const RELEASE_NAME = /^[A-Za-z0-9._-]+$/;
const BUNDLE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function parseManifest(bytes: Uint8Array): ReleaseManifest {
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || value.format !== "ghost-release/1" || !VERSION.test(value.version) || typeof value.commit !== "string" || !RELEASE_NAME.test(value.commit)
    || typeof value.notes !== "string" || typeof value.publishedAt !== "string" || !Number.isFinite(Date.parse(value.publishedAt)) || typeof value.storage !== "string"
    || !value.host || typeof value.host.asset !== "string" || !RELEASE_NAME.test(value.host.asset) || !/^[0-9a-f]{64}$/.test(value.host.sha256)
    || !Number.isSafeInteger(value.host.bytes) || value.host.bytes <= 0 || value.host.bytes > MAX_ASSET_BYTES
    || !value.shell || typeof value.shell.version !== "string" || !VERSION.test(value.shell.version) || value.shell.asset !== "Ghost.app.tar.gz"
    || typeof value.shell.signature !== "string" || !value.shell.signature || typeof value.shell.notes !== "string") {
    throw new Error("업데이트 정보가 올바르지 않습니다.");
  }
  if ("ios" in value) {
    const ios = value.ios;
    if (!ios || typeof ios !== "object" || Array.isArray(ios)
      || typeof ios.version !== "string" || !VERSION.test(ios.version) || !Number.isSafeInteger(ios.build) || ios.build < 1
      || typeof ios.bundleId !== "string" || !BUNDLE_ID.test(ios.bundleId) || ios.asset !== "Ghost.ipa"
      || typeof ios.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(ios.sha256)
      || !Number.isSafeInteger(ios.bytes) || ios.bytes < 1 || ios.bytes > MAX_ASSET_BYTES || typeof ios.notes !== "string") {
      throw new Error("iPhone 앱 업데이트 정보가 올바르지 않습니다.");
    }
  }
  return value as ReleaseManifest;
}

/** Numeric semver comparison, including prerelease precedence. */
export function newer(version: string, current: string): boolean {
  const [a, ap] = version.split("-", 2), [b, bp] = current.split("-", 2);
  const av = a!.split(".").map(Number), bv = b!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i]! > bv[i]!;
  if (ap === undefined || bp === undefined) return ap === undefined && bp !== undefined;
  const aa = ap.split("."), bb = bp.split(".");
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return false;
    if (bb[i] === undefined) return true;
    if (aa[i] === bb[i]) continue;
    const an = /^\d+$/.test(aa[i]!), bn = /^\d+$/.test(bb[i]!);
    return an && bn ? Number(aa[i]) > Number(bb[i]) : an !== bn ? !an : aa[i]! > bb[i]!;
  }
  return false;
}

export class GitHubClient {
  constructor(readonly repository: string, private readonly token: () => string | null, private readonly fetcher: UpdateFetch = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("invalid release repository");
  }

  private async request(url: string, cap: number, signal?: AbortSignal, asset = false, largeAsset = false): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(largeAsset ? 15 * 60_000 : 120_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { "User-Agent": "Ghost-Updater", Accept: asset ? "application/octet-stream" : "application/vnd.github+json", Authorization: `Bearer ${this.token() ?? ""}` };
    let response = await this.fetcher(url, { headers, redirect: "manual", signal: combined });
    for (let redirects = 0; response.status >= 300 && response.status < 400; redirects++) {
      if (redirects >= 5) throw new Error("업데이트 다운로드 경로가 올바르지 않습니다.");
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("업데이트 다운로드 경로가 없습니다.");
      const target = new URL(location, url);
      if (target.protocol !== "https:" || target.username || target.password) throw new Error("안전하지 않은 업데이트 다운로드 경로입니다.");
      url = target.href;
      response = await this.fetcher(url, { headers: { "User-Agent": "Ghost-Updater", Accept: headers.Accept }, redirect: "manual", signal: combined });
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`업데이트 서버에 연결하지 못했습니다. (${response.status})`); }
    if (Number(response.headers.get("content-length")) > cap) { await response.body?.cancel(); throw new Error("업데이트 파일이 너무 큽니다."); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("업데이트 응답이 비어 있습니다.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > cap) throw new Error("업데이트 파일이 너무 큽니다.");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    return Buffer.concat(chunks, length);
  }

  async release(tag?: string, signal?: AbortSignal): Promise<GitHubRelease> {
    const suffix = tag ? `tags/${encodeURIComponent(tag)}` : "latest";
    const bytes = await this.request(`https://api.github.com/repos/${this.repository}/releases/${suffix}`, 2 * 1024 * 1024, signal);
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value.tag_name !== "string" || !Array.isArray(value.assets) || value.assets.length > 1000) throw new Error("릴리스 정보가 올바르지 않습니다.");
    const seen = new Set<string>();
    for (const asset of value.assets) {
      if (!asset || typeof asset.name !== "string" || seen.has(asset.name) || typeof asset.url !== "string" || !Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error("릴리스 파일 정보가 올바르지 않습니다.");
      const url = new URL(asset.url);
      if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`/repos/${this.repository}/releases/assets/`) || url.search || url.hash) throw new Error("릴리스 파일 경로가 올바르지 않습니다.");
      seen.add(asset.name);
    }
    return value as GitHubRelease;
  }

  async asset(release: GitHubRelease, name: string, cap: number, signal?: AbortSignal): Promise<Uint8Array> {
    const asset = release.assets.find((entry) => entry.name === name);
    if (!asset || asset.size > cap) throw new Error("업데이트 파일을 찾을 수 없습니다.");
    return this.request(asset.url, cap, signal, true, name !== "ghost-release.json" && name !== "ghost-release.json.sig");
  }

  async manifest(release: GitHubRelease, pubkey: string, signal?: AbortSignal): Promise<{ manifest: ReleaseManifest; bytes: string; signature: string }> {
    const [bytes, sig] = await Promise.all([this.asset(release, "ghost-release.json", 1024 * 1024, signal), this.asset(release, "ghost-release.json.sig", 16 * 1024, signal)]);
    const signature = new TextDecoder().decode(sig);
    if (!verifyMinisign(pubkey, signature, bytes)) throw new Error("업데이트 서명을 확인하지 못했습니다.");
    const manifest = parseManifest(bytes);
    if (release.tag_name !== `v${manifest.version}`) throw new Error("업데이트 버전이 일치하지 않습니다.");
    return { manifest, bytes: new TextDecoder().decode(bytes), signature };
  }
}
