import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../core/errors.ts";
import type { MessageVerificationCode } from "./ports.ts";

/** Seconds between the Unix epoch and Apple's 2001-01-01 epoch used by Messages `date`. */
const APPLE_EPOCH_OFFSET = 978_307_200;
const MAX_CODES = 10;
/** Rows scanned per read; the window is at most an hour, so this bounds a pathological inbox. */
const ROW_LIMIT = 1000;
/** typedstream blobs beyond the first 16 KiB are attachment metadata, never the text body. */
const MAX_BLOB_BYTES = 16_384;
const MAX_STRING_BYTES = 4096;

export interface ReadVerificationCodesInput {
  /** Messages store to read; production uses ~/Library/Messages/chat.db. Tests inject fixtures. */
  dbPath?: string;
  /** Only rows newer than this many minutes (1–60). */
  withinMinutes: number;
  /** Optional case-insensitive substring the sender address must contain. */
  senderContains?: string;
  /** Reference time in ms; defaults to now. Tests inject it. */
  now?: number;
}

const fullDiskAccessError = () =>
  new CommandError(
    "unavailable",
    `Messages needs Full Disk Access for ${process.execPath}: System Settings › Privacy & Security › Full Disk Access, then restart Ghost`,
  );

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const isFilesystemPermissionError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EPERM" || code === "EACCES";
};

/**
 * Apple epoch (2001-01-01) to Unix ms. Modern rows store nanoseconds, very old rows seconds;
 * SQLite may hand 64-bit dates across as BigInt when they exceed JavaScript's safe range.
 */
const toMillis = (value: number | bigint): number => {
  const date = typeof value === "bigint" ? Number(value) : value;
  return APPLE_EPOCH_OFFSET * 1000 +
    (date >= 1e12 ? Math.round(date / 1e6) : Math.round(date * 1000));
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const TYPEDSTREAM_HEADER = Uint8Array.from([0x04, 0x0b, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x74, 0x79, 0x70, 0x65, 0x64]);
const NSSTRING_MARKER = Uint8Array.from([0x4e, 0x53, 0x53, 0x74, 0x72, 0x69, 0x6e, 0x67]);
const STRING_PAYLOAD_MARKER = Uint8Array.from([0x01, 0x94, 0x84, 0x01, 0x2b]);
const matchesAt = (bytes: Uint8Array, marker: Uint8Array, index: number) => {
  if (index + marker.length > bytes.length) return false;
  for (let offset = 0; offset < marker.length; offset++)
    if (bytes[index + offset] !== marker[offset]) return false;
  return true;
};

/** One length-prefixed string: 1 byte < 0x80, `0x81`+u16 LE or `0x82`+u32 LE. */
const stringCandidateAt = (
  bytes: Uint8Array,
  index: number,
): { start: number; length: number } | null => {
  const marker = bytes[index]!;
  let length: number;
  let start: number;
  if (marker < 0x80) {
    length = marker;
    start = index + 1;
  } else if (marker === 0x81 && index + 3 <= bytes.length) {
    length = bytes[index + 1]! | (bytes[index + 2]! << 8);
    start = index + 3;
  } else if (marker === 0x82 && index + 5 <= bytes.length) {
    length =
      bytes[index + 1]! |
      (bytes[index + 2]! << 8) |
      (bytes[index + 3]! << 16) |
      ((bytes[index + 4]! << 24) >>> 0);
    start = index + 5;
  } else {
    return null;
  }
  if (length < 1 || length > MAX_STRING_BYTES || start + length > bytes.length)
    return null;
  return { start, length };
};

const isPlausibleText = (text: string) =>
  text.length > 0 && !/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);

/**
 * Decode the message's first NSString payload from its bounded NSArchiver typedstream blob.
 * Refuse non-typedstream data and never scan arbitrary metadata strings as message text.
 * Malformed blobs yield null, never throw.
 */
const decodeTypedStream = (blob: unknown): string | null => {
  if (!(blob instanceof Uint8Array)) return null;
  const bytes = blob.subarray(0, Math.min(blob.length, MAX_BLOB_BYTES));
  if (!matchesAt(bytes, TYPEDSTREAM_HEADER, 0)) return null;

  let classIndex = -1;
  for (let index = TYPEDSTREAM_HEADER.length; index + NSSTRING_MARKER.length <= bytes.length; index++) {
    if (matchesAt(bytes, NSSTRING_MARKER, index)) {
      classIndex = index;
      break;
    }
  }
  if (classIndex < 0) return null;
  let payloadIndex = -1;
  const markerEnd = Math.min(bytes.length, classIndex + NSSTRING_MARKER.length + 64);
  for (
    let index = classIndex + NSSTRING_MARKER.length;
    index + STRING_PAYLOAD_MARKER.length <= markerEnd;
    index++
  ) {
    if (matchesAt(bytes, STRING_PAYLOAD_MARKER, index)) {
      payloadIndex = index + STRING_PAYLOAD_MARKER.length;
      break;
    }
  }
  if (payloadIndex < 0) return null;
  const candidate = stringCandidateAt(bytes, payloadIndex);
  if (!candidate) return null;
  try {
    const text = utf8.decode(bytes.subarray(candidate.start, candidate.start + candidate.length));
    return isPlausibleText(text) ? text : null;
  } catch {
    return null;
  }
};

/** Verification-specific cues; a bare code word is accepted only with a matching action context. */
const VERIFICATION_HINT =
  /인증(?:번호)?|본인\s*확인|일회용|보안\s*코드|\b(?:verification|security|authentication|one[- ]time|login|otp|passcode|2fa)\b|\bg-[0-9]{4,8}\b/i;
const GENERIC_CODE_CONTEXT =
  /\bcode\b.{0,80}\b(?:sign[ -]?in|confirm(?:ation)?|expires?|valid\s+for|do not share|don't share|never share)\b|\b(?:sign[ -]?in|confirm(?:ation)?|expires?|valid\s+for|do not share|don't share|never share)\b.{0,80}\bcode\b/i;
const GENERIC_CONTEXT_WORD =
  /\b(?:code|sign[ -]?in|confirm(?:ation)?|expires?|valid\s+for|do not share|don't share|never share)\b/gi;
/** G-prefixed and dashed codes normalize to their 4–8 digits. */
const CODE_PATTERN =
  /(g-[0-9]{4,8}|(?<![0-9])[0-9]{3}-[0-9]{3}|(?<![0-9])[0-9]{4,8})(?![0-9])/gi;

const normalizeCode = (raw: string) =>
  raw.startsWith("G-") || raw.startsWith("g-")
    ? raw.slice(2)
    : raw.includes("-")
      ? raw.replaceAll("-", "")
      : raw;

/** Prefer digits near verification-specific context; generic `code` needs an action cue. */
const extractCode = (text: string): { code: string; index: number } | null => {
  const hints = [...text.matchAll(new RegExp(VERIFICATION_HINT.source, "gi"))];
  const genericContext = GENERIC_CODE_CONTEXT.test(text);
  if (hints.length === 0 && !genericContext) return null;
  if (genericContext) hints.push(...text.matchAll(GENERIC_CONTEXT_WORD));
  const candidates = [...text.matchAll(CODE_PATTERN)];
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hint of hints) {
    const after = hint.index + hint[0].length;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.index - after);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }
  return { code: normalizeCode(best[0]), index: best.index };
};

/** At most 160 characters around the code, whitespace collapsed. */
const excerptOf = (text: string, index: number, code: string) => {
  const room = Math.max(0, 160 - code.length);
  const start = Math.max(0, Math.min(index - Math.floor(room / 2), Math.max(0, text.length - 160)));
  return text.slice(start, start + 160).replace(/\s+/g, " ").trim();
};

interface MessageRow {
  date: number | bigint;
  handleId: number | null;
  service: string | null;
  sender: string | null;
  text?: string | null;
  body?: Uint8Array | null;
  assoc?: number | null;
}

/** SQLite opens the live store read-only, so one connection provides a WAL-consistent view. */
const withMessagesDatabase = <T>(dbPath: string, run: (db: Database) => T): T => {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    throw new CommandError(
      "unavailable",
      `SQLite could not open Messages for ${process.execPath} (${messageOf(error)}). Check Full Disk Access in System Settings › Privacy & Security › Full Disk Access; if access is already enabled, close and reopen Messages, then restart Ghost.`,
    );
  }
  try {
    return run(db);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(
      "unavailable",
      `SQLite could not read Messages for ${process.execPath} (${messageOf(error)}). Check Full Disk Access in System Settings › Privacy & Security › Full Disk Access; if access is already enabled, close and reopen Messages, then restart Ghost.`,
    );
  } finally {
    db.close();
  }
};

/**
 * Read verification codes from recent incoming Messages rows. Reads only: no WAL checkpoint, no
 * write to the real store; codes never leave the tool result.
 */
export async function readVerificationCodes(
  input: ReadVerificationCodesInput,
): Promise<{ codes: MessageVerificationCode[] }> {
  const withinMinutes = input.withinMinutes;
  if (!Number.isInteger(withinMinutes) || withinMinutes < 1 || withinMinutes > 60)
    throw new CommandError("invalid", "within_minutes must be an integer from 1 to 60");
  const dbPath = input.dbPath ?? join(homedir(), "Library/Messages/chat.db");
  const needle = input.senderContains?.toLowerCase();
  const at = input.now ?? Date.now();
  const secondsCutoff = Math.floor(at / 1000) - APPLE_EPOCH_OFFSET - withinMinutes * 60;
  const nanosCutoff = secondsCutoff * 1_000_000_000;

  try {
    statSync(dbPath);
  } catch (error) {
    if (isFilesystemPermissionError(error)) throw fullDiskAccessError();
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
      throw new CommandError("unavailable", `Messages database not found: ${dbPath}`);
    throw new CommandError("unavailable", `Could not inspect Messages database: ${messageOf(error)}`);
  }

  const codes = withMessagesDatabase(dbPath, (db) => {
    const messageColumns = new Set(
      (db.query("PRAGMA table_info(message)").all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );
    if (
      !messageColumns.has("date") ||
      !messageColumns.has("is_from_me") ||
      (!messageColumns.has("text") && !messageColumns.has("attributedBody"))
    )
      throw new CommandError("unavailable", "Messages database schema not recognized");
    const hasHandleTable = (
      db.query("PRAGMA table_info(handle)").all() as { name: string }[]
    ).some((column) => column.name === "id");
    const columns = ["m.date AS date", "m.handle_id AS handleId", "m.service AS service"];
    if (messageColumns.has("text")) columns.push("m.text AS text");
    if (messageColumns.has("attributedBody")) columns.push("m.attributedBody AS body");
    if (messageColumns.has("associated_message_type"))
      columns.push("m.associated_message_type AS assoc");
    if (hasHandleTable) columns.push("h.id AS sender");
    const rows = db
      .query(
        `SELECT ${columns.join(", ")}
         FROM message m
         ${hasHandleTable ? "LEFT JOIN handle h ON h.ROWID = m.handle_id" : ""}
         WHERE m.is_from_me = 0 AND
           ((m.date < 1000000000000 AND m.date >= ?) OR
            (m.date >= 1000000000000 AND m.date >= ?))
         ORDER BY m.date DESC
         LIMIT ${ROW_LIMIT}`,
      )
      .all(secondsCutoff, nanosCutoff) as MessageRow[];
    const extracted: MessageVerificationCode[] = [];
    for (const row of rows) {
      // Tapbacks and reactions carry associated_message_type 2000–3999; skip when the column exists.
      if (
        typeof row.assoc === "number" &&
        row.assoc >= 2000 &&
        row.assoc <= 3999
      )
        continue;
      const sender = row.sender ?? "";
      if (needle && !sender.toLowerCase().includes(needle)) continue;
      const text = row.text?.trim() ? row.text : decodeTypedStream(row.body);
      if (!text) continue;
      const code = extractCode(text);
      if (!code) continue;
      extracted.push({
        code: code.code,
        sender,
        service: row.service ?? "",
        receivedAt: toMillis(row.date),
        excerpt: excerptOf(text, code.index, code.code),
      });
    }
    // Mixed nanosecond and second rows cannot be ordered by the raw column; normalize first.
    extracted.sort((a, b) => b.receivedAt - a.receivedAt);
    return extracted.slice(0, MAX_CODES);
  });
  return { codes };
}
