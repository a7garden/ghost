import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ReleaseManifest } from "./github.ts";

export interface IosInstall {
  token: string;
  origin: string;
  manifest: ReleaseManifest & { ios: NonNullable<ReleaseManifest["ios"]> };
  expiresAt: number;
}

/** A link pins its verified release for all three OTA requests, even after another check. */
export class IosTokens {
  private readonly entries: IosInstall[] = [];
  constructor(private readonly now: () => number) {}

  private prune(): void {
    const now = this.now();
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i]!.expiresAt <= now) this.entries.splice(i, 1);
  }

  issue(origin: string, manifest: IosInstall["manifest"]): IosInstall {
    this.prune();
    if (this.entries.length >= 16) this.entries.shift();
    const entry = { token: randomBytes(32).toString("base64url"), origin, manifest, expiresAt: this.now() + 15 * 60_000 };
    this.entries.push(entry);
    return entry;
  }

  get(token: string | null): IosInstall | null {
    this.prune();
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const candidate = Buffer.from(token);
    let found: IosInstall | null = null;
    for (const entry of this.entries) if (timingSafeEqual(candidate, Buffer.from(entry.token))) found = entry;
    return found;
  }

  clear(): void { this.entries.length = 0; }
}

export function iosUrl(entry: IosInstall, path: string): string {
  return `${entry.origin}/api/update/ios/${path}?t=${encodeURIComponent(entry.token)}`;
}

export function iosLink(entry: IosInstall): { install: string; page: string } {
  return { install: `itms-services://?action=download-manifest&url=${encodeURIComponent(iosUrl(entry, "manifest.plist"))}`, page: iosUrl(entry, "install") };
}

const XML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** Safe for XML text and quoted HTML/XML attributes. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ENTITIES[character]!);
}

export function iosPlist(entry: IosInstall): string {
  const { ios } = entry.manifest;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict><key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${escapeXml(iosUrl(entry, "Ghost.ipa"))}</string></dict></array><key>metadata</key><dict><key>bundle-identifier</key><string>${escapeXml(ios.bundleId)}</string><key>bundle-version</key><string>${escapeXml(ios.version)}</string><key>kind</key><string>software</string><key>title</key><string>Ghost</string></dict></dict></array></dict></plist>`;
}

export function iosPage(entry: IosInstall): string {
  const title = escapeXml(`Ghost 앱 ${entry.manifest.ios.version} (${entry.manifest.ios.build})`);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem}h1{font-size:1.5rem}a{display:inline-block;padding:.8rem 1.5rem;border:1px solid currentColor;border-radius:.5rem;color:inherit}</style></head><body><h1>${title}</h1><a href="${escapeXml(iosLink(entry).install)}">설치</a></body></html>`;
}
