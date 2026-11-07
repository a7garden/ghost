import { validate, type Decision, type Space } from "@ghost/contract";
import { Type } from "typebox";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Core } from "../core/core.ts";
import { sha256 } from "../core/ids.ts";
import type { DocumentProposal, DocumentsPort, Page, PageMeta } from "./ports.ts";

/**
 * Portable Document Contract vault access.
 *
 * The file in the Space is canonical. New pages are written as PDC 2
 * (`pdc-markdown/1` by default, `pdc-html/1` when authored HTML matters);
 * PDC 1 documents and unmarked legacy files stay readable and are never
 * rewritten or converted. Edits keep the page's own body profile and use
 * compare-before-replace on the source hash.
 */
const PDC2_MARKDOWN = "pdc-markdown/1";
const PDC2_HTML = "pdc-html/1";
const PDC1_DJOT = "pdc-djot/1";
const PDC1_HTML = "pdc-html/1";
const UNCLASSIFIED = "unclassified";

const VAULT_FORMAT = "pdc-vault/1";
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 640;
const MAX_LIST_ITEMS = 10_000;
const MAX_DEPTH = 64;

type YamlValue = string | boolean | number | null | YamlValue[] | YamlMap;
interface YamlMap {
  [key: string]: YamlValue;
}

/** The vault manifest of a space. */
const VaultManifest = Type.Object({
  format: Type.Literal(VAULT_FORMAT),
  id: Type.String(),
  created: Type.String(),
});

/** The proposal payload of a document decision, in the host's camel case spelling. */
const ProposalPayload = Type.Object({
  spaceId: Type.String({ minLength: 1 }),
  title: Type.String(),
  body: Type.String(),
  profile: Type.String(),
  pageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expectedHash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** The same payload in the snake case spelling the ledger uses elsewhere. */
const SnakeCaseProposalPayload = Type.Object({
  space_id: Type.String({ minLength: 1 }),
  title: Type.String(),
  body: Type.String(),
  profile: Type.String(),
  page_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  expected_hash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

/** Outcome classes named exactly as the contract requires (PDC 2 §13). */
type DiagnosticKind =
  | "invalid_transport"
  | "invalid_envelope"
  | "unsupported_document_version"
  | "unsupported_body_version"
  | "invalid_document_id"
  | "duplicate_block_id"
  | "document_too_large"
  | "document_too_complex"
  | "unsafe_content"
  | "external_change_conflict";

interface PdcDiagnostic {
  kind: DiagnosticKind;
  message: string;
}

function diagnostic(kind: DiagnosticKind, message: string): PdcDiagnostic {
  return { kind, message };
}

/** The envelope's nesting cap (safe general-YAML 1.2 Core, PDC 2 §5). */
const MAX_YAML_DEPTH = 32;
/** Maximum open block containers in a Djot body (PDC 2 §4.2–4.3). */
const MAX_TARGET_DEPTH = 256;

/**
 * The result of classifying one file against the contract. Canonical v2
 * documents are rewritable; legacy v1 documents and unmarked files stay
 * readable and read-only.
 */
export type PdcClassification =
  | {
      outcome: "valid";
      profile: string;
      legacy: boolean;
      documentId: string;
      /** Byte offset of the body inside the source. */
      bodyStart: number;
    }
  | { outcome: "legacy_html" }
  | { outcome: "legacy_markdown" }
  | { outcome: "invalid"; diagnostic: PdcDiagnostic };

/** One classified file in a vault. */
interface VaultPage {
  locator: string;
  hash: string;
  title: string;
  profile: string;
  legacy: boolean;
  /** True only for a canonical PDC 2 document this host may rewrite. */
  editable: boolean;
  documentId: string | null;
  body: string;
  deleted: boolean;
  /** Human-readable reason the page is not a canonical PDC 2 document. */
  diagnostic: string | null;
}

interface SourceLine {
  start: number;
  end: number;
  next: number;
  raw: string;
}

/** Canonical lowercase hyphenated UUID with a version nibble of 1–8. */
function isCanonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** Canonical UTC millisecond timestamp with a real calendar date. */
function isCanonicalTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{3}Z$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth[month - 1]!) return false;
  return Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, the only timestamp the envelope accepts. */
function canonicalTimestamp(at = new Date()): string {
  return `${at.toISOString().slice(0, 23)}Z`;
}

function splitLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") {
      lines.push({ start, end: index, next: index + 1, raw: text.slice(start, index) });
      start = index + 1;
    }
  }
  if (start < text.length) lines.push({ start, end: text.length, next: text.length, raw: text.slice(start) });
  return lines;
}

function normalized(line: SourceLine): string {
  return line.raw.endsWith("\r") ? line.raw.slice(0, -1) : line.raw;
}

/** A PDC envelope located inside a source file. */
interface Envelope {
  /** Envelope content lines, without the opening and closing fences. */
  lines: string[];
  /** Byte offset of the body inside the source. */
  bodyStart: number;
}

type TransportResult = Envelope | "plain" | { diagnostic: PdcDiagnostic };

/** The Markdown transport: `---` at byte 0, closed by the next exact `---` line. */
function markdownEnvelope(lines: SourceLine[]): TransportResult {
  if (lines.length === 0 || normalized(lines[0]!) !== "---") return "plain";
  const close = lines.findIndex((line, index) => index > 0 && normalized(line) === "---");
  if (close < 0) {
    return { diagnostic: diagnostic("invalid_transport", "frontmatter delimiter is never closed; expected a second `---` line") };
  }
  return { lines: lines.slice(1, close).map((line) => line.raw), bodyStart: lines[close]!.next };
}

/** The HTML transport: `<!--`, `---`, the envelope, `---`, `-->`. */
function htmlEnvelope(lines: SourceLine[]): TransportResult {
  if (lines.length < 2 || normalized(lines[0]!) !== "<!--" || normalized(lines[1]!) !== "---") return "plain";
  const close = lines.findIndex((line, index) => index > 1 && normalized(line) === "---");
  if (close < 0) return { diagnostic: diagnostic("invalid_transport", "envelope is never closed; expected `---` and `-->` lines") };
  const closer = lines[close + 1];
  if (!closer || normalized(closer) !== "-->") {
    return {
      diagnostic: diagnostic("invalid_transport", "the `---` envelope closer must be immediately followed by `-->`"),
    };
  }
  for (const line of lines.slice(2, close)) {
    const content = normalized(line);
    if (content.includes("-->") || content.includes("--!>")) {
      return {
        diagnostic: diagnostic("invalid_transport", "envelope contains an earlier `-->`/`--!>` sequence"),
      };
    }
  }
  return { lines: lines.slice(2, close).map((line) => line.raw), bodyStart: lines[close + 1]!.next };
}

/** The Djot transport is PDC 1 only: a `---` envelope, never a rewritten target. */
function djotEnvelope(lines: SourceLine[]): Envelope | { diagnostic: PdcDiagnostic } {
  if (lines.length === 0 || normalized(lines[0]!) !== "---") {
    return {
      diagnostic: diagnostic(
        "invalid_transport",
        "frontmatter-free .djot is valid upstream Djot but invalid PDC transport",
      ),
    };
  }
  const close = lines.findIndex((line, index) => index > 0 && normalized(line) === "---");
  if (close < 0) return { diagnostic: diagnostic("invalid_transport", "envelope is never closed; expected a second `---` line") };
  return { lines: lines.slice(1, close).map((line) => line.raw), bodyStart: lines[close]!.next };
}

/** Parses one plain or quoted scalar. */
function parseScalar(raw: string): YamlValue {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the lenient reading below.
    }
    return text.slice(1, text.endsWith('"') && text.length > 1 ? -1 : undefined);
  }
  if (text.startsWith("'")) {
    const end = text.length > 1 && text.endsWith("'") ? text.length - 1 : text.length;
    return text.slice(1, end).replace(/''/g, "'");
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  // A plain scalar ends at an inline comment.
  const comment = text.indexOf(" #");
  return comment >= 0 ? text.slice(0, comment).trimEnd() : text;
}

/** Parses a flow sequence of scalars, e.g. `["a", "b"]`. */
function parseFlowSequence(raw: string): YamlValue[] | null {
  if (!raw.startsWith("[") || !raw.endsWith("]")) return null;
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const items: YamlValue[] = [];
  let current = "";
  let quote: string | null = null;
  for (const character of inner) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      items.push(parseScalar(current));
      current = "";
      continue;
    }
    current += character;
  }
  items.push(parseScalar(current));
  return items;
}

/**
 * Parses the safe YAML 1.2 Core subset the envelope allows: unique string
 * keys, JSON-compatible values, comments and nesting. Anchors, aliases and
 * tags are refused; nesting is capped.
 */
function parseEnvelope(lines: string[], depth = 1): { map: YamlMap } | { diagnostic: PdcDiagnostic } {
  if (depth > MAX_YAML_DEPTH) {
    return { diagnostic: diagnostic("document_too_complex", `nesting exceeds the ${MAX_YAML_DEPTH}-level limit`) };
  }
  const map: YamlMap = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    const leading = line.length - line.trimStart().length;
    if (leading > 0 && line.slice(0, leading).includes("\t")) {
      return { diagnostic: diagnostic("invalid_envelope", "tab indentation is forbidden in the envelope") };
    }
    if (leading > 0) return { diagnostic: diagnostic("invalid_envelope", "the envelope must not start with an indented line") };
    const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(\s.*|)$/.exec(line);
    if (!match) return { diagnostic: diagnostic("invalid_envelope", `malformed envelope line: ${trimmed.slice(0, 48)}`) };
    const key = match[1]!;
    if (key in map) return { diagnostic: diagnostic("invalid_envelope", `duplicate envelope key: ${key}`) };
    const raw = (match[2] ?? "").trim();
    if (raw === "") {
      const nested = parseNested(lines, index + 1, depth);
      if ("diagnostic" in nested) return nested;
      map[key] = nested.value;
      index = nested.next;
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const sequence = parseFlowSequence(raw);
      if (!sequence) return { diagnostic: diagnostic("invalid_envelope", `malformed envelope value for ${key}`) };
      map[key] = sequence;
    } else if (raw.startsWith("{")) {
      return { diagnostic: diagnostic("invalid_envelope", `unsupported envelope value for ${key}`) };
    } else if (raw.startsWith("&") || raw.startsWith("*") || raw.startsWith("!")) {
      return { diagnostic: diagnostic("invalid_envelope", `anchors, aliases and tags are not allowed (${key})`) };
    } else {
      map[key] = parseScalar(raw);
    }
    index += 1;
  }
  return { map };
}

/** Parses an indented block under a key: a sequence or a nested map. */
function parseNested(
  lines: string[],
  start: number,
  depth: number,
): { value: YamlValue; next: number } | { diagnostic: PdcDiagnostic } {
  let index = start;
  let indent = 0;
  const block: string[] = [];
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      block.push(line);
      index += 1;
      continue;
    }
    const leading = line.length - line.trimStart().length;
    if (leading === 0) break;
    if (leading > 0 && line.slice(0, leading).includes("\t")) {
      return { diagnostic: diagnostic("invalid_envelope", "tab indentation is forbidden in the envelope") };
    }
    if (block.length === 0) indent = leading;
    if (leading < indent) break;
    block.push(line.slice(indent));
    index += 1;
  }
  while (block.length > 0 && block[block.length - 1]!.trim() === "") block.pop();
  if (block.length === 0) return { value: null, next: index };
  if (block.every((line) => line.trimStart().startsWith("- ") || line.trim() === "-")) {
    const items = block
      .filter((line) => line.trim() !== "")
      .map((line) => parseScalar(line.trim().slice(1).trim()));
    return { value: items, next: index };
  }
  const nested = parseEnvelope(block, depth + 1);
  if ("diagnostic" in nested) return nested;
  return { value: nested.map, next: index };
}

function stringField(map: YamlMap, key: string): string | null {
  const value = map[key];
  return typeof value === "string" ? value : null;
}

function booleanField(map: YamlMap, key: string): boolean | null {
  const value = map[key];
  return typeof value === "boolean" ? value : null;
}

function isStringSequence(value: YamlValue | undefined): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The version suffix of a known body profile, e.g. `1` for `pdc-djot/1`. */
function knownBodyProfile(value: string): string | null {
  const match = /^pdc-(?:markdown|html|djot)\/(\d+)$/.exec(value);
  return match ? match[1]! : null;
}

/**
 * The `body` field must name this transport's canonical profile. An unknown
 * version of a known profile is its own diagnostic; a known profile in the
 * wrong transport is a transport error.
 */
function checkBodyProfile(value: YamlValue | undefined, expected: string): PdcDiagnostic | null {
  if (typeof value !== "string") {
    return diagnostic("invalid_envelope", "required field `body` is missing or not a string");
  }
  const version = knownBodyProfile(value);
  if (version === null) return diagnostic("unsupported_body_version", `\`body\` names an unknown profile \`${value}\``);
  if (version !== "1") {
    return diagnostic("unsupported_body_version", `\`body\` names an unsupported version \`${value}\``);
  }
  if (value !== expected) {
    return diagnostic("invalid_transport", `\`body\` must be exactly \`${expected}\` in this transport`);
  }
  return null;
}

/** The envelope semantics shared by both generations. */
function validateEnvelopeSemantics(
  map: YamlMap,
): { id: string; title: string; deleted: boolean } | { diagnostic: PdcDiagnostic } {
  const id = stringField(map, "id");
  if (id === null) return { diagnostic: diagnostic("invalid_envelope", "required field `id` is missing or not a string") };
  if (!isCanonicalUuid(id)) {
    return { diagnostic: diagnostic("invalid_document_id", "`id` must be a canonical lowercase hyphenated UUID") };
  }
  const created = stringField(map, "created");
  if (created === null) return { diagnostic: diagnostic("invalid_envelope", "required field `created` is missing or not a string") };
  if (!isCanonicalTimestamp(created)) {
    return { diagnostic: diagnostic("invalid_envelope", "`created` must be a canonical UTC millisecond timestamp") };
  }
  const updated = stringField(map, "updated");
  if (updated === null) return { diagnostic: diagnostic("invalid_envelope", "required field `updated` is missing or not a string") };
  if (!isCanonicalTimestamp(updated)) {
    return { diagnostic: diagnostic("invalid_envelope", "`updated` must be a canonical UTC millisecond timestamp") };
  }
  if (updated < created) {
    return { diagnostic: diagnostic("invalid_envelope", "`updated` must not be earlier than `created`") };
  }
  const title = stringField(map, "title");
  if (title === null) return { diagnostic: diagnostic("invalid_envelope", "required field `title` is missing or not a string") };

  for (const key of ["profile", "lang"]) {
    const value = map[key];
    if (value !== undefined && typeof value !== "string") {
      return { diagnostic: diagnostic("invalid_envelope", `\`${key}\` must be a string`) };
    }
  }
  for (const key of ["tags", "aliases", "cssclasses"]) {
    const value = map[key];
    if (value !== undefined && !isStringSequence(value)) {
      return { diagnostic: diagnostic("invalid_envelope", `\`${key}\` must be a string sequence`) };
    }
  }
  for (const key of ["favorite", "deleted"]) {
    const value = map[key];
    if (value !== undefined && typeof value !== "boolean") {
      return { diagnostic: diagnostic("invalid_envelope", `\`${key}\` must be a Boolean`) };
    }
  }
  const deleted = booleanField(map, "deleted") ?? false;
  const deletedAt = map["deleted_at"];
  if (deletedAt !== undefined && typeof deletedAt !== "string") {
    return { diagnostic: diagnostic("invalid_envelope", "`deleted_at` must be a string timestamp") };
  }
  if (deleted && deletedAt === undefined) {
    return { diagnostic: diagnostic("invalid_envelope", "`deleted: true` requires a matching `deleted_at` timestamp") };
  }
  if (!deleted && deletedAt !== undefined) {
    return { diagnostic: diagnostic("invalid_envelope", "`deleted_at` must be absent unless `deleted` is true") };
  }
  if (deleted && typeof deletedAt === "string" && !isCanonicalTimestamp(deletedAt)) {
    return { diagnostic: diagnostic("invalid_envelope", "`deleted_at` must be a canonical UTC millisecond timestamp") };
  }
  return { id, title, deleted };
}

/** The v2 envelope semantics shared by the Markdown and HTML transports. */
function validateV2(
  map: YamlMap,
  expectedProfile: string,
): { id: string; title: string; deleted: boolean } | { diagnostic: PdcDiagnostic } {
  const format = stringField(map, "format");
  if (format === null) {
    return { diagnostic: diagnostic("invalid_envelope", "required field `format` is missing or not a string") };
  }
  if (format !== "pdc-document/2") {
    if (format === "pdc-document/1") {
      return { diagnostic: diagnostic("invalid_transport", "`pdc-document/1` is legacy and predates this transport") };
    }
    return { diagnostic: diagnostic("unsupported_document_version", "`format` names an unsupported major version") };
  }
  const bodyError = checkBodyProfile(map["body"], expectedProfile);
  if (bodyError) return { diagnostic: bodyError };
  return validateEnvelopeSemantics(map);
}

/**
 * The v1 (legacy) envelope semantics. The constrained v1 grammar forbids
 * comments; such documents stay readable and read-only.
 */
function validateV1(
  map: YamlMap,
  expectedProfile: string,
): { id: string; title: string; deleted: boolean } | { diagnostic: PdcDiagnostic } {
  const format = stringField(map, "format");
  if (format === null) {
    return { diagnostic: diagnostic("invalid_envelope", "required field `format` is missing or not a string") };
  }
  if (format !== "pdc-document/1") {
    return { diagnostic: diagnostic("unsupported_document_version", "`format` must be exactly `pdc-document/1`") };
  }
  const bodyError = checkBodyProfile(map["body"], expectedProfile);
  if (bodyError) return { diagnostic: bodyError };
  return validateEnvelopeSemantics(map);
}

/** The v1 grammar forbids comments: they are not part of the envelope grammar. */
function v1ForbidsComments(lines: string[]): PdcDiagnostic | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.includes(" #")) {
      return diagnostic("invalid_envelope", "comments are not part of the v1 envelope grammar");
    }
  }
  return null;
}

/** Active HTML constructs are never acceptable in a canonical body. */
const UNSAFE_ELEMENTS: Record<string, true> = {
  script: true,
  iframe: true,
  object: true,
  embed: true,
  applet: true,
  base: true,
  link: true,
};
const NAV_ATTRIBUTES: Record<string, true> = {
  href: true,
  src: true,
  action: true,
  formaction: true,
  "xlink:href": true,
};

interface BodyScan {
  unsafe: boolean;
  blockIds: string[];
}

/** Scans one authored HTML body for nonconforming constructs and block targets. */
function scanHtmlBody(body: string): BodyScan {
  const scan: BodyScan = { unsafe: false, blockIds: [] };
  let index = 0;
  while (index < body.length) {
    if (body.startsWith("<!--", index)) {
      const end = body.indexOf("-->", index + 4);
      if (end < 0) break;
      index = end + 3;
      continue;
    }
    if (body[index] === "<") {
      const next = body[index + 1];
      if (next === "!" || next === "?") {
        const end = body.indexOf(">", index + 1);
        index = end < 0 ? body.length : end + 1;
        continue;
      }
      if (next === "/" || (next !== undefined && /[A-Za-z]/.test(next))) {
        const end = tagEnd(body, index);
        scanTag(body.slice(index + 1, end), scan);
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return scan;
}

function tagEnd(text: string, open: number): number {
  let quote: string | null = null;
  for (let index = open; index < text.length; index++) {
    const character = text[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return text.length;
}

function scanTag(tag: string, scan: BodyScan): void {
  const nameEnd = tag.search(/[\s>/]/);
  const name = (nameEnd < 0 ? tag : tag.slice(0, nameEnd)).toLowerCase();
  if (UNSAFE_ELEMENTS[name]) scan.unsafe = true;
  let rest = nameEnd < 0 ? "" : tag.slice(nameEnd);
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest === "") return;
    const attrEnd = rest.search(/[\s=]/);
    const attribute = (attrEnd < 0 ? rest : rest.slice(0, attrEnd)).toLowerCase();
    rest = attrEnd < 0 ? "" : rest.slice(attrEnd);
    let value = "";
    if (rest.startsWith("=")) {
      rest = rest.slice(1).replace(/^\s+/, "");
      const quote = rest[0];
      if (quote === '"' || quote === "'") {
        const close = rest.indexOf(quote, 1);
        value = close < 0 ? rest.slice(1) : rest.slice(1, close);
        rest = close < 0 ? "" : rest.slice(close + 1);
      } else {
        const space = rest.search(/\s/);
        value = space < 0 ? rest : rest.slice(0, space);
        rest = space < 0 ? "" : rest.slice(space);
      }
    }
    if (attribute === "id" && value.length === 38 && value.startsWith("b-") && isCanonicalUuid(value.slice(2))) {
      scan.blockIds.push(value.slice(2));
    }
    if (attribute.length > 2 && attribute.startsWith("on") && /^[a-z]+$/.test(attribute.slice(2))) scan.unsafe = true;
    if (NAV_ATTRIBUTES[attribute]) {
      const lower = value.trim().toLowerCase();
      if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) scan.unsafe = true;
    }
    if (name === "meta" && attribute === "http-equiv") scan.unsafe = true;
  }
}

/** Scans one Markdown body: fenced code is opaque, raw HTML outside it is inspected. */
function scanMarkdownBody(body: string): BodyScan {
  const scan: BodyScan = { unsafe: false, blockIds: [] };
  let fenceCharacter: string | null = null;
  let fenceLength = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();
    const marker = trimmed[0];
    if (fenceCharacter === null && (marker === "`" || marker === "~")) {
      const run = marker.length === 0 ? 0 : trimmed.length - trimmed.replace(new RegExp(`^\\${marker}+`), "").length;
      if (run >= 3) {
        fenceCharacter = marker;
        fenceLength = run;
        continue;
      }
    }
    if (fenceCharacter !== null) {
      const closing = line.trim();
      if (
        closing.startsWith(fenceCharacter.repeat(fenceLength)) &&
        closing.replace(new RegExp(`^\\${fenceCharacter}+`), "").trim() === ""
      ) {
        fenceCharacter = null;
        fenceLength = 0;
      }
      continue;
    }
    const visible = stripInlineCode(line);
    const caret = caretIdOfLine(visible);
    if (caret) scan.blockIds.push(caret);
    scanRawHtml(visible, scan);
  }
  return scan;
}

/** Removes inline code span contents so code samples never contribute constructs. */
function stripInlineCode(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let run = 0;
      while (line[index + run] === "`") run += 1;
      const closing = line.indexOf("`".repeat(run), index + run);
      if (closing < 0) return result;
      index = closing + run;
      continue;
    }
    result += line[index];
    index += 1;
  }
  return result;
}

/** The trailing caret block id of a line, `^` followed by `[A-Za-z0-9-]+`. */
function caretIdOfLine(visible: string): string | null {
  const tokens = visible.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last || !last.startsWith("^")) return null;
  const id = last.slice(1);
  return /^[A-Za-z0-9-]+$/.test(id) ? id : null;
}

/** Raw HTML inside Markdown: active constructs are unsafe, other raw HTML is preserved. */
function scanRawHtml(visible: string, scan: BodyScan): void {
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== "<") continue;
    const next = visible[index + 1];
    if (next === undefined || !/[A-Za-z/]/.test(next)) continue;
    if (next === "/") continue;
    const end = tagEnd(visible, index);
    scanTag(visible.slice(index + 1, end), scan);
    index = end;
  }
}

function hasDuplicate(ids: string[]): boolean {
  const seen = new Set<string>();
  return ids.some((id) => (seen.has(id) ? true : (seen.add(id), false)));
}

/** Scans a Djot body: any raw HTML is nonconforming, `{#b-<uuid>}` targets are collected. */
function scanDjotBody(body: string): BodyScan & { tooComplex: boolean } {
  const scan: BodyScan & { tooComplex: boolean } = { unsafe: false, blockIds: [], tooComplex: false };
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();
    const marker = trimmed[0];
    if (marker !== "`" && marker !== "~") {
      if (fence !== null) continue;
    } else {
      const run = trimmed.length - trimmed.replace(new RegExp(`^\\${marker}+`), "").length;
      if (run >= 3) {
        if (fence === null) {
          const info = trimmed.slice(run).trim();
          if (info === "=html" || info.startsWith("=html ")) {
            scan.unsafe = true;
            return scan;
          }
          fence = marker;
          continue;
        }
        if (marker === fence && trimmed.slice(run).trim() === "") {
          fence = null;
          continue;
        }
      }
    }
    if (fence !== null) continue;
    // Block-quote nesting is bounded.
    let depth = 0;
    let rest = line;
    for (;;) {
      const next = rest.replace(/^ ?/, "");
      if (!next.startsWith(">")) break;
      depth += 1;
      rest = next.slice(1);
    }
    if (depth > MAX_TARGET_DEPTH) scan.tooComplex = true;
    if (inlineRawHtml(line)) scan.unsafe = true;
    collectDjotBlockIds(line, scan.blockIds);
  }
  return scan;
}

/** Raw inline HTML for one Djot line, skipping inline code spans; autolinks are not raw. */
function inlineRawHtml(line: string): boolean {
  const visible = stripInlineCode(line);
  for (let index = 0; index < visible.length; index++) {
    if (visible[index] !== "<") continue;
    const next = visible[index + 1];
    if (next === "/" || next === "!") return true;
    if (next !== undefined && /[A-Za-z]/.test(next)) {
      const rest = visible.slice(index + 1);
      const schemeLength = rest.length - rest.replace(/^[\w.+-]+/, "").length;
      if (rest[schemeLength] !== ":") return true;
    }
  }
  return false;
}

/** Djot block-target IDs: `{#b-<uuid>}` block attributes. */
function collectDjotBlockIds(line: string, ids: string[]): void {
  let rest = line;
  for (;;) {
    const open = rest.indexOf("{#b-");
    if (open < 0) return;
    const after = rest.slice(open + 4);
    const close = after.indexOf("}");
    if (close < 0) return;
    const candidate = after.slice(0, close);
    if (isCanonicalUuid(candidate)) ids.push(candidate);
    rest = after.slice(close);
  }
}

/** Classifies one file against the contract; the vault projection is built on top of it. */
export function classifyDocument(locator: string, bytes: Uint8Array): PdcClassification {
  const extension = locator.slice(locator.lastIndexOf(".") + 1).toLowerCase();
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return { outcome: "invalid", diagnostic: diagnostic("document_too_large", `document exceeds the ${MAX_DOCUMENT_BYTES}-byte limit`) };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { outcome: "invalid", diagnostic: diagnostic("invalid_transport", "document is not valid UTF-8") };
  }
  if (text.startsWith("﻿")) {
    return { outcome: "invalid", diagnostic: diagnostic("invalid_transport", "byte-order mark present") };
  }
  const lines = splitLines(text);

  if (extension === "md") {
    const envelope = markdownEnvelope(lines);
    if (envelope === "plain") return { outcome: "legacy_markdown" };
    if ("diagnostic" in envelope) return { outcome: "invalid", diagnostic: envelope.diagnostic };
    return classifyTransport(text, envelope, PDC2_MARKDOWN, false);
  }
  if (extension === "html") {
    const envelope = htmlEnvelope(lines);
    if (envelope === "plain") return { outcome: "legacy_html" };
    if ("diagnostic" in envelope) return { outcome: "invalid", diagnostic: envelope.diagnostic };
    if (declaresV2(envelope.lines)) return classifyTransport(text, envelope, PDC2_HTML, false);
    return classifyTransport(text, envelope, PDC1_HTML, true);
  }
  if (extension === "djot") {
    const envelope = djotEnvelope(lines);
    if (!("lines" in envelope)) return { outcome: "invalid", diagnostic: envelope.diagnostic };
    return classifyTransport(text, envelope, PDC1_DJOT, true);
  }
  return { outcome: "invalid", diagnostic: diagnostic("invalid_transport", "unsupported document extension") };
}

/** Classifies one envelope: v2 semantics for canonical documents, v1 semantics for legacy. */
function classifyTransport(
  text: string,
  envelope: Envelope,
  profile: string,
  legacy: boolean,
): PdcClassification {
  const body = text.slice(envelope.bodyStart);
  if (legacy) {
    const commentBan = v1ForbidsComments(envelope.lines);
    if (commentBan) return { outcome: "invalid", diagnostic: commentBan };
  }
  const parsed = parseEnvelope(envelope.lines);
  if ("diagnostic" in parsed) return { outcome: "invalid", diagnostic: parsed.diagnostic };
  const semantics = legacy ? validateV1(parsed.map, profile) : validateV2(parsed.map, profile);
  if ("diagnostic" in semantics) return { outcome: "invalid", diagnostic: semantics.diagnostic };

  if (profile === PDC1_DJOT) {
    const scan = scanDjotBody(body);
    if (scan.tooComplex) {
      return {
        outcome: "invalid",
        diagnostic: diagnostic("document_too_complex", `body nesting exceeds the ${MAX_TARGET_DEPTH}-level limit`),
      };
    }
    if (scan.unsafe) return { outcome: "invalid", diagnostic: diagnostic("unsafe_content", "the body contains raw HTML") };
    if (hasDuplicate(scan.blockIds)) {
      return { outcome: "invalid", diagnostic: diagnostic("duplicate_block_id", "two targets share one block ID") };
    }
  } else {
    const scan = profile === PDC2_HTML || profile === PDC1_HTML ? scanHtmlBody(body) : scanMarkdownBody(body);
    if (scan.unsafe) {
      return {
        outcome: "invalid",
        diagnostic: diagnostic("unsafe_content", "the body contains executable or otherwise nonconforming constructs"),
      };
    }
    if (hasDuplicate(scan.blockIds)) {
      return { outcome: "invalid", diagnostic: diagnostic("duplicate_block_id", "two targets share one block ID") };
    }
  }
  return { outcome: "valid", profile, legacy, documentId: semantics.id, bodyStart: envelope.bodyStart };
}

/** Lexical sniff: only a top-level plain or quoted `format` routes to the v2 pipeline. */
function declaresV2(envelopeLines: string[]): boolean {
  for (const line of envelopeLines) {
    const content = line.trimEnd();
    const trimmed = content.trimStart();
    if (trimmed === "" || trimmed.startsWith("#") || content.length !== trimmed.length) continue;
    const colon = content.indexOf(":");
    if (colon < 0) continue;
    if (content.slice(0, colon).trim() !== "format") continue;
    const value = content.slice(colon + 1).trim().split(" #")[0]!.trim();
    return value.replace(/^["']|["']$/g, "") === "pdc-document/2";
  }
  return false;
}

/** Builds the vault projection of one file from its classification. */
function classify(locator: string, bytes: Uint8Array): VaultPage {
  const hash = sha256(bytes);
  const base: VaultPage = {
    locator,
    hash,
    title: locator.slice(locator.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""),
    profile: UNCLASSIFIED,
    legacy: false,
    editable: false,
    documentId: null,
    body: "",
    deleted: false,
    diagnostic: null,
  };
  const classified = classifyDocument(locator, bytes);
  switch (classified.outcome) {
    case "legacy_markdown":
      return { ...base, legacy: true, diagnostic: "legacy_markdown: readable without conversion" };
    case "legacy_html":
      return { ...base, legacy: true, diagnostic: "legacy_html: readable without conversion" };
    case "invalid":
      return { ...base, diagnostic: `${classified.diagnostic.kind}: ${classified.diagnostic.message}` };
    case "valid": {
      const text = decodeSource(bytes);
      const body = text.slice(classified.bodyStart);
      const envelope = parseEnvelopeOf(text);
      const title = envelope ? stringField(envelope.map, "title") : null;
      const deleted = envelope ? booleanField(envelope.map, "deleted") ?? false : false;
      return {
        ...base,
        title: title !== null && title !== "" ? title : base.title,
        profile: classified.profile,
        legacy: classified.legacy,
        editable: !classified.legacy,
        documentId: classified.documentId,
        body,
        deleted,
        diagnostic: null,
      };
    }
  }
}

/** The parsed envelope of a classified source, for projections and patches. */
function parseEnvelopeOf(text: string): { map: YamlMap } | null {
  const lines = splitLines(text);
  if (lines.length === 0) return null;
  const isHtml = normalized(lines[0]!) === "<!--";
  const first = isHtml ? 2 : 1;
  const close = lines.findIndex((line, index) => index >= first && normalized(line) === "---");
  if (close < 0) return null;
  const parsed = parseEnvelope(lines.slice(first, close).map((line) => line.raw));
  return "diagnostic" in parsed ? null : parsed;
}

function decodeSource(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The canonical body: UTF-8 without a BOM, LF endings, one trailing newline. */
function canonicalBody(body: string): string {
  if (body.startsWith("﻿") || body.includes("\r")) {
    throw new Error("canonical PDC 2 bodies must use UTF-8 without a BOM and LF line endings");
  }
  if (body === "") return "";
  return `${body.replace(/\n+$/, "")}\n`;
}

/** Renders one envelope value with minimal quoting. */
function renderValue(value: string): string {
  const needsQuote =
    value === "" ||
    value.trim() !== value ||
    value === "true" ||
    value === "false" ||
    value.includes(": ") ||
    value.includes(" #") ||
    /[[\]{}"',|]/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Byte offset of the body inside a source that carries an envelope. */
function bodyOffsetOf(source: string): number {
  const lines = splitLines(source);
  if (lines.length === 0) return source.length;
  const isHtml = normalized(lines[0]!) === "<!--";
  const first = isHtml ? 2 : 1;
  const close = lines.findIndex((line, index) => index >= first && normalized(line) === "---");
  if (close < 0) return source.length;
  return isHtml ? lines[close + 1]!.next : lines[close]!.next;
}

/**
 * Patches envelope metadata in place, preserving every untouched byte. Existing
 * keys are rewritten on their own line; missing keys are appended before the
 * closing fence. A patch that changes nothing returns the source unchanged.
 *
 * Only canonical PDC 2 documents may be patched: legacy and unmarked sources
 * are read-only, invalid sources refuse lossless edits.
 */
export function patchDocumentMetadata(
  locator: string,
  source: string,
  patch: { key: string; value: string }[],
): string {
  const classified = classifyDocument(locator, new TextEncoder().encode(source));
  if (classified.outcome === "legacy_html" || classified.outcome === "legacy_markdown") {
    throw new Error("legacy_document_read_only: create a separate PDC 2 target after backup");
  }
  if (classified.outcome === "invalid") {
    throw new Error(`unsupported_lossless_edit: ${classified.diagnostic.kind}`);
  }
  if (classified.legacy) {
    throw new Error("legacy_document_read_only: create a separate PDC 2 target after backup");
  }
  return patchMetadata(source, patch);
}

/** Compare-before-replace: refuses when the source bytes changed since the snapshot. */
export function saveGuarded(snapshot: Uint8Array, current: Uint8Array, next: Uint8Array): Uint8Array {
  if (Buffer.compare(Buffer.from(snapshot), Buffer.from(current)) !== 0) {
    throw new Error("external_change_conflict: source bytes changed externally since editing began");
  }
  return next;
}

/**
 * Patches envelope metadata in place, preserving every untouched byte. Existing
 * keys are rewritten on their own line; missing keys are appended before the
 * closing fence.
 */
function patchMetadata(source: string, patch: { key: string; value: string }[]): string {
  const lines = splitLines(source);
  if (lines.length === 0) throw new Error("the document has no PDC envelope to patch");
  const isHtml = normalized(lines[0]!) === "<!--";
  const first = isHtml ? 2 : 1;
  const close = lines.findIndex((line, index) => index >= first && normalized(line) === "---");
  if (close < 0) throw new Error("the document has no PDC envelope to patch");
  const envelopeLines = lines.slice(first, close).map((line) => line.raw);
  const edits = new Map<number, string>();
  const appended: string[] = [];
  for (const { key, value } of patch) {
    const rendered = renderValue(value);
    const index = envelopeLines.findIndex((line) => {
      const colon = line.indexOf(":");
      return colon > 0 && line.slice(0, colon).trim() === key;
    });
    if (index < 0) {
      appended.push(`${key}: ${rendered}`);
      continue;
    }
    const content = envelopeLines[index]!;
    const colon = content.indexOf(":");
    const whitespace = /^\s*/.exec(content.slice(colon + 1))![0];
    edits.set(index, `${content.slice(0, colon + 1)}${whitespace}${rendered}`);
  }
  if (edits.size === 0 && appended.length === 0) return source;
  const updated = [...envelopeLines];
  for (const [index, content] of edits) updated[index] = content;
  if (appended.length > 0) updated.push(...appended);
  const envelope = updated.map((line) => `${line}\n`).join("");
  const body = source.slice(bodyOffsetOf(source));
  return isHtml ? `<!--\n---\n${envelope}---\n-->\n${body}` : `---\n${envelope}---\n${body}`;
}

/** Builds the bytes of a new PDC 2 document. */
function newDocumentBytes(id: string, title: string, body: string, profile: string, created: string): Uint8Array {
  if (profile !== PDC2_MARKDOWN && profile !== PDC2_HTML) {
    throw new Error("new documents must use a PDC 2 Markdown or HTML profile");
  }
  const envelope = [
    "format: pdc-document/2",
    `body: ${profile}`,
    `id: ${id}`,
    `created: ${created}`,
    `updated: ${created}`,
    `title: ${JSON.stringify(title)}`,
  ].join("\n");
  const source =
    profile === PDC2_HTML ? `<!--\n---\n${envelope}\n---\n-->\n${body}` : `---\n${envelope}\n---\n${body}`;
  return new TextEncoder().encode(source);
}

/** Vault access over the Spaces the ledger knows. */
class VaultDocuments implements DocumentsPort {
  constructor(private readonly core: Core) {}

  spacesFor(ghostId: string): { space: Space; mode: "read" | "propose" }[] {
    const spaces: { space: Space; mode: "read" | "propose" }[] = [];
    for (const space of this.core.ledger.spaces()) {
      const grant = space.grants.find((item) => item.ghostId === ghostId);
      if (grant) spaces.push({ space, mode: grant.mode });
    }
    return spaces;
  }

  async listPages(spaceId: string, query: string | null): Promise<PageMeta[]> {
    const space = this.requireSpace(spaceId);
    const needle = (query ?? "").toLowerCase();
    const pages: PageMeta[] = [];
    for (const page of this.scan(space)) {
      if (needle !== "") {
        const source = this.readBytes(space, page.locator);
        const haystack = `${page.title}\n${page.locator}\n${new TextDecoder().decode(source)}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      pages.push({
        pageId: page.documentId ?? page.locator,
        locator: page.locator,
        title: page.title,
        profile: page.profile,
      });
    }
    return pages;
  }

  async readPage(spaceId: string, ref: { pageId?: string; locator?: string }): Promise<Page> {
    const space = this.requireSpace(spaceId);
    if (ref.locator) return this.toPage(this.project(space, ref.locator));
    if (!ref.pageId) throw new Error("a page reference needs a page id or a locator");
    const matches = this.scan(space).filter((page) => page.documentId === ref.pageId || page.locator === ref.pageId);
    if (matches.length !== 1) throw new Error("document missing or duplicate_document_id");
    return this.toPage(this.project(space, matches[0]!.locator));
  }

  /** Validates a proposal without writing; it throws when the proposal can never apply. */
  async check(proposal: DocumentProposal): Promise<void> {
    const space = this.requireSpace(proposal.spaceId);
    this.checkProfile(proposal.profile);
    this.checkTitle(proposal.title);
    this.checkBody(proposal.body);
    if (proposal.pageId === null) {
      if (proposal.expectedHash !== null) throw new Error("a new page must not carry an expected hash");
      return;
    }
    if (proposal.expectedHash === null) throw new Error("editing a page requires the hash it was read with");
    const page = this.project(space, this.locate(space, proposal.pageId));
    if (!page.editable) {
      if (page.legacy) throw new Error("legacy_document_read_only: create a separate PDC 2 target after backup");
      throw new Error(`unsupported_lossless_edit: ${page.diagnostic ?? "the page is not a canonical PDC 2 document"}`);
    }
    if (page.profile !== proposal.profile) {
      throw new Error(`an edit must keep the page's body profile (${page.profile})`);
    }
    if (page.hash !== proposal.expectedHash) {
      throw new Error("external_change_conflict: source changed; re-read before editing");
    }
  }

  /** Writes an approved `document_review` decision's proposal. */
  async apply(decision: Decision): Promise<string> {
    if (decision.state !== "approved") throw new Error("only an approved document decision can be applied");
    const proposal = parseProposal(decision.proposal);
    const space = this.requireSpace(proposal.spaceId);
    const grant = space.grants.find((item) => item.ghostId === decision.ghostId);
    if (!grant) throw new Error("this Ghost has no grant for this document space");
    if (grant.mode !== "propose") throw new Error("this Ghost may only read this document space");
    const page = await this.save(proposal);
    return proposal.pageId === null
      ? `Saved "${proposal.title}" as ${page.locator} in ${space.name}.`
      : `Updated "${proposal.title}" (${page.locator}) in ${space.name}.`;
  }

  /** The owner's direct write: the same checks and atomic path as an applied decision. */
  async save(proposal: DocumentProposal): Promise<Page> {
    const space = this.requireSpace(proposal.spaceId);
    await this.check(proposal);
    return proposal.pageId === null ? this.createPage(space, proposal) : this.updatePage(space, proposal);
  }

  /** Creates a new canonical PDC 2 page; the fresh UUIDv7 cannot clobber an existing file. */
  private async createPage(space: Space, proposal: DocumentProposal): Promise<Page> {
    const id = Bun.randomUUIDv7();
    const locator = `${id}.${proposal.profile === PDC2_HTML ? "html" : "md"}`;
    const bytes = newDocumentBytes(id, proposal.title, canonicalBody(proposal.body), proposal.profile, canonicalTimestamp());
    this.initializeVault(space);
    this.writeAtomic(this.safePath(space, locator), bytes, false);
    return this.toPage(this.project(space, locator));
  }

  /** Rewrites one canonical page in place, refusing an external change since the proposal. */
  private async updatePage(space: Space, proposal: DocumentProposal): Promise<Page> {
    if (proposal.pageId === null) throw new Error("editing a page requires the page it was read with");
    const locator = this.locate(space, proposal.pageId);
    const current = this.project(space, locator);
    if (current.hash !== proposal.expectedHash) {
      throw new Error("external_change_conflict: source changed; re-read before editing");
    }
    const snapshot = this.readBytes(space, locator);
    const source = new TextDecoder().decode(snapshot);
    const body = current.body === proposal.body ? current.body : canonicalBody(proposal.body);
    const patched = patchMetadata(source, [
      { key: "title", value: proposal.title },
      { key: "updated", value: canonicalTimestamp() },
    ]);
    const bodyStart = bodyOffsetOf(patched);
    const next = new TextEncoder().encode(`${patched.slice(0, bodyStart)}${body}`);
    this.initializeVault(space);
    // Compare-before-replace: the source must still be the bytes the proposal saw.
    saveGuarded(snapshot, this.readBytes(space, locator), next);
    this.writeAtomic(this.safePath(space, locator), next, true);
    return this.toPage(this.project(space, locator));
  }

  private toPage(page: VaultPage): Page {
    return {
      pageId: page.documentId ?? page.locator,
      locator: page.locator,
      title: page.title,
      profile: page.profile,
      body: page.body,
      hash: page.hash,
    };
  }

  private requireSpace(spaceId: string): Space {
    const space = this.core.ledger.spaces().find((item) => item.id === spaceId);
    if (!space) throw new Error("unknown document space");
    return space;
  }

  private checkProfile(profile: string): void {
    if (profile !== PDC2_MARKDOWN && profile !== PDC2_HTML) {
      throw new Error("new documents must use a PDC 2 Markdown or HTML profile");
    }
  }

  private checkTitle(title: string): void {
    if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH || /[\n\r\0]/.test(title)) {
      throw new Error("invalid document title");
    }
  }

  private checkBody(body: string): void {
    if (typeof body !== "string") throw new Error("invalid document body");
    if (Buffer.byteLength(body, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
    canonicalBody(body);
  }

  /** The locator of the page with this id, or the locator itself when it names a file. */
  private locate(space: Space, pageId: string): string {
    const matches = this.scan(space).filter((page) => page.documentId === pageId || page.locator === pageId);
    if (matches.length === 0) throw new Error("document missing");
    if (matches.length > 1) throw new Error("document missing or duplicate_document_id");
    return matches[0]!.locator;
  }

  /** Every document file in the space, sorted by locator. */
  private scan(space: Space): VaultPage[] {
    const root = space.path;
    const rootStat = lstatSync(root, { throwIfNoEntry: false });
    if (!rootStat) return [];
    if (rootStat.isSymbolicLink()) throw new Error("Space root must not be a symlink");
    const locators: string[] = [];
    const walk = (relative: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new Error("Space directory nesting exceeds its limit");
      if (locators.length >= MAX_LIST_ITEMS) throw new Error("Space listing exceeds its document limit; choose a narrower root");
      const directory = relative === "" ? root : join(root, relative);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = entry.name;
        if (name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) continue;
        const next = relative === "" ? name : `${relative}/${name}`;
        if (entry.isDirectory()) walk(next, depth + 1);
        else if (entry.isFile() && /\.(md|html|djot)$/i.test(name)) locators.push(next);
      }
    };
    walk("", 0);
    locators.sort();
    return locators.map((locator) => this.project(space, locator));
  }

  /** Classifies one file in the space. */
  private project(space: Space, locator: string): VaultPage {
    this.safePath(space, locator);
    return classify(locator, this.readBytes(space, locator));
  }

  private readBytes(space: Space, locator: string): Uint8Array {
    const path = this.safePath(space, locator);
    const bytes = readFileSync(path);
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
    return bytes;
  }

  /** Resolves a locator inside the space; symlinks are never followed. */
  private safePath(space: Space, locator: string): string {
    if (lstatSync(space.path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Space root must not be a symlink");
    const parts = locator.split("/");
    for (const part of parts) {
      if (part === "" || part === "." || part === ".." || part.startsWith(".")) throw new Error("invalid document locator");
    }
    let current = space.path;
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("document symlink is not followed");
    }
    return current;
  }

  /** Creates the vault manifest of a space without rewriting existing documents. */
  private initializeVault(space: Space): void {
    mkdirSync(space.path, { recursive: true });
    const meta = join(space.path, ".pdc");
    if (lstatSync(meta, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error("vault manifest directory must not be a symlink");
    }
    mkdirSync(meta, { recursive: true });
    const manifest = join(meta, "vault.json");
    if (existsSync(manifest)) {
      const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      const record = validate(VaultManifest, value) ? value : null;
      if (!record || !isCanonicalUuid(record.id) || !isCanonicalTimestamp(record.created)) {
        throw new Error("invalid vault manifest");
      }
      return;
    }
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ format: VAULT_FORMAT, id: Bun.randomUUIDv7(), created: canonicalTimestamp() }, null, 2)}\n`,
    );
    this.writeAtomic(manifest, bytes, false);
  }

  /** Writes bytes atomically: a temporary file in the same directory, then a rename. */
  private writeAtomic(path: string, bytes: Uint8Array, replace: boolean): void {
    const directory = path.slice(0, path.lastIndexOf("/"));
    const temporary = join(directory, `.ghost-${Bun.randomUUIDv7()}.tmp`);
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeSync(handle, bytes);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    try {
      if (!replace && existsSync(path)) throw new Error("existing target has different content; inspect before retry");
      renameSync(temporary, path);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
    try {
      const directoryHandle = openSync(directory, "r");
      fsyncSync(directoryHandle);
      closeSync(directoryHandle);
    } catch {
      // Directory syncing is best effort; the rename itself is atomic.
    }
  }
}

/** Reads the proposal payload of an approved document decision. */
function parseProposal(payload: unknown): DocumentProposal {
  if (validate(ProposalPayload, payload)) {
    return {
      spaceId: payload.spaceId,
      title: payload.title,
      body: payload.body,
      profile: payload.profile,
      pageId: payload.pageId ?? null,
      expectedHash: payload.expectedHash ?? null,
    };
  }
  if (validate(SnakeCaseProposalPayload, payload)) {
    return {
      spaceId: payload.space_id,
      title: payload.title,
      body: payload.body,
      profile: payload.profile,
      pageId: payload.page_id ?? null,
      expectedHash: payload.expected_hash ?? null,
    };
  }
  throw new Error("the document decision carries no usable proposal");
}

/** The document plane of the host, bound to the ledger's Spaces. */
export function createDocuments(core: Core): DocumentsPort {
  const port = new VaultDocuments(core);
  core.decisions.onDocumentApproved((decision) => port.apply(decision));
  return port;
}
