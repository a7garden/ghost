import { Buffer } from "node:buffer";
import { extname } from "node:path";
import type { ArtifactRef, DocRef, Live, LiveTool, Message, MessageOrigin, ToolCallView } from "@ghost/contract";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { ArtifactStore } from "../core/ports.ts";
import { CommandError } from "../core/errors.ts";
import { withoutClockStamp } from "../core/clock.ts";

/** Bounded preview of a tool call's arguments. */
const MAX_TOOL_ARGS = 4096;
/** Bounded live output of one tool call. */
const MAX_TOOL_OUTPUT = 16384;

/**
 * Marks the block that lists the artifacts of a message. It is appended to what the
 * model sees and cut again when the transcript is shown, so the owner sees their own
 * text and the attachments stay a separate field.
 */
export const ATTACHMENT_MARKER = "\n\n<attachments>\n";

/** What the host knows about a user message besides its text. */
export interface UserMeta {
  origin: MessageOrigin | null;
  attachments: ArtifactRef[];
  scopes?: { id: string; name: string }[];
  spaces?: { id: string; name: string }[];
  scopeId?: string | null;
  docAttachments?: DocRef[];
  text?: string;
}

/** The text of a message body, whatever shape it has. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** The reasoning blocks of an assistant body; redacted blocks carry no readable text. */
function thinkingOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as { type?: unknown; thinking?: unknown; redacted?: unknown };
    if (block.type === "thinking" && typeof block.thinking === "string" && block.redacted !== true && block.thinking.trim()) parts.push(block.thinking);
  }
  return parts.join("\n\n");
}

/** Bounded JSON preview of a tool call's arguments. */
function argumentsOf(call: ToolCall): string {
  try {
    return JSON.stringify(call.arguments ?? {}).slice(0, MAX_TOOL_ARGS);
  } catch {
    return "{}";
  }
}

/** The summary of a compaction is wrapped by Pi; the note shows the summary itself. */
const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

function stripSummary(text: string): string {
  if (!text.startsWith(SUMMARY_PREFIX) || !text.endsWith(SUMMARY_SUFFIX)) return text;
  return text.slice(SUMMARY_PREFIX.length, text.length - SUMMARY_SUFFIX.length);
}

/**
 * One Pi entry as a transcript message. `pi.system` and unknown kinds have no
 * transcript meaning and are dropped; a user message carries the origin and the
 * attachments the host recorded for it.
 */
export function toMessage(entry: EntryRecord, conversationId: string, userMeta: UserMeta | null): Message | null {
  const model = entry.model ?? [];
  const base = {
    id: String(entry.id),
    conversationId,
    origin: null,
    toolCalls: [] as ToolCallView[],
    tool: null,
    attachments: [] as ArtifactRef[],
  };
  switch (entry.kind) {
    case "pi.user": {
      const message = model.find((item): item is UserMessage => item.role === "user");
      const text = message ? textOf(message.content) : "";
      return {
        ...base,
        role: "user",
        origin: userMeta?.origin ?? null,
        text: userMeta?.text ?? withoutClockStamp(cutAttachmentBlock(text)),
        attachments: userMeta?.attachments ?? [],
        ...((userMeta?.scopes ?? userMeta?.spaces)?.length ? { scopes: userMeta?.scopes ?? userMeta?.spaces } : {}),
        ...(userMeta?.scopeId !== undefined ? { scopeId: userMeta.scopeId } : {}),
        ...(userMeta?.docAttachments ? { docAttachments: userMeta.docAttachments } : {}),
        createdAt: message?.timestamp ?? 0,
      };
    }
    case "pi.assistant": {
      const message = model.find((item): item is AssistantMessage => item.role === "assistant");
      const toolCalls: ToolCallView[] = message
        ? message.content
            .filter((part): part is ToolCall => part.type === "toolCall")
            .map((call) => ({ callId: call.id, name: call.name, args: argumentsOf(call) }))
        : [];
      const thinking = message ? thinkingOf(message.content) : "";
      return {
        ...base,
        role: "assistant",
        text: message ? textOf(message.content) : "",
        ...(thinking ? { thinking } : {}),
        toolCalls,
        createdAt: message?.timestamp ?? 0,
      };
    }
    case "pi.tool-result": {
      const message = model.find((item): item is ToolResultMessage => item.role === "toolResult");
      return {
        ...base,
        role: "tool",
        text: message ? textOf(message.content) : "",
        tool: message ? { callId: message.toolCallId, name: message.toolName, isError: message.isError } : null,
        createdAt: message?.timestamp ?? 0,
      };
    }
    case "pi.compaction": {
      const message = model.find((item): item is UserMessage => item.role === "user");
      const summary = message ? stripSummary(textOf(message.content)) : "";
      return {
        ...base,
        role: "note",
        text: summary || "The earlier history was compacted into a summary.",
        createdAt: message?.timestamp ?? 0,
      };
    }
    case "pi.reset": {
      const message = model.find((item): item is UserMessage => item.role === "user");
      const handoff = message ? textOf(message.content) : "";
      return {
        ...base,
        role: "note",
        text: handoff || "The conversation was reset; earlier messages are out of context.",
        createdAt: message?.timestamp ?? 0,
      };
    }
    default:
      return null;
  }
}

/** The live state of a conversation: the running generation and its tool round. */
export function liveFrom(state: LiveState | undefined, conversationId: string): Live {
  const tools: LiveTool[] = (state?.tools ?? []).map((slot) => ({
    callId: slot.callId,
    name: slot.name,
    output: (slot.output ?? "").slice(0, MAX_TOOL_OUTPUT),
  }));
  const content = state?.generation?.message?.content;
  const partial = content ? textOf(content) : "";
  const thinking = content ? thinkingOf(content) : "";
  return {
    conversationId,
    running: state?.run !== undefined,
    partial: partial.length > 0 ? partial : null,
    ...(thinking ? { thinking } : {}),
    tools,
  };
}

/** Whether two live states would look the same to a client. */
export function sameLive(left: Live, right: Live): boolean {
  if (left.running !== right.running || left.partial !== right.partial || left.thinking !== right.thinking) return false;
  if (left.tools.length !== right.tools.length) return false;
  return left.tools.every((tool, index) => {
    const other = right.tools[index];
    return other !== undefined && tool.callId === other.callId && tool.name === other.name && tool.output === other.output;
  });
}

const IMAGE_EXTENSIONS: Record<string, true> = { ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true };
const TEXT_EXTENSIONS: Record<string, true> = Object.fromEntries([
  ".txt", ".md", ".markdown", ".mdx", ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".java", ".kt", ".swift", ".sh", ".bash",
  ".zsh", ".sql", ".html", ".htm", ".css", ".scss", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".log", ".vue", ".svelte", ".r", ".lua", ".php",
].map((extension) => [extension, true]));
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 100 * 1024;
const MAX_TOTAL_TEXT_BYTES = 200 * 1024;

/** Only the four provider-supported raster formats may become image content. */
function imageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** Read immutable stored bytes before admission; Pi persists the resulting content for replay. */
export async function renderUserContent(text: string, attachments: ArtifactRef[], store?: ArtifactStore): Promise<UserMessage["content"]> {
  if (attachments.length === 0) return text;
  const lines: string[] = [];
  const images: Extract<UserMessage["content"], unknown[]> = [];
  let imageBytes = 0;
  let textBytes = 0;
  for (const artifact of attachments) {
    lines.push(`- ${artifact.name} (${artifact.mediaType}, sha256:${artifact.digest})`);
    if (!store) continue;
    const mediaType = artifact.mediaType.split(";", 1)[0]!.trim().toLowerCase();
    const extension = extname(artifact.name).toLowerCase();
    const image = mediaType.startsWith("image/") || IMAGE_EXTENSIONS[extension] === true;
    const textLike = mediaType.startsWith("text/") || mediaType === "application/json"
      || mediaType.endsWith("+json") || TEXT_EXTENSIONS[extension] === true;
    if (!image && !textLike) {
      lines.push(`[첨부 생략: ${JSON.stringify(artifact.name)} — 지원하지 않는 파일 형식; 참조만 포함]`);
      continue;
    }
    if (!store.has(artifact.digest)) throw new CommandError("not_found", `artifact ${artifact.digest} does not exist`);
    const size = await store.size(artifact.digest);
    if (image) {
      if (size > MAX_IMAGE_BYTES || size > MAX_TOTAL_IMAGE_BYTES - imageBytes) {
        lines.push(`[첨부 생략: ${JSON.stringify(artifact.name)} — 이미지 크기 제한 (파일당 4 MiB, 메시지당 8 MiB)]`);
        continue;
      }
      const bytes = await store.read(artifact.digest, MAX_IMAGE_BYTES);
      const detectedType = imageType(bytes);
      if (!detectedType) {
        lines.push(`[첨부 생략: ${JSON.stringify(artifact.name)} — 지원하는 이미지 형식이 아님]`);
        continue;
      }
      images.push({ type: "image", mimeType: detectedType, data: Buffer.from(bytes).toString("base64") });
      imageBytes += bytes.byteLength;
      continue;
    }
    const window = Math.min(MAX_TEXT_BYTES, MAX_TOTAL_TEXT_BYTES - textBytes);
    if (window === 0) {
      lines.push(`[첨부 생략: ${JSON.stringify(artifact.name)} — 메시지 텍스트 크기 제한 (200 KiB)]`);
      continue;
    }
    const bytes = await store.read(artifact.digest, window);
    const truncated = size > window;
    let body: string;
    try {
      // A truncated final UTF-8 character is omitted, not replaced with invalid text.
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    } catch {
      lines.push(`[첨부 생략: ${JSON.stringify(artifact.name)} — UTF-8 텍스트가 아님]`);
      continue;
    }
    if (body.includes("\0")) {
      lines.push(`[첨부 생략: ${JSON.stringify(artifact.name)} — UTF-8 텍스트가 아님]`);
      continue;
    }
    textBytes += bytes.byteLength;
    let fenceLength = 3;
    for (const match of body.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    lines.push(`File: ${JSON.stringify(artifact.name)}\n${fence}\n${body}\n${fence}${truncated ? `\n[첨부 일부 생략: ${JSON.stringify(artifact.name)} — 처음 ${window}바이트만 포함]` : ""}`);
  }
  const rendered = `${text}${ATTACHMENT_MARKER}${lines.join("\n")}\n</attachments>`;
  return images.length ? [{ type: "text", text: rendered }, ...images] : rendered;
}

/** What the transcript shows: the owner's text without the attachment block. */
export function cutAttachmentBlock(text: string): string {
  const index = text.indexOf(ATTACHMENT_MARKER);
  return index === -1 ? text : text.slice(0, index);
}
