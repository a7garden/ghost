import type { ArtifactRef, Live, LiveTool, Message, MessageOrigin, ToolCallView } from "@ghost/contract";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";

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
        text: cutAttachmentBlock(text),
        attachments: userMeta?.attachments ?? [],
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

/** What the model sees: the owner's text and the artifacts that came with it. */
export function renderUserContent(text: string, attachments: ArtifactRef[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((artifact) => `- ${artifact.name} (${artifact.mediaType}, sha256:${artifact.digest})`);
  return `${text}${ATTACHMENT_MARKER}${lines.join("\n")}\n</attachments>`;
}

/** What the transcript shows: the owner's text without the attachment block. */
export function cutAttachmentBlock(text: string): string {
  const index = text.indexOf(ATTACHMENT_MARKER);
  return index === -1 ? text : text.slice(0, index);
}
