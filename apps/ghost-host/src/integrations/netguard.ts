import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { forbidden, invalid } from "../core/errors.ts";

/** Hostnames that mean this machine or a link-local domain even before DNS. */
export const BLOCKED_HOSTNAMES: Record<string, true> = { localhost: true };
export const BLOCKED_SUFFIXES = [".local", ".internal", ".ts.net"];

/** IPv4 loopback, private, link-local, CGNAT, unspecified and this-network ranges. */
function blockedIpv4(groups: number[]): boolean {
  if (groups.length !== 4) return true;
  const [a, b, c, d] = groups;
  const ip = (((a ?? 0) << 24) | ((b ?? 0) << 16) | ((c ?? 0) << 8) | (d ?? 0)) >>> 0;
  const top = ip >>> 24;
  if (top === 0 || top === 127 || top === 10 || (ip >>> 16) === 0xa9fe || (ip >>> 16) === 0xc0a8) return true;
  if (top >= 224 || (ip >>> 24) === 198 && ((ip >>> 16) & 0xfe) === 18 || (ip >>> 8) === 0xc00000) return true;
  return ((ip & 0xfff00000) >>> 0) === 0xac100000 || ((ip & 0xffc00000) >>> 0) === 0x64400000;
}

/** IPv6 loopback, unspecified, link-local and ULA ranges; IPv4-mapped addresses defer to IPv4. */
function blockedIpv6(groups: number[]): boolean {
  if (groups.length !== 8) return true;
  const [first] = groups;
  if (first === undefined) return true;
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xfe00) === 0xfc00 || (first & 0xff00) === 0xff00) return true;
  if (first === 0x2002) return blockedIpv4([(groups[1] ?? 0) >> 8, (groups[1] ?? 0) & 255, (groups[2] ?? 0) >> 8, (groups[2] ?? 0) & 255]);
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return true;
  if (first !== 0) return false;
  const rest = groups.slice(1, 5);
  const [g5, g6, g7] = [groups[5] ?? 0, groups[6] ?? 0, groups[7] ?? 0];
  if (!rest.every((group) => group === 0)) return false;
  if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (g5 === 0xffff) return blockedIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]); // ::ffff:0:0/96
  if (g5 === 0) return true; // deprecated IPv4-compatible ::a.b.c.d
  return false;
}

/** Expands an IPv6 string (with `::` compression and an optional trailing IPv4 part) to 8 groups. */
function ipv6Groups(value: string): number[] | null {
  const cleaned = value.split("%")[0] ?? "";
  const compressed = cleaned.includes("::");
  const halves = cleaned.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ?? "";
  const tail = compressed ? (halves[1] ?? "") : "";
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === "" ? [] : tail.split(":");
  const lastParts = compressed ? tailParts : headParts;
  const dotted = lastParts.at(-1)?.includes(".") ? (lastParts.pop() ?? "") : null;
  const groups = [...headParts, ...tailParts].map((part) => (/^[0-9a-fA-F]{1,4}$/.test(part) ? parseInt(part, 16) : -1));
  if (groups.some((group) => group < 0)) return null;
  const missing = 8 - groups.length - (dotted === null ? 0 : 2);
  if (missing < 0 || (compressed ? missing === 0 : missing !== 0)) return null;
  if (dotted !== null) {
    const parts = dotted.split(".").map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : 256));
    if (parts.length !== 4 || parts.some((part) => part > 255)) return null;
    groups.push(((parts[0] ?? 0) << 8) | (parts[1] ?? 0), ((parts[2] ?? 0) << 8) | (parts[3] ?? 0));
  }
  return [...groups.slice(0, headParts.length), ...Array<number>(missing).fill(0), ...groups.slice(headParts.length)];
}

/** True when the address is a loopback, private, link-local, CGNAT or ULA literal. */
export function blockedAddress(address: string): boolean {
  const host = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  if (host.includes("%")) return true;
  if (isIP(host) === 4) {
    const groups = host.split(".").map((part) => Number(part));
    return groups.length !== 4 || groups.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || blockedIpv4(groups);
  }
  if (isIP(host) === 6) {
    const groups = ipv6Groups(host);
    return groups === null || blockedIpv6(groups);
  }
  return true;
}

/**
 * SSRF guard for every URL a model hands to web research: http/https only, never this machine
 * (localhost, *.local, *.internal, *.ts.net), never a private-range literal, and never a name
 * whose DNS answer is one. Returns the normalized URL to hand to the CLI.
 */
export async function assertFetchableUrl(raw: string, what: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid(`${what} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw forbidden(`${what} must be http or https; ${parsed.protocol.replace(":", "")} is refused`);
  const host = (parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "").replace(/\.$/, "");
  if (host === "") throw invalid(`${what} has no host`);
  if (BLOCKED_HOSTNAMES[host] || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw forbidden(`${what} points at ${host}, which is refused`);
  }
  if (isIP(host) !== 0) {
    if (blockedAddress(host)) throw forbidden(`${what} points at the private or loopback address ${host}, which is refused`);
    return parsed;
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    // Unresolvable: the CLI reports that itself, and DNS cannot smuggle a private address.
    return parsed;
  }
  const blocked = addresses.find((address) => blockedAddress(address.address));
  if (blocked) throw forbidden(`${what} resolves to the private or loopback address ${blocked.address}, which is refused`);
  return parsed;
}

