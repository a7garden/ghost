import { createHash } from "node:crypto";

export const newId = () => Bun.randomUUIDv7();

/**
 * A stable UUID-shaped id for a row a tool call creates, derived from the conversation and
 * call id, so a call Pi replays after a crash finds the row instead of creating a second one.
 */
export function idFor(conversationId: string, callId: string): string {
  const hex = createHash("sha256").update(`ghost-call/1\0${conversationId}\0${callId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const sha256 = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");

/** Stable JSON: object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export const digestOf = (value: unknown) => sha256(canonicalJson(value));
