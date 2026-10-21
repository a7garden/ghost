import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import type {
  Api,
  AssistantMessage,
  AuthStorage,
  AuthStorageOptions,
  Context,
  Model,
  OAuthCredential,
  ResolvedApiKey,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { BROWSER_WORKER_TOOL_NAMES } from "./native-tool-policy.ts";

const SDK_VERSION = "18.8.6";
const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-6-luna";
const MODEL_SELECTOR = `${MODEL_PROVIDER}/${MODEL_ID}`;
const MODEL_BASE_URL = "https://chatgpt.com/backend-api";
const MAX_TOKENS = 1024;
const MAX_DEADLINE_MS = 180_000;
const AUTH_SCHEMA_VERSION = 8;
const AUTH_SESSION_ID = "ghost-subscription-native-stdio";
const SQLITE_PROVIDER = MODEL_PROVIDER;
const SQLITE_DB_MAX_BYTES = 64 * 1024 * 1024;
const SQLITE_WAL_MAX_BYTES = 256 * 1024 * 1024;
const SQLITE_CREDENTIAL_MAX_BYTES = 64 * 1024;
const MAX_AUTH_FRAME_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ASSISTANT_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_OVERHEAD_BYTES = 64 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * Math.max(MAX_PAYLOAD_BYTES, MAX_ASSISTANT_BYTES) + MAX_FRAME_OVERHEAD_BYTES;
const MAX_CONTEXT_MESSAGES = 512;
const MAX_CONTEXT_TOOLS = BROWSER_WORKER_TOOL_NAMES.length;
const MAX_QUEUED_FRAMES = 2;
const ALLOWED_TOOLS = new Set<string>(BROWSER_WORKER_TOOL_NAMES);
const TOOL_DESCRIPTOR_KEYS: Record<string, true> = {
  name: true,
  description: true,
  parameters: true,
  strict: true,
  deferLoading: true,
  customFormat: true,
  customWireName: true,
  native: true,
  examples: true,
};
const OAUTH_FIELDS: Record<string, true> = {
  access: true,
  refresh: true,
  expires: true,
  enterpriseUrl: true,
  projectId: true,
  email: true,
  accountId: true,
  apiEndpoint: true,
  orgId: true,
  orgName: true,
  region: true,
  inferenceRegion: true,
  activeOrganizationId: true,
  authorizedAt: true,
};
const NATIVE_CONTEXT_KEYS: Record<string, true> = {
  systemPrompt: true,
  messages: true,
  tools: true,
  inactiveTools: true,
};
const CONFIG_KEYS = [
  "version",
  "kind",
  "sdk_package_root",
  "auth_file",
  "selector",
  "thinking",
  "max_tokens",
  "deadline_ms",
] as const;
const REQUEST_KEYS = [
  "version",
  "kind",
  "request_id",
  "execution_id",
  "authority_epoch",
  "payload_json",
  "payload_sha256",
] as const;
const NATIVE_REQUEST_KEYS = ["modelId", "context", "options", "stream"] as const;
const NATIVE_OPTION_KEYS = ["maxTokens", "reasoning"] as const;
const ALLOWED_CONTEXT_ROLES: Record<string, true> = {
  user: true,
  assistant: true,
  toolResult: true,
  developer: true,
};

type FailureCode =
  | "invalid_config"
  | "unsupported_runtime"
  | "unsupported_sdk"
  | "unsupported_model"
  | "max_reasoning_unavailable"
  | "auth_snapshot_unsafe"
  | "auth_snapshot_unavailable"
  | "auth_schema_unsupported"
  | "credential_missing"
  | "credential_ambiguous"
  | "credential_unavailable"
  | "memory_auth_unavailable"
  | "input_eof"
  | "input_error"
  | "input_frame_invalid"
  | "input_frame_too_large"
  | "invalid_request_envelope"
  | "request_too_large"
  | "payload_hash_mismatch"
  | "invalid_native_payload"
  | "stdin_closed_before_dispatch"
  | "cancelled_before_dispatch"
  | "dispatch_deadline"
  | "dispatch_cancelled"
  | "dispatch_retry_blocked"
  | "dispatch_endpoint_rejected"
  | "dispatch_failed"
  | "assistant_invalid"
  | "assistant_tool_scope"
  | "assistant_too_large"
  | "internal_error";

class BridgeFailure extends Error {
  readonly code: FailureCode;

  constructor(code: FailureCode) {
    super(code);
    this.name = "BridgeFailure";
    this.code = code;
  }
}

interface ConfigureFrame {
  version: 1;
  kind: "configure";
  sdk_package_root: string;
  auth_file: string;
  selector: typeof MODEL_SELECTOR;
  thinking: "max";
  max_tokens: typeof MAX_TOKENS;
  deadline_ms: typeof MAX_DEADLINE_MS;
}

interface ResponseIdentity {
  request_id: string;
  execution_id: string;
  authority_epoch: number;
  payload_sha256: string;
}

interface ModelRequestFrame extends ResponseIdentity {
  version: 1;
  kind: "model_request";
  payload_json: string;
}

interface NativeRequest {
  modelId: typeof MODEL_SELECTOR;
  context: Context;
  options: {
    maxTokens: typeof MAX_TOKENS;
    reasoning: string;
  };
  stream: true;
}

interface SqliteStatement<T> {
  all(...bindings: unknown[]): T[];
  get(...bindings: unknown[]): T | undefined;
}

interface ReadonlySqliteDatabase {
  run(sql: string): unknown;
  query<T>(sql: string): SqliteStatement<T>;
  close(): void;
}

interface BunSqliteModule {
  Database: {
    deserialize(bytes: Uint8Array): ReadonlySqliteDatabase;
  };
}

interface SqliteCredentialRow {
  id: number;
  provider: string;
  credential_type: string;
  data: string;
  data_size: number;
  disabled_cause: string | null;
}

interface PinnedRuntime {
  AuthStorage: {
    create(dbPath: string, options?: AuthStorageOptions): Promise<AuthStorage>;
  };
  streamSimple(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
  ): { result(): Promise<AssistantMessage> };
  resolveGatewayApiKey(
    storage: AuthStorage,
    model: Model<Api>,
    sessionId: string,
    signal: AbortSignal,
    peer: string,
  ): Promise<ResolvedApiKey | { status: number }>;
  model: Model<Api>;
  reasoning: string;
}

export interface SubscriptionNativeBridgeIo {
  input: Readable;
  output: Writable;
  diagnostics: Writable;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function safeScopeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function validateConfigureFrame(value: unknown): ConfigureFrame {
  if (!isRecord(value) || !hasExactKeys(value, CONFIG_KEYS)) {
    throw new BridgeFailure("invalid_config");
  }
  if (
    value.version !== 1 ||
    value.kind !== "configure" ||
    typeof value.sdk_package_root !== "string" ||
    !isAbsolute(value.sdk_package_root) ||
    resolve(value.sdk_package_root) !== value.sdk_package_root ||
    typeof value.auth_file !== "string" ||
    !isAbsolute(value.auth_file) ||
    resolve(value.auth_file) !== value.auth_file ||
    value.selector !== MODEL_SELECTOR ||
    value.thinking !== "max" ||
    value.max_tokens !== MAX_TOKENS ||
    value.deadline_ms !== MAX_DEADLINE_MS
  ) {
    throw new BridgeFailure("invalid_config");
  }
  return value as unknown as ConfigureFrame;
}


function validateContextTools(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_TOOLS) {
    throw new BridgeFailure("invalid_native_payload");
  }
  const seen = new Set<string>();
  for (const tool of value) {
    if (
      !isRecord(tool) ||
      Object.keys(tool).some(key => !Object.hasOwn(TOOL_DESCRIPTOR_KEYS, key)) ||
      typeof tool.name !== "string" ||
      !ALLOWED_TOOLS.has(tool.name) ||
      typeof tool.description !== "string" ||
      !isRecord(tool.parameters) ||
      (Object.hasOwn(tool, "customFormat") && (
        tool.name !== "edit" ||
        !isRecord(tool.customFormat) ||
        Object.keys(tool.customFormat).length !== 2 ||
        tool.customFormat.syntax !== "lark" ||
        typeof tool.customFormat.definition !== "string" ||
        tool.customFormat.definition.length === 0
      )) ||
      Object.hasOwn(tool, "native") ||
      (tool.strict !== undefined && typeof tool.strict !== "boolean") ||
      (tool.deferLoading !== undefined && typeof tool.deferLoading !== "boolean") ||
      (tool.examples !== undefined && !Array.isArray(tool.examples)) ||
      (tool.customWireName !== undefined && tool.customWireName !== tool.name)
    ) {
      throw new BridgeFailure("invalid_native_payload");
    }
    if (seen.has(tool.name)) throw new BridgeFailure("invalid_native_payload");
    seen.add(tool.name);
  }
}

export function validateNativePayload(payloadJson: string, resolvedReasoning: string): NativeRequest {
  if (byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
    throw new BridgeFailure("request_too_large");
  }
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    throw new BridgeFailure("invalid_native_payload");
  }
  if (!isRecord(value) || !hasExactKeys(value, NATIVE_REQUEST_KEYS)) {
    throw new BridgeFailure("invalid_native_payload");
  }
  if (
    value.modelId !== MODEL_SELECTOR ||
    value.stream !== true ||
    !isRecord(value.options) ||
    !hasExactKeys(value.options, NATIVE_OPTION_KEYS) ||
    value.options.maxTokens !== MAX_TOKENS ||
    value.options.reasoning !== resolvedReasoning
  ) {
    throw new BridgeFailure("invalid_native_payload");
  }
  const context = value.context;
  if (
    !isRecord(context) ||
    Object.keys(context).some(key => !Object.hasOwn(NATIVE_CONTEXT_KEYS, key)) ||
    !Array.isArray(context.messages) ||
    context.messages.length > MAX_CONTEXT_MESSAGES ||
    (context.systemPrompt !== undefined &&
      (!Array.isArray(context.systemPrompt) || context.systemPrompt.some(prompt => typeof prompt !== "string")))
  ) {
    throw new BridgeFailure("invalid_native_payload");
  }
  for (const message of context.messages) {
    if (!isRecord(message) || typeof message.role !== "string" || !Object.hasOwn(ALLOWED_CONTEXT_ROLES, message.role)) {
      throw new BridgeFailure("invalid_native_payload");
    }
  }
  validateContextTools(context.tools);
  validateContextTools(context.inactiveTools);
  return value as unknown as NativeRequest;
}

export function extractResponseIdentity(value: unknown): ResponseIdentity | undefined {
  if (
    !isRecord(value) ||
    !isUuid(value.request_id) ||
    !safeScopeToken(value.execution_id) ||
    typeof value.authority_epoch !== "number" ||
    !Number.isSafeInteger(value.authority_epoch) ||
    value.authority_epoch < 1 ||
    typeof value.payload_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.payload_sha256) ||
    typeof value.payload_json !== "string"
  ) {
    return undefined;
  }
  return {
    request_id: value.request_id,
    execution_id: value.execution_id,
    authority_epoch: value.authority_epoch,
    payload_sha256: value.payload_sha256,
  };
}

function requestRejectionReason(
  value: unknown,
  identity: ResponseIdentity,
): FailureCode | undefined {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS) || value.version !== 1 || value.kind !== "model_request") {
    return "invalid_request_envelope";
  }
  if (byteLength(value.payload_json as string) > MAX_PAYLOAD_BYTES) return "request_too_large";
  if (sha256(value.payload_json as string) !== identity.payload_sha256) return "payload_hash_mismatch";
  return undefined;
}

function requireCurrentUid(): bigint {
  if (typeof process.getuid !== "function") throw new BridgeFailure("auth_snapshot_unsafe");
  return BigInt(process.getuid());
}

interface BigFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function assertPrivateRegularFile(stat: BigFileStat, uid: bigint, maxBytes: number): void {
  if (
    !stat.isFile() ||
    stat.uid !== uid ||
    (stat.mode & 0o077n) !== 0n ||
    stat.nlink !== 1n ||
    stat.size < 0n ||
    stat.size > BigInt(maxBytes)
  ) {
    throw new BridgeFailure("auth_snapshot_unsafe");
  }
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint },
  right: { dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    (left.mode & 0o777n) === (right.mode & 0o777n) &&
    left.nlink === right.nlink
  );
}

async function openPrivateSidecar(
  filePath: string,
  uid: bigint,
  maxBytes: number,
): Promise<FileHandle | undefined> {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new BridgeFailure("auth_snapshot_unsafe");
  let handle: FileHandle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (isFilesystemCode(error, "ENOENT")) return undefined;
    throw new BridgeFailure("auth_snapshot_unsafe");
  }
  try {
    const stat = await handle.stat({ bigint: true });
    assertPrivateRegularFile(stat, uid, maxBytes);
    const pathStat = await lstat(filePath, { bigint: true });
    if (pathStat.isSymbolicLink() || !sameFileIdentity(stat, pathStat)) {
      throw new BridgeFailure("auth_snapshot_unsafe");
    }
    return handle;
  } catch (error) {
    await closeQuietly(handle);
    if (error instanceof BridgeFailure) throw error;
    throw new BridgeFailure("auth_snapshot_unsafe");
  }
}
async function assertStablePath(
  filePath: string,
  handle: FileHandle | undefined,
  uid: bigint,
  maxBytes: number,
): Promise<void> {
  let pathStat: BigFileStat;
  try {
    pathStat = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (!handle && isFilesystemCode(error, "ENOENT")) return;
    throw new BridgeFailure("auth_snapshot_unsafe");
  }
  if (!handle || pathStat.isSymbolicLink()) throw new BridgeFailure("auth_snapshot_unsafe");
  const openStat = await handle.stat({ bigint: true });
  assertPrivateRegularFile(openStat, uid, maxBytes);
  if (!sameFileIdentity(openStat, pathStat)) throw new BridgeFailure("auth_snapshot_unsafe");
}

function isFilesystemCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The source descriptor is read-only; close failure does not permit fallback.
  }
}

function parseStoredOAuthCredential(data: string): OAuthCredential {
  if (byteLength(data) > SQLITE_CREDENTIAL_MAX_BYTES) {
    throw new BridgeFailure("auth_snapshot_unsafe");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new BridgeFailure("auth_snapshot_unavailable");
  }
  if (!isRecord(parsed) || Object.keys(parsed).some(key => !Object.hasOwn(OAUTH_FIELDS, key))) {
    throw new BridgeFailure("auth_snapshot_unavailable");
  }
  if (
    typeof parsed.access !== "string" ||
    parsed.access.length === 0 ||
    parsed.access.length > SQLITE_CREDENTIAL_MAX_BYTES ||
    typeof parsed.refresh !== "string" ||
    parsed.refresh.length === 0 ||
    parsed.refresh.length > SQLITE_CREDENTIAL_MAX_BYTES ||
    typeof parsed.expires !== "number" ||
    !Number.isFinite(parsed.expires) ||
    typeof parsed.accountId !== "string" ||
    !safeScopeToken(parsed.accountId)
  ) {
    throw new BridgeFailure("auth_snapshot_unavailable");
  }
  return { type: "oauth", ...parsed } as OAuthCredential;
}


async function readSnapshotBytes(handle: FileHandle, before: BigFileStat): Promise<Buffer> {
  if (typeof before.mtimeNs !== "bigint" || typeof before.ctimeNs !== "bigint") {
    throw new BridgeFailure("auth_snapshot_unavailable");
  }
  const bytes = Buffer.alloc(Number(before.size));
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (read.bytesRead === 0) throw new BridgeFailure("auth_snapshot_unavailable");
    offset += read.bytesRead;
  }
  return bytes;
}

function sameSnapshotRevision(before: BigFileStat, after: BigFileStat): boolean {
  return sameFileIdentity(before, after) && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

// SQLite's documented WAL checksum and commit markers. Never open the source
// with SQLite: even a readonly WAL connection can update its shared-memory file.
function committedAuthImage(main: Buffer, wal: Buffer | undefined): Buffer {
  if (main.length < 100 || main.toString("ascii", 0, 16) !== "SQLite format 3\0"
    || ![1, 2].includes(main[18]!) || ![1, 2].includes(main[19]!)) {
    throw new BridgeFailure("auth_snapshot_unavailable");
  }
  const encodedPageSize = main.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65536 : encodedPageSize;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0
    || main.length % pageSize !== 0) {
    throw new BridgeFailure("auth_snapshot_unavailable");
  }
  let pages = main.length / pageSize;
  let committedEnd = 32;
  const frameBytes = pageSize + 24;
  if (wal && wal.length > 0) {
    if (wal.length < 32) throw new BridgeFailure("auth_snapshot_unavailable");
    const magic = wal.readUInt32BE(0);
    if ((magic !== 0x377f0682 && magic !== 0x377f0683)
      || wal.readUInt32BE(4) !== 3007000 || wal.readUInt32BE(8) !== pageSize) {
      throw new BridgeFailure("auth_snapshot_unavailable");
    }
    const littleEndian = magic === 0x377f0682;
    const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
    let sum0 = 0;
    let sum1 = 0;
    const checksum = (start: number, end: number): void => {
      for (let position = start; position < end; position += 8) {
        sum0 = (sum0 + view.getUint32(position, littleEndian) + sum1) >>> 0;
        sum1 = (sum1 + view.getUint32(position + 4, littleEndian) + sum0) >>> 0;
      }
    };
    checksum(0, 24);
    if (sum0 !== wal.readUInt32BE(24) || sum1 !== wal.readUInt32BE(28)) {
      throw new BridgeFailure("auth_snapshot_unavailable");
    }
    const salt0 = wal.readUInt32BE(16);
    const salt1 = wal.readUInt32BE(20);
    for (let offset = 32; offset + frameBytes <= wal.length; offset += frameBytes) {
      if (wal.readUInt32BE(offset + 8) !== salt0 || wal.readUInt32BE(offset + 12) !== salt1) {
        break; // Old-cycle tail left after a WAL reset is not part of this log.
      }
      if (wal.readUInt32BE(offset) === 0) throw new BridgeFailure("auth_snapshot_unavailable");
      checksum(offset, offset + 8);
      checksum(offset + 24, offset + frameBytes);
      if (sum0 !== wal.readUInt32BE(offset + 16) || sum1 !== wal.readUInt32BE(offset + 20)) {
        throw new BridgeFailure("auth_snapshot_unavailable");
      }
      const committedPages = wal.readUInt32BE(offset + 4);
      if (committedPages !== 0) {
        if (committedPages * pageSize > SQLITE_DB_MAX_BYTES) {
          throw new BridgeFailure("auth_snapshot_unsafe");
        }
        pages = committedPages;
        committedEnd = offset + frameBytes;
      }
    }
  }
  const image = Buffer.alloc(pages * pageSize);
  main.copy(image, 0, 0, Math.min(main.length, image.length));
  if (wal) {
    const latest = new Map<number, number>();
    for (let offset = 32; offset < committedEnd; offset += frameBytes) {
      const page = wal.readUInt32BE(offset);
      if (page <= pages) latest.set(page, offset + 24);
    }
    for (const [page, offset] of latest) {
      wal.copy(image, (page - 1) * pageSize, offset, offset + pageSize);
    }
  }
  // sqlite3_deserialize cannot use WAL mode; only this owned RAM image changes.
  image[18] = 1;
  image[19] = 1;
  image.writeUInt32BE(pages, 28);
  return image;
}
/** @internal Reads one active Codex OAuth row from a committed main/WAL RAM image; never opens SQLite or SHM on the source. */
export async function readCanonicalCredentialSnapshot(authFile: string): Promise<OAuthCredential> {
  let mainHandle: FileHandle | undefined;
  let walHandle: FileHandle | undefined;
  let journalHandle: FileHandle | undefined;
  let database: ReadonlySqliteDatabase | undefined;
  try {
    if (!isAbsolute(authFile) || resolve(authFile) !== authFile) {
      throw new BridgeFailure("auth_snapshot_unsafe");
    }
    const uid = requireCurrentUid();
    const parent = dirname(authFile);
    if ((await realpath(parent)) !== parent) throw new BridgeFailure("auth_snapshot_unsafe");
    const parentStat = await lstat(parent, { bigint: true });
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      parentStat.uid !== uid ||
      (parentStat.mode & 0o022n) !== 0n
    ) {
      throw new BridgeFailure("auth_snapshot_unsafe");
    }
    const noFollow = fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== "number") throw new BridgeFailure("auth_snapshot_unsafe");
    try {
      mainHandle = await open(authFile, fsConstants.O_RDONLY | noFollow);
    } catch {
      throw new BridgeFailure("auth_snapshot_unsafe");
    }
    const initialStat = await mainHandle.stat({ bigint: true });
    assertPrivateRegularFile(initialStat, uid, SQLITE_DB_MAX_BYTES);
    const initialPathStat = await lstat(authFile, { bigint: true });
    if (initialPathStat.isSymbolicLink() || !sameSnapshotRevision(initialStat, initialPathStat)) {
      throw new BridgeFailure("auth_snapshot_unsafe");
    }
    walHandle = await openPrivateSidecar(`${authFile}-wal`, uid, SQLITE_WAL_MAX_BYTES);
    journalHandle = await openPrivateSidecar(`${authFile}-journal`, uid, SQLITE_WAL_MAX_BYTES);
    if (journalHandle) {
      throw new BridgeFailure("auth_snapshot_unavailable");
    }
    const walBefore = walHandle ? await walHandle.stat({ bigint: true }) : undefined;
    const mainBytes = await readSnapshotBytes(mainHandle, initialStat);
    const walBytes = walHandle && walBefore ? await readSnapshotBytes(walHandle, walBefore) : undefined;
    const mainAfter = await mainHandle.stat({ bigint: true });
    const walAfter = walHandle ? await walHandle.stat({ bigint: true }) : undefined;
    if (!sameSnapshotRevision(initialStat, mainAfter)
      || (walBefore && (!walAfter || !sameSnapshotRevision(walBefore, walAfter)))) {
      throw new BridgeFailure("auth_snapshot_unavailable");
    }
    const image = committedAuthImage(mainBytes, walBytes);

    const sqliteSpecifier = "bun:sqlite";
    // SQLite is a Bun-only builtin; load it only after the runtime capability check.
    const sqliteModule = (await import(sqliteSpecifier)) as unknown as BunSqliteModule;
    database = sqliteModule.Database.deserialize(image);
    database.run("PRAGMA query_only = ON");
    const schema = database.query<{ version: number }>(
      "SELECT version FROM auth_schema_version WHERE id = 1",
    ).get();
    if (schema?.version !== AUTH_SCHEMA_VERSION) {
      throw new BridgeFailure("auth_schema_unsupported");
    }
    const rows = database.query<SqliteCredentialRow>(
      `SELECT id, provider, credential_type,
              substr(data, 1, ${SQLITE_CREDENTIAL_MAX_BYTES + 1}) AS data,
              length(CAST(data AS BLOB)) AS data_size,
              disabled_cause
       FROM auth_credentials
       WHERE provider = ? AND disabled_cause IS NULL
       ORDER BY id ASC
       LIMIT 2`,
    ).all(SQLITE_PROVIDER);
    if (rows.length === 0) throw new BridgeFailure("credential_missing");
    if (rows.length !== 1) throw new BridgeFailure("credential_ambiguous");
    const row = rows[0]!;
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      row.provider !== SQLITE_PROVIDER ||
      row.credential_type !== "oauth" ||
      row.disabled_cause !== null ||
      typeof row.data !== "string" ||
      !Number.isSafeInteger(row.data_size) ||
      row.data_size < 0 ||
      row.data_size > SQLITE_CREDENTIAL_MAX_BYTES
    ) {
      throw new BridgeFailure("credential_unavailable");
    }
    const credential = parseStoredOAuthCredential(row.data);
    await assertStablePath(authFile, mainHandle, uid, SQLITE_DB_MAX_BYTES);
    await assertStablePath(`${authFile}-wal`, walHandle, uid, SQLITE_WAL_MAX_BYTES);
    await assertStablePath(`${authFile}-journal`, journalHandle, uid, SQLITE_WAL_MAX_BYTES);
    return credential;
  } catch (error) {
    if (error instanceof BridgeFailure) throw error;
    throw new BridgeFailure("auth_snapshot_unavailable");
  } finally {
    try {
      database?.close();
    } catch {
      // Fail closed; never reopen this source through a mutating store API.
    }
    if (journalHandle) await closeQuietly(journalHandle);
    if (walHandle) await closeQuietly(walHandle);
    if (mainHandle) await closeQuietly(mainHandle);
  }
}

function requireBunVersion(): void {
  const bunVersion = (process.versions as unknown as Record<string, string | undefined>).bun;
  if (process.platform !== "darwin" || !bunVersion || !versionAtLeast(bunVersion, 1, 3, 14)) {
    throw new BridgeFailure("unsupported_runtime");
  }
}

function versionAtLeast(value: string, major: number, minor: number, patch: number): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return (
    parts[0]! > major ||
    (parts[0] === major && parts[1]! > minor) ||
    (parts[0] === major && parts[1] === minor && parts[2]! >= patch)
  );
}

async function readPackageManifest(packageRoot: string, expectedName: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(packageRoot, "package.json"), "utf8");
  } catch {
    throw new BridgeFailure("unsupported_sdk");
  }
  if (byteLength(text) > MAX_AUTH_FRAME_BYTES) throw new BridgeFailure("unsupported_sdk");
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new BridgeFailure("unsupported_sdk");
  }
  if (!isRecord(manifest) || manifest.name !== expectedName || manifest.version !== SDK_VERSION) {
    throw new BridgeFailure("unsupported_sdk");
  }
  return manifest;
}

async function loadPinnedRuntime(sdkPackageRoot: string): Promise<PinnedRuntime> {
  requireBunVersion();
  let packageRoot: string;
  try {
    packageRoot = await realpath(sdkPackageRoot);
  } catch {
    throw new BridgeFailure("unsupported_sdk");
  }
  const aiManifest = await readPackageManifest(packageRoot, "@oh-my-pi/pi-ai");
  const dependencies = aiManifest.dependencies;
  if (
    !isRecord(dependencies) ||
    dependencies["@oh-my-pi/pi-catalog"] !== SDK_VERSION ||
    dependencies["@oh-my-pi/pi-utils"] !== SDK_VERSION
  ) {
    throw new BridgeFailure("unsupported_sdk");
  }
  const packageScope = dirname(packageRoot);
  const catalogRoot = join(packageScope, "pi-catalog");
  const utilsRoot = join(packageScope, "pi-utils");
  await readPackageManifest(catalogRoot, "@oh-my-pi/pi-catalog");
  await readPackageManifest(utilsRoot, "@oh-my-pi/pi-utils");

  try {
    // Resolve SDK modules from the configured, version-checked package tree, not an ambient copy.
    const loggerUrl = pathToFileURL(join(utilsRoot, "src/logger.ts")).href;
    const logger = (await import(loggerUrl)) as { setTransports(options: { file: false; console: false }): void };
    logger.setTransports({ file: false, console: false });

    // This isolated child never writes user-level logs; the bridge emits only static codes to stderr.
    delete process.env.OPENAI_CODEX_OAUTH_TOKEN;
    delete process.env.PI_CODEX_WEBSOCKET;

    const aiUrl = pathToFileURL(join(packageRoot, "src/index.ts")).href;
    const dispatchUrl = pathToFileURL(join(packageRoot, "src/auth-gateway/dispatch.ts")).href;
    const modelsUrl = pathToFileURL(join(catalogRoot, "src/models.ts")).href;
    const thinkingUrl = pathToFileURL(join(catalogRoot, "src/model-thinking.ts")).href;
    const [aiModule, dispatchModule, modelsModule, thinkingModule] = await Promise.all([
      import(aiUrl),
      import(dispatchUrl),
      import(modelsUrl),
      import(thinkingUrl),
    ]);
    const ai = aiModule as {
      AuthStorage: PinnedRuntime["AuthStorage"];
      streamSimple: PinnedRuntime["streamSimple"];
    };
    const dispatch = dispatchModule as { resolveGatewayApiKey: PinnedRuntime["resolveGatewayApiKey"] };
    const catalog = modelsModule as { getBundledModel(provider: string, id: string): Model<Api> | undefined };
    const effort = thinkingModule as {
      getSupportedEfforts(model: Model<Api>): readonly string[];
      clampThinkingLevelForModel(model: Model<Api>, requested: string): string | undefined;
    };
    const model = catalog.getBundledModel(MODEL_PROVIDER, MODEL_ID);
    if (
      !model ||
      model.provider !== MODEL_PROVIDER ||
      model.id !== MODEL_ID ||
      model.api !== "openai-codex-responses" ||
      model.baseUrl !== MODEL_BASE_URL
    ) {
      throw new BridgeFailure("unsupported_model");
    }
    const supported = effort.getSupportedEfforts(model);
    const resolvedReasoning = effort.clampThinkingLevelForModel(model, "max");
    if (!supported.includes("max") || resolvedReasoning !== "max") {
      throw new BridgeFailure("max_reasoning_unavailable");
    }
    // Bundled discovery records belong to the package publisher's accounts, not this execution's credential.
    // Pin the single admitted credential below; the provider remains authoritative for entitlement.
    const admittedModel = { ...model };
    delete admittedModel.accountAccess;
    return {
      AuthStorage: ai.AuthStorage,
      streamSimple: ai.streamSimple,
      resolveGatewayApiKey: dispatch.resolveGatewayApiKey,
      model: admittedModel,
      reasoning: resolvedReasoning,
    };
  } catch (error) {
    if (error instanceof BridgeFailure) throw error;
    throw new BridgeFailure("unsupported_sdk");
  }
}

function validateAssistantMessage(value: AssistantMessage, model: Model<Api>, requestTools: ReadonlySet<string>): FailureCode | undefined {
  if (
    !isRecord(value) ||
    value.role !== "assistant" ||
    value.provider !== MODEL_PROVIDER ||
    value.model !== MODEL_ID ||
    value.api !== model.api ||
    !Array.isArray(value.content) ||
    !["stop", "length", "toolUse"].includes(value.stopReason)
  ) {
    return "assistant_invalid";
  }
  for (const block of value.content) {
    if (!isRecord(block)) return "assistant_invalid";
    if (block.type === "toolCall" && (
      typeof block.name !== "string"
      || !ALLOWED_TOOLS.has(block.name)
      || !requestTools.has(block.name)
    )) {
      return "assistant_tool_scope";
    }
  }
  return undefined;
}

interface FetchStatistics {
  attempts: number;
  dispatched: number;
  retryBlocked: boolean;
  endpointRejected: boolean;
}

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function makeOneShotProviderFetch(signal: AbortSignal, stats: FetchStatistics): FetchFunction {
  return async (input, init) => {
    stats.attempts += 1;
    if (stats.attempts > 1) {
      stats.retryBlocked = true;
      throw new BridgeFailure("dispatch_retry_blocked");
    }
    let url: URL;
    try {
      url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(String(input));
    } catch {
      stats.endpointRejected = true;
      throw new BridgeFailure("dispatch_endpoint_rejected");
    }
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      url.origin !== "https://chatgpt.com" ||
      !url.pathname.startsWith("/backend-api/") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      method.toUpperCase() !== "POST"
    ) {
      stats.endpointRejected = true;
      throw new BridgeFailure("dispatch_endpoint_rejected");
    }
    if (signal.aborted) throw new BridgeFailure("dispatch_cancelled");
    stats.dispatched += 1;
    return globalThis.fetch(input, {
      ...init,
      redirect: "error",
      signal,
    });
  };
}

function modelResponse(
  identity: ResponseIdentity,
  status: "completed" | "rejected" | "effect_unknown",
  reasonCode: FailureCode | null,
  messageJson: string | null = null,
): Record<string, unknown> {
  const envelope: Record<string, unknown> = {
    version: 1,
    kind: "model_response",
    request_id: identity.request_id,
    execution_id: identity.execution_id,
    authority_epoch: identity.authority_epoch,
    payload_sha256: identity.payload_sha256,
    status,
    message_json: messageJson,
    message_sha256: messageJson === null ? null : sha256(messageJson),
    reason_code: reasonCode,
  };
  const base = { ...envelope, message_json: null, message_sha256: null };
  const baseJson = JSON.stringify(base);
  if (typeof baseJson !== "string" || byteLength(baseJson) > MAX_FRAME_OVERHEAD_BYTES) {
    throw new BridgeFailure("internal_error");
  }
  return envelope;
}

async function writeJsonLine(output: Writable, value: unknown, maxBytes: number): Promise<void> {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new BridgeFailure("input_frame_invalid");
  const line = `${serialized}\n`;
  if (byteLength(line) > maxBytes) throw new BridgeFailure("input_frame_too_large");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onError = (): void => reject(new BridgeFailure("input_error"));
  output.once("error", onError);
  try {
    output.write(line, "utf8", error => {
      output.removeListener("error", onError);
      if (error) reject(new BridgeFailure("input_error"));
      else resolve();
    });
  } catch {
    output.removeListener("error", onError);
    reject(new BridgeFailure("input_error"));
  }
  return promise;
}

async function writeDiagnostic(output: Writable, code: FailureCode): Promise<void> {
  try {
    await writeJsonLine(output, `subscription-native-bridge:${code}`, 256);
  } catch {
    // stderr is diagnostic-only; never replace the static code with an exception.
  }
}

class BoundedJsonlReader {
  readonly #input: Readable;
  readonly #queue: string[] = [];
  readonly #waiters: Array<{
    resolve(value: string | undefined): void;
    reject(error: BridgeFailure): void;
  }> = [];
  readonly #parts: Buffer[] = [];
  #pendingBytes = 0;
  #failure: BridgeFailure | undefined;
  #ended = false;
  #disposed = false;

  readonly #onReadable = (): void => this.#pump();
  readonly #onEnd = (): void => this.#finish();
  readonly #onClose = (): void => this.#finish();
  readonly #onError = (): void => this.#fail("input_error");

  constructor(input: Readable) {
    this.#input = input;
    input.on("readable", this.#onReadable);
    input.on("end", this.#onEnd);
    input.on("close", this.#onClose);
    input.on("error", this.#onError);
    this.#pump();
  }

  get ended(): boolean {
    return this.#ended;
  }

  next(signal?: AbortSignal): Promise<string | undefined> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(new BridgeFailure("input_error"));
    const line = this.#queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#ended) return Promise.resolve(undefined);
    const completion = Promise.withResolvers<string | undefined>();
    this.#waiters.push(completion);
    if (!signal) return completion.promise;
    const cancel = (): void => {
      const index = this.#waiters.indexOf(completion);
      if (index >= 0) this.#waiters.splice(index, 1);
      completion.reject(new BridgeFailure("input_error"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    return completion.promise.finally(() => signal.removeEventListener("abort", cancel));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#input.removeListener("readable", this.#onReadable);
    this.#input.removeListener("end", this.#onEnd);
    this.#input.removeListener("close", this.#onClose);
    this.#input.removeListener("error", this.#onError);
    this.#input.pause();
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(undefined);
  }

  #pump(): void {
    if (this.#disposed || this.#failure || this.#ended) return;
    try {
      let chunk: unknown;
      while ((chunk = this.#input.read()) !== null) {
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
          this.#fail("input_frame_invalid");
          return;
        }
        this.#consume(Buffer.from(chunk));
        if (this.#failure) return;
      }
    } catch {
      this.#fail("input_error");
    }
  }

  #consume(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(offset, end);
      if (this.#pendingBytes + part.length > MAX_JSONL_LINE_BYTES) {
        this.#fail("input_frame_too_large");
        return;
      }
      if (part.length > 0) {
        this.#parts.push(Buffer.from(part));
        this.#pendingBytes += part.length;
      }
      if (newline >= 0) {
        let frame = Buffer.concat(this.#parts, this.#pendingBytes);
        if (frame.at(-1) === 0x0d) frame = frame.subarray(0, frame.length - 1);
        this.#parts.length = 0;
        this.#pendingBytes = 0;
        if (frame.length === 0) {
          this.#fail("input_frame_invalid");
          return;
        }
        let line: string;
        try {
          line = new TextDecoder("utf-8", { fatal: true }).decode(frame);
        } catch {
          this.#fail("input_frame_invalid");
          return;
        }
        this.#deliver(line);
        if (this.#failure) return;
        offset = newline + 1;
      } else {
        return;
      }
    }
  }

  #deliver(line: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(line);
      return;
    }
    if (this.#queue.length >= MAX_QUEUED_FRAMES) {
      this.#fail("input_frame_invalid");
      return;
    }
    this.#queue.push(line);
  }

  #finish(): void {
    if (this.#disposed || this.#ended || this.#failure) return;
    this.#pump();
    if (this.#failure) return;
    if (this.#pendingBytes > 0) {
      this.#fail("input_frame_invalid");
      return;
    }
    this.#ended = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.resolve(undefined);
  }

  #fail(code: FailureCode): void {
    if (this.#failure || this.#disposed) return;
    this.#failure = new BridgeFailure(code);
    this.#input.pause();
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(this.#failure);
  }
}

function parseLine(line: string, maxBytes: number): unknown {
  if (byteLength(line) > maxBytes) throw new BridgeFailure("input_frame_too_large");
  try {
    return JSON.parse(line);
  } catch {
    throw new BridgeFailure("input_frame_invalid");
  }
}

function classifyRequestFailure(stats: FetchStatistics): "rejected" | "effect_unknown" {
  return stats.dispatched > 0 ? "effect_unknown" : "rejected";
}

async function sendRequestResponse(
  output: Writable,
  identity: ResponseIdentity,
  status: "completed" | "rejected" | "effect_unknown",
  reasonCode: FailureCode | null,
  messageJson: string | null = null,
): Promise<void> {
  await writeJsonLine(output, modelResponse(identity, status, reasonCode, messageJson), MAX_JSONL_LINE_BYTES);
}

async function dispatchOneRequest(
  runtime: PinnedRuntime,
  key: ResolvedApiKey,
  request: NativeRequest,
  identity: ResponseIdentity,
  deadlineMs: number,
  input: BoundedJsonlReader,
  externalSignal: AbortSignal | undefined,
  output: Writable,
): Promise<void> {
  const stats: FetchStatistics = { attempts: 0, dispatched: 0, retryBlocked: false, endpointRejected: false };
  const controller = new AbortController();
  let cancelCode: FailureCode | undefined;
  const abortFromCaller = (): void => {
    cancelCode = "dispatch_cancelled";
    controller.abort();
  };
  if (externalSignal?.aborted) {
    await sendRequestResponse(output, identity, "rejected", "cancelled_before_dispatch");
    return;
  }
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const deadlineTimer = setTimeout(() => {
    cancelCode = "dispatch_deadline";
    controller.abort();
  }, deadlineMs);
  const monitor = new AbortController();
  const trailingInput = input.next(monitor.signal).then(
    line => {
      if (line === undefined) return { kind: "eof" as const };
      return { kind: "extra" as const };
    },
    () => ({ kind: "input_error" as const }),
  );
  const { promise: abortOutcome, resolve: resolveAbort } = Promise.withResolvers<{ kind: "cancel" }>();
  if (controller.signal.aborted) {
    resolveAbort({ kind: "cancel" });
  } else {
    controller.signal.addEventListener("abort", () => resolveAbort({ kind: "cancel" }), { once: true });
  }

  let streamResult: Promise<AssistantMessage>;
  try {
    const fetch = makeOneShotProviderFetch(controller.signal, stats);
    const options: SimpleStreamOptions = {
      maxTokens: request.options.maxTokens,
      reasoning: request.options.reasoning as SimpleStreamOptions["reasoning"],
      apiKey: key.apiKey,
      credentialId: key.credentialId,
      oauthIdentity: key.oauthIdentity,
      signal: controller.signal,
      fetch,
      preferWebsockets: false,
    };
    streamResult = runtime.streamSimple(runtime.model, request.context, options).result();
  } catch {
    monitor.abort();
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
    await sendRequestResponse(output, identity, "rejected", "dispatch_failed");
    return;
  }

  const completed = streamResult.then(
    message => ({ kind: "completed" as const, message }),
    () => ({ kind: "failed" as const }),
  );
  const outcome = await Promise.race([completed, trailingInput, abortOutcome]);
  monitor.abort();
  if (outcome.kind === "cancel" || outcome.kind === "eof" || outcome.kind === "extra" || outcome.kind === "input_error") {
    if (outcome.kind === "eof" || outcome.kind === "extra" || outcome.kind === "input_error") {
      cancelCode = outcome.kind === "eof" ? "dispatch_cancelled" : "input_error";
      if (!controller.signal.aborted) controller.abort();
    }
    const reason = cancelCode ?? "dispatch_cancelled";
    const status = classifyRequestFailure(stats);
    await sendRequestResponse(output, identity, status, reason);
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
    try {
      await streamResult;
    } catch {
      // Retain this child as the owner until the SDK/provider stream drains.
    }
    return;
  }

  clearTimeout(deadlineTimer);
  externalSignal?.removeEventListener("abort", abortFromCaller);
  if (outcome.kind === "failed") {
    const status = classifyRequestFailure(stats);
    await sendRequestResponse(output, identity, status, stats.retryBlocked ? "dispatch_retry_blocked" : "dispatch_failed");
    return;
  }
  if (stats.retryBlocked) {
    await sendRequestResponse(output, identity, "effect_unknown", "dispatch_retry_blocked");
    return;
  }
  if (stats.endpointRejected) {
    await sendRequestResponse(output, identity, stats.dispatched > 0 ? "effect_unknown" : "rejected", "dispatch_endpoint_rejected");
    return;
  }
  if (stats.dispatched !== 1) {
    await sendRequestResponse(output, identity, "rejected", "dispatch_failed");
    return;
  }
  const message = outcome.message;
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const status = classifyRequestFailure(stats);
    await sendRequestResponse(output, identity, status, message.stopReason === "aborted" ? "dispatch_cancelled" : "dispatch_failed");
    return;
  }
  const requestTools = new Set(request.context.tools?.map((tool) => tool.name) ?? []);
  const validation = validateAssistantMessage(message, runtime.model, requestTools);
  if (validation) {
    await sendRequestResponse(output, identity, "rejected", validation);
    return;
  }
  let messageJson: string;
  try {
    const serialized = JSON.stringify(message);
    if (typeof serialized !== "string") throw new BridgeFailure("assistant_invalid");
    messageJson = serialized;
  } catch {
    await sendRequestResponse(output, identity, "rejected", "assistant_invalid");
    return;
  }
  if (byteLength(messageJson) > MAX_ASSISTANT_BYTES) {
    await sendRequestResponse(output, identity, "rejected", "assistant_too_large");
    return;
  }
  await sendRequestResponse(output, identity, "completed", null, messageJson);
}

async function createInMemoryAuthStorage(runtime: PinnedRuntime): Promise<AuthStorage> {
  const options: AuthStorageOptions = {
    configValueResolver: async () => undefined,
    usageProviderResolver: () => undefined,
    refreshOAuthCredential: async () => {
      throw new Error("refresh_disabled");
    },
    sourceLabel: "ghost subscription in-memory credential snapshot",
  };
  try {
    return await runtime.AuthStorage.create(":memory:", options);
  } catch {
    throw new BridgeFailure("memory_auth_unavailable");
  }
}


export async function runSubscriptionNativeBridge(io: SubscriptionNativeBridgeIo): Promise<number> {
  const reader = new BoundedJsonlReader(io.input);
  let storage: AuthStorage | undefined;
  let releaseSessionRestriction: (() => void) | undefined;
  try {
    const configureLine = await reader.next();
    if (configureLine === undefined) throw new BridgeFailure("input_eof");
    const configureValue = parseLine(configureLine, MAX_AUTH_FRAME_BYTES);
    const configure = validateConfigureFrame(configureValue);
    const runtime = await loadPinnedRuntime(configure.sdk_package_root);
    const credential = await readCanonicalCredentialSnapshot(configure.auth_file);
    storage = await createInMemoryAuthStorage(runtime);
    const authStorage = storage;
    try {
      await authStorage.credentials.set(MODEL_PROVIDER, credential);
    } catch {
      throw new BridgeFailure("memory_auth_unavailable");
    }
    const storedRows = authStorage.credentials.list(MODEL_PROVIDER);
    const snapshotRows = authStorage.credentials.snapshot().credentials;
    if (
      storedRows.length !== 1 ||
      storedRows[0]!.credential.type !== "oauth" ||
      snapshotRows.length !== 1 ||
      snapshotRows[0]!.id !== storedRows[0]!.id ||
      typeof snapshotRows[0]!.identityKey !== "string"
    ) {
      throw new BridgeFailure("credential_unavailable");
    }
    const restriction = authStorage.sessions.restrict(MODEL_PROVIDER, AUTH_SESSION_ID, [
      snapshotRows[0]!.identityKey!,
    ]);
    releaseSessionRestriction = () =>
      authStorage.sessions.unrestrict(MODEL_PROVIDER, AUTH_SESSION_ID, restriction);
    const initialKey = await runtime.resolveGatewayApiKey(
      authStorage,
      runtime.model,
      AUTH_SESSION_ID,
      new AbortController().signal,
      "subscription-native-stdio",
    );
    if (
      "status" in initialKey ||
      !initialKey.apiKey ||
      initialKey.credentialId !== storedRows[0]!.id
    ) {
      throw new BridgeFailure("credential_unavailable");
    }

    await writeJsonLine(
      io.output,
      {
        version: 1,
        kind: "ready",
        sdk_version: SDK_VERSION,
        provider: MODEL_PROVIDER,
        model_id: MODEL_ID,
        thinking: "max",
        resolved_reasoning: runtime.reasoning,
      },
      MAX_AUTH_FRAME_BYTES,
    );

    // One credential snapshot per owned execution; one guarded SDK generation
    // per original model request. Never reopen accounts between tool turns.
    for (let count = 0; count < 16; count++) {
      const requestLine = await reader.next(io.signal);
      if (requestLine === undefined) return 0;
      let requestValue: unknown;
      try {
        requestValue = parseLine(requestLine, 2 * MAX_PAYLOAD_BYTES + MAX_FRAME_OVERHEAD_BYTES);
      } catch (error) {
        if (error instanceof BridgeFailure && error.code === "input_frame_too_large") {
          throw error;
        }
        throw new BridgeFailure("invalid_request_envelope");
      }
      const identity = extractResponseIdentity(requestValue);
      if (!identity) throw new BridgeFailure("invalid_request_envelope");
      const rejection = requestRejectionReason(requestValue, identity);
      if (rejection) {
        await sendRequestResponse(io.output, identity, "rejected", rejection);
        return 0;
      }
      const envelope = requestValue as ModelRequestFrame;
      let request: NativeRequest;
      try {
        request = validateNativePayload(envelope.payload_json, runtime.reasoning);
      } catch (error) {
        const code = error instanceof BridgeFailure ? error.code : "invalid_native_payload";
        await sendRequestResponse(io.output, identity, "rejected", code);
        return 0;
      }
      if (reader.ended) {
        await sendRequestResponse(io.output, identity, "rejected", "stdin_closed_before_dispatch");
        return 0;
      }
      await dispatchOneRequest(
        runtime,
        initialKey,
        request,
        identity,
        configure.deadline_ms,
        reader,
        io.signal,
        io.output,
      );
      if (reader.ended || io.signal?.aborted) return 0;
    }
    return 0;
  } catch (error) {
    const code = error instanceof BridgeFailure ? error.code : "internal_error";
    await writeDiagnostic(io.diagnostics, code);
    return 1;
  } finally {
    releaseSessionRestriction?.();
    reader.dispose();
    try {
      storage?.close();
    } catch {
      // The child terminates with the in-memory credential store closed best-effort.
    }
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  process.exitCode = await runSubscriptionNativeBridge({
    input: process.stdin,
    output: process.stdout,
    diagnostics: process.stderr,
    signal: controller.signal,
  }).catch(() => {
    process.stderr.write("subscription-native-bridge:internal_error\n");
    return 1;
  });
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  process.stdin.destroy();
}
