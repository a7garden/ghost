import { createHmac, randomBytes } from "node:crypto";
import { invalid } from "../../core/errors.ts";

/** Shade's HTTPS-only exact-origin contract, including rejection of URL-parser repairs. */
export function normalizeOrigin(raw: string): string {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 2048 || /[\s\p{Cc}\\]/u.test(raw) || !raw.startsWith("https://")) throw invalid("invalid vault origin");
  let url: URL;
  try { url = new URL(raw); } catch { throw invalid("invalid vault origin"); }
  const suffix = raw.slice(8);
  const slash = suffix.indexOf("/");
  const authority = suffix.split("/", 1)[0]!;
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || !["", "/"].includes(url.pathname) || url.search || url.hash || raw.includes("?") || raw.includes("#") || (slash >= 0 && suffix.slice(slash) !== "/") || !authority || /[@%]/.test(authority) || authority.endsWith(".") || url.hostname.endsWith(".")) throw invalid("invalid vault origin");
  return url.origin;
}

export const PASSWORD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}:,.?";
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 65536 || value.includes("\0")) throw invalid("invalid vault password");
}
export function generatePassword(length = 24): string {
  if (!Number.isInteger(length) || length < 16 || length > 256) throw invalid("invalid password length");
  const ceiling = 256 - 256 % PASSWORD_ALPHABET.length;
  let result = "";
  while (result.length < length) {
    const bytes = randomBytes(128);
    for (const byte of bytes) {
      if (byte < ceiling) result += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (result.length === length) break;
    }
    bytes.fill(0);
  }
  return result;
}

function base32(raw: string): Buffer {
  if (!/^[A-Z2-7]+={0,6}$/i.test(raw)) throw invalid("invalid vault TOTP");
  const text = raw.replace(/=+$/, "").toUpperCase();
  if (![0, 2, 4, 5, 7].includes(text.length % 8)) throw invalid("invalid vault TOTP");
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const char of text) {
    value = (value << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  if (!bytes.length || (bits && (value & ((1 << bits) - 1)))) throw invalid("invalid vault TOTP");
  return Buffer.from(bytes);
}
function totpConfig(input: string) {
  if (typeof input !== "string" || !input.length || Buffer.byteLength(input) > 65536) throw invalid("invalid vault TOTP");
  let seed = input, algorithm = "SHA1", digits = 6, period = 30;
  if (input.startsWith("otpauth://")) {
    let url: URL;
    try { url = new URL(input); } catch { throw invalid("invalid vault TOTP"); }
    if (url.hostname !== "totp" || url.username || url.password || url.hash || url.port) throw invalid("invalid vault TOTP");
    for (const name of ["secret", "algorithm", "digits", "period"]) if (url.searchParams.getAll(name).length > 1) throw invalid("invalid vault TOTP");
    seed = url.searchParams.get("secret") ?? "";
    algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    const rawDigits = url.searchParams.get("digits") ?? "6", rawPeriod = url.searchParams.get("period") ?? "30";
    if (!/^[0-9]+$/.test(rawDigits) || !/^[0-9]+$/.test(rawPeriod)) throw invalid("invalid vault TOTP");
    digits = Number(rawDigits); period = Number(rawPeriod);
  }
  if (!["SHA1", "SHA256", "SHA512"].includes(algorithm) || ![6, 8].includes(digits) || !Number.isSafeInteger(period) || period < 1) throw invalid("invalid vault TOTP");
  return { key: base32(seed), algorithm: algorithm.toLowerCase(), digits, period };
}
export function validateTotp(input: string) { const config = totpConfig(input); config.key.fill(0); }
/** at is Unix milliseconds, consistent with host timestamps. */
export function totp(input: string, at = Date.now()): string {
  if (!Number.isSafeInteger(at) || at < 0) throw invalid("invalid TOTP time");
  const { key, algorithm, digits, period } = totpConfig(input);
  try {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
    const mac = createHmac(algorithm, key).update(counter).digest();
    const offset = mac[mac.length - 1]! & 15;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
  } finally { key.fill(0); }
}
