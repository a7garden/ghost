import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { HerdrChat, HerdrChatItem } from "@ghost/contract";

const WINDOW = 1024 * 1024;
const HEAD = 8 * 1024;
const MAX_TOOL_CALLS = 256;
const MAX_CHECKPOINTS = 32;
const ANCHOR = 64;
const LF = 10;
type Source = NonNullable<HerdrChat["source"]>;
type SessionRef = { agent: string; kind: string; value: string };
type RecordObject = Record<string, unknown>;
type Tool = Extract<HerdrChatItem, { kind: "tool" }>;
type Context = { title: string | null; tools: Map<string, Tool> };
type Checkpoint = Context & { ref: SessionRef; path: string; identity: string; cursor: number; anchor: Buffer };

const object = (value: unknown): value is RecordObject => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): string => typeof value === "string" ? value : "";

export function emptyHerdrChat(pane: string): HerdrChat {
  return { pane, source: null, title: null, items: [], cursor: "0", reset: false };
}

async function confined(root: string, path: string): Promise<string | null> {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  const resolved = await realpath(path).catch(() => null);
  if (!resolved?.endsWith(".jsonl")) return null;
  const rel = relative(root, resolved);
  return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) ? resolved : null;
}

async function locate(root: string, ref: SessionRef, previous?: Checkpoint): Promise<string | null> {
  if (ref.kind === "path") return confined(root, ref.value);
  if (ref.agent !== "claude" || ref.kind !== "id" || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.value)) return null;
  if (previous?.ref.kind === ref.kind && previous.ref.value === ref.value) {
    const cached = await confined(root, previous.path);
    if (cached) return cached;
  }
  let found: string | null = null;
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    const path = await confined(root, join(root, dir.name, `${ref.value}.jsonl`));
    if (!path) continue;
    if (found !== null && found !== path) return null; // An ambiguous ID is not a pane-specific record.
    found = path;
  }
  return found;
}

async function bytes(file: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < length) {
    const step = await file.read(buffer, count, length - count, start + count);
    if (step.bytesRead === 0) break;
    count += step.bytesRead;
  }
  return count === length ? buffer : buffer.subarray(0, count);
}

/** Project text only; never return raw records, injected context, tool inputs other than a summary, or model metadata. */
function displayText(value: string, inline = false, limit = HEAD): string {
  let clean = value
    .replace(/<(system-reminder|developer-instructions|project-context|harness-context|local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|user-prompt-submit-hook|injected-context)(?:\s[^>]*)?>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/^\s*# Task\r?\n([\s\S]*?)\r?\n\r?\n# Rules\r?\n- Work only inside the current directory; follow its AGENTS\.md and project conventions\.[\s\S]*$/, "$1")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/gi, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9_./+=~%-]{8,}/gi, "$1 [redacted]")
    .replace(/((?:\b(?:[\w-]*[_-])?(?:api[_-]?key|token|secret|password|passwd|credential)|--(?:key|token|password|secret))\b["']?\s*(?:[=:]\s*|\s+))(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, "$1[redacted]")
    .replace(/(\b[a-z][a-z+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:sk-[\w-]{12,}|(?:gh[pousr]_|github_pat_|xox[baprs]-|AIza)[\w-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[redacted]")
    .trim();
  if (inline) clean = clean.split(/\r?\n/, 1)[0]!.trim();
  if (Buffer.byteLength(clean) <= limit) return clean;
  const encoded = Buffer.from(clean);
  let end = limit - 3;
  while ((encoded[end]! & 0xc0) === 0x80) end--;
  return `${encoded.toString("utf8", 0, end)}…`;
}

function date(value: unknown): number | null {
  const parsed = typeof value === "string" ? Date.parse(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function eachLine(data: Buffer, start: number, visit: (record: RecordObject, offset: number) => void): number {
  let from = 0;
  for (let to = data.indexOf(LF); to >= 0; to = data.indexOf(LF, from)) {
    let record: unknown;
    try { record = JSON.parse(data.toString("utf8", from, to)); } catch { /* An invalid complete record is not a message. */ }
    if (object(record)) visit(record, start + from);
    from = to + 1;
  }
  return start + from;
}

function collect(data: Buffer, start: number, emitFrom: number, source: Source, context: Context, items: HerdrChatItem[]): number {
  const emitted = new Map<string, number>();
  function result(key: unknown, error: unknown, visible: boolean) {
    const call = context.tools.get(string(key));
    if (!call || typeof error !== "boolean" || call.ok === !error) return;
    const next = { ...call, ok: !error };
    context.tools.set(string(key), next);
    if (!visible) return;
    const index = emitted.get(call.id);
    if (index === undefined) {
      emitted.set(call.id, items.length);
      items.push(next);
    } else items[index] = next;
  }

  return eachLine(data, start, (record, offset) => {
    if (record.type === "title" || record.type === "title_change" || record.type === "custom-title") {
      const title = displayText(string(record.title ?? record.customTitle), true);
      if (title) context.title = title;
      return;
    }
    const visible = offset >= emitFrom;
    if ((source === "omp" && record.type === "compaction") || (source === "claude" && record.type === "system" && record.subtype === "compact_boundary")) {
      if (visible) items.push({ id: `${offset}:0`, at: date(record.timestamp), kind: "note", text: "대화 기록 압축" });
      return;
    }
    // omp custom_message records carry harness events, not user or agent turns.
    if (record.isSidechain === true || record.isMeta === true || record.isCompactSummary === true || !object(record.message)) return;
    if (source === "omp" ? record.type !== "message" : record.type !== "user" && record.type !== "assistant") return;
    const message = record.message;
    const at = date(record.timestamp) ?? date(message.timestamp);
    if (source === "omp" && message.role === "toolResult") {
      result(message.toolCallId, message.isError, visible);
      return;
    }
    if (message.role !== "user" && message.role !== "assistant") return;
    const kind = message.role === "user" ? "user" : "agent";
    const content = message.content;
    if (typeof content === "string" && visible) {
      const text = displayText(content);
      if (text) items.push({ id: `${offset}:0`, kind, at, text });
    }
    if (!Array.isArray(content)) return;
    for (const [index, block] of content.entries()) {
      if (!object(block)) continue;
      const id = `${offset}:${index}`;
      if (visible && block.type === "text") {
        const text = displayText(string(block.text));
        if (text) items.push({ id, kind, at, text });
      } else if (kind === "agent" && (block.type === "thinking" || block.type === "redacted_thinking")) {
        if (visible) items.push({ id, kind: "thinking", at });
      } else if (kind === "agent" && block.type === (source === "omp" ? "toolCall" : "tool_use")) {
        const name = displayText(string(block.name), true, 128);
        const key = string(block.id);
        if (!name || !key) continue;
        const args = source === "omp" ? block.arguments : block.input;
        const summary = object(args) ? displayText(string(args.command ?? args.file_path ?? args.path ?? args.filePath), true, 512) : "";
        const item: Tool = { id, kind: "tool", name, summary, ok: null, at };
        if (context.tools.size >= MAX_TOOL_CALLS) context.tools.delete(context.tools.keys().next().value!);
        context.tools.set(key, item);
        if (visible) {
          emitted.set(id, items.length);
          items.push(item);
        }
      } else if (source === "claude" && kind === "user" && block.type === "tool_result") {
        result(block.tool_use_id, block.is_error ?? false, visible);
      }
    }
  });
}

/** A bounded read of the transcript named by herdr, with enough context to resolve results across polls. */
export class HerdrChatReader {
  private readonly checkpoints = new Map<string, Checkpoint>();
  constructor(private readonly home = homedir()) {}

  async read(pane: string, ref: SessionRef | null, after: string | null, key = pane): Promise<HerdrChat> {
    const unavailable = emptyHerdrChat(pane);
    if (ref?.agent !== "omp" && ref?.agent !== "claude") return unavailable;
    const source = ref.agent;
    const previous = this.checkpoints.get(key);
    let file: FileHandle | undefined;
    try {
      const home = await realpath(this.home);
      const root = join(home, ...(source === "omp" ? [".omp", "agent", "sessions"] : [".claude", "projects"]));
      if (await realpath(root) !== root) return unavailable;
      const path = await locate(root, ref, previous);
      if (!path || !(await stat(path)).isFile()) return unavailable;
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await file.stat();
      const now = await stat(path);
      if (!st.isFile() || now.dev !== st.dev || now.ino !== st.ino || await confined(root, path) !== path) return unavailable;
      const { size } = st;
      const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
      const requested = after !== null && /^\d{1,16}$/.test(after) ? Number(after) : null;
      const same = previous?.path === path && previous.identity === identity;
      const unchanged = same && previous.cursor <= size && previous.anchor.equals(await bytes(file, previous.cursor - previous.anchor.length, previous.anchor.length));
      const reset = after !== null && (requested === null || !Number.isSafeInteger(requested) || requested > size ||
        (previous !== undefined && !unchanged) || (requested > 0 && (await bytes(file, requested - 1, 1))[0] !== LF));
      const context: Context = { title: unchanged ? previous.title : null, tools: new Map() };
      const items: HerdrChatItem[] = [];
      const emitFrom = reset || !requested ? Math.max(0, size - WINDOW) : requested;
      let start = emitFrom;
      if (!reset && requested && unchanged && previous.cursor === requested) {
        context.tools = new Map(previous.tools);
      } else if (!reset && requested) {
        start = Math.max(0, requested - WINDOW);
      }
      // The current omp title lives in a padded head record that can change without changing file size.
      if (start > 0 && source === "omp") eachLine(await bytes(file, 0, Math.min(HEAD, size)), 0, (record) => {
        if (record.type === "title") context.title = displayText(string(record.title), true) || context.title;
      });

      // Read lookbehind only on a cold or out-of-order continuation, then parse at most one MiB of new records.
      async function window(from: number, to: number): Promise<number> {
        let data = await bytes(file!, from, to - from);
        if (from > 0 && (await bytes(file!, from - 1, 1))[0] !== LF) {
          const first = data.indexOf(LF);
          if (first < 0) return 0;
          from += first + 1;
          data = data.subarray(first + 1);
        }
        return collect(data, from, emitFrom, source, context, items);
      }
      if (start < emitFrom) await window(start, emitFrom);
      let cursor = await window(emitFrom, Math.min(size, emitFrom + WINDOW));
      // One oversized delta record must not stall pagination. Skip it only after seeing its final newline.
      if (requested && !reset && cursor === requested && size > requested + WINDOW) {
        for (let offset = requested + WINDOW; offset < size; offset += WINDOW) {
          const chunk = await bytes(file, offset, Math.min(WINDOW, size - offset));
          const end = chunk.indexOf(LF);
          if (end >= 0) { cursor = offset + end + 1; break; }
        }
      }
      const anchorStart = Math.max(0, cursor - ANCHOR);
      const anchor = await bytes(file, anchorStart, cursor - anchorStart);
      this.checkpoints.delete(key);
      if (this.checkpoints.size >= MAX_CHECKPOINTS) this.checkpoints.delete(this.checkpoints.keys().next().value!);
      this.checkpoints.set(key, { ...context, ref, path, identity, cursor, anchor });
      return { pane, source, title: context.title, items, cursor: String(cursor), reset };
    } catch (error) {
      if (!object(error) || typeof error.code !== "string") throw error;
      return unavailable;
    } finally {
      await file?.close();
    }
  }
}
