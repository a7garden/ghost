import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { CodingImage, CodingItem } from "@ghost/contract";
import type { CodingFiles } from "./workspace.ts";

type ToolItem = Extract<CodingItem, { kind: "tool" }>;
type DisplayItem = Extract<CodingItem, { kind: "subagent" | "tool" | "notice" }>;
const DISPLAY_ENTRY = "ghost:coding:item";
const USER_IMAGES = "ghost:coding:user-images";

function text(content: readonly { type: string; text?: string }[], max = Infinity): string {
  let result = "";
  for (const block of content) {
    if (block.type !== "text" || !block.text) continue;
    if (result) result += "\n";
    result += block.text.slice(0, Math.max(0, max - result.length));
    if (result.length >= max) break;
  }
  return result.slice(0, max);
}

export class Transcript {
  private readonly items: CodingItem[] = [];
  private readonly positions = new Map<string, number>();
  private userCount = 0;
  private assistantCount = 0;
  private activeUser: string | undefined;
  private activeAssistant: string | undefined;
  private readonly currentTools = new Map<string, string>();
  private readonly childTools = new Map<string, ToolItem>();
  private childToolCount = 0;
  private readonly attachments: CodingImage[][] = [];

  constructor(private readonly manager: SessionManager, private readonly files: CodingFiles, private readonly emit: (item: CodingItem) => void) {
    const originalImages = new Map<string, CodingImage[]>();
    for (const entry of manager.getEntries()) {
      if (entry.type === "custom") {
        if (entry.customType === DISPLAY_ENTRY) this.put(entry.data as DisplayItem, false);
        else if (entry.customType === USER_IMAGES) {
          const { id, images } = entry.data as { id: string; images: CodingImage[] };
          originalImages.set(id, images);
        }
      } else if (entry.type === "message") {
        const message = entry.message;
        switch (message.role) {
          case "user": {
            const id = `user:${++this.userCount}`;
            this.user(message, id, false, originalImages.get(id));
            break;
          }
          case "assistant": this.assistant(message, `assistant:${++this.assistantCount}`, false, false); break;
          case "toolResult": this.toolResult(message.toolCallId, message, message.isError, false); break;
        }
      }
    }
    // A crash can leave calls and child work without a result. They are not still running.
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if ((item.kind === "tool" || item.kind === "subagent") && item.status === "running") this.items[i] = { ...item, status: "error" };
    }
  }

  page(after: string | undefined, limit: number): CodingItem[] {
    if (after === undefined) return this.items.slice(-limit);
    const index = after === "" ? -1 : this.positions.get(after);
    return index === undefined ? [] : this.items.slice(index + 1, index + 1 + limit);
  }

  queueImages(images: CodingImage[]): void { this.attachments.push(images); }
  discardImages(): void { this.attachments.length = 0; }

  display(item: DisplayItem): void {
    this.manager.appendCustomEntry(DISPLAY_ENTRY, item);
    this.put(item, true);
  }

  interrupted(turn: number, at: number): void {
    const id = `interrupted:${turn}`;
    if (this.positions.has(id)) return;
    const item: DisplayItem = { kind: "notice", id, at, level: "error", text: "Host가 다시 시작되어 턴이 중단되었습니다." };
    this.manager.appendCustomEntry(DISPLAY_ENTRY, item);
    this.put(item, false);
  }

  receive(event: AgentSessionEvent, subagent?: string): void {
    if (subagent) {
      if (event.type === "tool_execution_start") {
        const id = `${subagent}:tool:${event.toolCallId}:${++this.childToolCount}`;
        const item = this.toolStart(id, event.toolName, event.args, Date.now(), subagent);
        this.childTools.set(`${subagent}:${event.toolCallId}`, item);
        this.display(item);
      } else if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        const item = this.childTools.get(`${subagent}:${event.toolCallId}`);
        if (!item) return;
        if (event.type === "tool_execution_update") this.put(this.withResult(item, event.partialResult, "running"), true);
        else {
          this.childTools.delete(`${subagent}:${event.toolCallId}`);
          this.display(this.withResult(item, event.result, event.isError ? "error" : "done"));
        }
      }
      return;
    }
    switch (event.type) {
      case "message_start":
        if (event.message.role === "user") {
          const id = (this.activeUser = `user:${++this.userCount}`);
          const images = this.attachments.shift();
          if (images?.length) this.manager.appendCustomEntry(USER_IMAGES, { id, images });
          this.user(event.message, id, true, images);
        } else if (event.message.role === "assistant") {
          this.activeAssistant = `assistant:${++this.assistantCount}`;
        }
        break;
      case "message_update":
        if (this.activeAssistant && event.message.role === "assistant") this.assistant(event.message, this.activeAssistant, true, true);
        break;
      case "message_end":
        if (event.message.role === "user") {
          if (!this.activeUser) this.user(event.message, `user:${++this.userCount}`, true, this.attachments.shift());
          this.activeUser = undefined;
        } else if (event.message.role === "assistant") {
          this.assistant(event.message, this.activeAssistant ?? `assistant:${++this.assistantCount}`, false, true);
          this.activeAssistant = undefined;
        }
        break;
      case "tool_execution_start": {
        const id = this.currentTools.get(event.toolCallId) ?? `assistant:${this.assistantCount}:tool:${event.toolCallId}`;
        this.currentTools.set(event.toolCallId, id);
        if (!this.lookup(id)) this.put(this.toolStart(id, event.toolName, event.args, Date.now()), true);
        break;
      }
      case "tool_execution_update": this.toolResult(event.toolCallId, event.partialResult, false, true, true); break;
      case "tool_execution_end": this.toolResult(event.toolCallId, event.result, event.isError, true); break;
    }
  }

  private put(item: CodingItem, emit: boolean): void {
    const position = this.positions.get(item.id);
    if (position === undefined) {
      this.positions.set(item.id, this.items.length);
      this.items.push(item);
    } else this.items[position] = item;
    if (emit) this.emit(item);
  }

  private lookup(id: string): CodingItem | undefined {
    const position = this.positions.get(id);
    return position === undefined ? undefined : this.items[position];
  }

  private user(message: UserMessage, id: string, emit: boolean, original?: CodingImage[]): void {
    const content = message.content;
    this.put({ id, kind: "user", at: message.timestamp, text: typeof content === "string" ? content : text(content), images: original ?? (typeof content === "string" ? [] : this.images(content)) }, emit);
  }

  private assistant(message: AssistantMessage, id: string, streaming: boolean, emit: boolean): void {
    for (let index = 0; index < message.content.length; index++) {
      const part = message.content[index]!;
      if (part.type === "text" || part.type === "thinking") {
        const itemId = `${id}:${index}`;
        const value = part.type === "text" ? part.text : part.thinking;
        if (value) this.put({ id: itemId, kind: part.type === "text" ? "assistant" : "thinking", at: message.timestamp, text: value, streaming, }, emit);
        else if (!streaming) {
          const prior = this.lookup(itemId);
          if (prior?.kind === "assistant" || prior?.kind === "thinking") this.put({ ...prior, streaming: false }, emit);
        }
      } else if (part.type === "toolCall" && !streaming) {
        const itemId = `${id}:tool:${part.id}`;
        this.currentTools.set(part.id, itemId);
        if (!this.lookup(itemId)) this.put(this.toolStart(itemId, part.name, part.arguments, message.timestamp), emit);
      }
    }
  }

  private toolStart(id: string, tool: string, args: unknown, at: number, subagent?: string): ToolItem {
    const input = args as { path?: unknown; command?: unknown; pattern?: unknown } | undefined;
    const argument = input?.path ?? input?.command ?? input?.pattern;
    return { id, kind: "tool", at, tool, summary: `${tool}${typeof argument === "string" ? ` ${argument.replace(/\s+/g, " ")}` : ""}`.slice(0, 400), status: "running", output: "", images: [], ...(subagent ? { subagent } : {}) };
  }

  private toolResult(callId: string, result: unknown, isError: boolean, emit: boolean, partial = false): void {
    const id = this.currentTools.get(callId);
    const item = id ? this.lookup(id) : undefined;
    if (item?.kind === "tool") this.put(this.withResult(item, result, partial ? "running" : isError ? "error" : "done"), emit);
  }

  private withResult(item: ToolItem, value: unknown, status: ToolItem["status"]): ToolItem {
    const result = value as Partial<ToolResultMessage> | undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    const details = result?.details as { patch?: unknown; diff?: unknown } | undefined;
    const diff = details?.patch ?? details?.diff;
    return { ...item, status, output: text(content, 20_000), images: this.images(content), ...(typeof diff === "string" ? { diff: diff.slice(0, 40_000) } : {}) };
  }

  private images(content: readonly ({ type: string } | ImageContent)[]): CodingImage[] {
    const images: CodingImage[] = [];
    for (const block of content) {
      if (block.type !== "image" || !("data" in block) || images.length === 8) continue;
      try { images.push(this.files.attach(block)); } catch { /* malformed or over-limit tool image */ }
    }
    return images;
  }
}
