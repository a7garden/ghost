import { invalid } from "../../core/errors.ts";
import { normalizeOrigin, validateTotp } from "./model.ts";

export interface ImportedLogin { title: string; origin: string; username: string; password: string; totp?: string }
/** RFC4180 parser with Shade's strict quote placement and whole-file bounds. No row values in errors. */
export function parseCsv(csv: string): { rows: ImportedLogin[]; rejected: number } {
  if (typeof csv !== "string" || !csv.length || Buffer.byteLength(csv) > 1024 * 1024 || csv.includes("\0")) throw invalid("invalid vault CSV size or content");
  const text = csv.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [], field = "", state: "start" | "plain" | "quoted" | "closed" = "start";
  const endField = () => { record.push(field); field = ""; state = "start"; };
  const endRecord = () => { endField(); if (record.some((s) => s.length) || record.length > 1) records.push(record); record = []; if (records.length > 10001) throw invalid("vault CSV row limit exceeded"); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === "quoted") {
      if (char === '"') state = "closed"; else field += char;
    } else if (state === "closed" && char === '"') { field += char; state = "quoted"; }
    else if (char === ",") endField();
    else if (char === "\r" || char === "\n") { endRecord(); if (char === "\r" && text[i + 1] === "\n") i++; }
    else if (state === "closed" || (state === "plain" && char === '"')) throw invalid("invalid vault CSV quoting");
    else if (state === "start" && char === '"') state = "quoted";
    else { field += char; state = "plain"; }
  }
  if (state === "quoted") throw invalid("invalid vault CSV quoting");
  if (field.length || record.length || state === "closed") endRecord();
  const headers = records.shift();
  if (!headers || !records.length || headers.length > 128 || headers.some((s) => Buffer.byteLength(s) > 2048)) throw invalid("invalid vault CSV headers");
  const normalized = headers.map((s) => s.trim().toLowerCase());
  if (new Set(normalized).size !== normalized.length || !["url", "username", "password"].every((s) => normalized.includes(s)) || (normalized.includes("title") && normalized.includes("name"))) throw invalid("invalid vault CSV headers");
  const rows: ImportedLogin[] = [];
  let rejected = 0;
  for (const values of records) {
    if (values.length !== headers.length) throw invalid("invalid vault CSV record");
    const get = (name: string) => values[normalized.indexOf(name)] ?? "";
    const raw = get("url"), title = get("title") || get("name"), username = get("username"), password = get("password");
    if (Buffer.byteLength(title) > 256 || Buffer.byteLength(username) > 512 || Buffer.byteLength(raw) > 8192) { rejected++; continue; }
    if (values.some((s) => Buffer.byteLength(s) > 65536)) throw invalid("invalid vault CSV record");
    try {
      if (!password || /[\s\p{Cc}\\]/u.test(raw) || !raw.startsWith("https://")) throw invalid("unsupported vault CSV row");
      const url = new URL(raw), authority = raw.slice(8).split(/[/?#]/, 1)[0]!;
      if (!authority || /[@%]/.test(authority) || url.username || url.password) throw invalid("unsupported vault CSV row");
      const origin = normalizeOrigin(url.origin);
      if (origin.length > 512) throw invalid("unsupported vault CSV row");
      const otp = get("otpauth");
      if (otp) validateTotp(otp);
      rows.push({ title: title.trim() ? title : origin, username, origin, password, ...(otp ? { totp: otp } : {}) });
    } catch { rejected++; }
  }
  return { rows, rejected };
}
