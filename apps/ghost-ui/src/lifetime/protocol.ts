import { VERSION } from "../../../../contracts/lifetime/bindings.ts";
import type { Envelope, Response, Snapshot } from "../../../../contracts/lifetime/bindings.ts";
import { isLifetimeEnvelope, isLifetimeResponse, isLifetimeSnapshot, isRecord } from "./guards";
import type { LifetimeIdentity } from "./types";

const encoder = new TextEncoder();


function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

/** Matches the shared sorted-key, UTF-8, integer-only canonical JSON digest. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Lifetime payload numbers must be safe integers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error("Lifetime payload arrays cannot contain holes or extra properties.");
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) items.push(canonicalJson(value[index]));
    return `[${items.join(",")}]`;
  }
  if (!isRecord(value)) throw new Error("Lifetime payload must contain JSON values only.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Lifetime payload objects must be plain JSON objects.");
  const keys = Object.keys(value).map(key => ({ key, bytes: encoder.encode(key) }));
  keys.sort((left, right) => compareBytes(left.bytes, right.bytes));
  return `{${keys.map(({ key }) => {
    const item = value[key];
    if (item === undefined) throw new Error("Lifetime payload cannot contain undefined values.");
    return `${JSON.stringify(key)}:${canonicalJson(item)}`;
  }).join(",")}}`;
}

export async function digestValue(value: unknown): Promise<string> {
  const bytes = encoder.encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function assertLifetimeIdentity(identity: LifetimeIdentity): void {
  if (typeof identity.actor_ref !== "string" || identity.actor_ref.length === 0) throw new Error("Lifetime transport actor_ref is not configured.");
  if (!Number.isSafeInteger(identity.authority_epoch) || identity.authority_epoch < 1) throw new Error("Lifetime transport authority_epoch must be a positive safe integer.");
}

export async function createEnvelope(
  body: Envelope["body"],
  identity: LifetimeIdentity,
  expectedRevision: number | null = null,
  commandId = crypto.randomUUID(),
): Promise<Envelope> {
  assertLifetimeIdentity(identity);
  if (!isRecord(body)) throw new Error("Lifetime command body must be a JSON object.");
  if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw new Error("Expected revision must be a positive safe integer.");
  if (typeof commandId !== "string" || commandId.length === 0) throw new Error("Lifetime command_id must not be empty.");
  const commandBody = structuredClone(body);
  return {
    protocol_version: VERSION,
    command_id: commandId,
    payload_digest: await digestValue(commandBody),
    actor_ref: identity.actor_ref,
    authority_epoch: identity.authority_epoch,
    expected_revision: expectedRevision,
    correlation_id: commandId,
    body: commandBody,
  };
}

export async function parseLifetimeEnvelope(value: unknown): Promise<Envelope> {
  if (!isLifetimeEnvelope(value)) throw new Error("Lifetime command envelope does not match contract revision 1.");
  if (await digestValue(value.body) !== value.payload_digest) throw new Error("Lifetime command payload digest does not match its body.");
  return value;
}

export function parseLifetimeResponse(value: unknown): Response {
  if (!isLifetimeResponse(value)) throw new Error("Lifetime Host response does not match contract revision 1.");
  return value;
}

export function parseLifetimeSnapshot(value: unknown): Snapshot {
  if (!isLifetimeSnapshot(value)) throw new Error("Lifetime snapshot does not match contract revision 1.");
  return value;
}
