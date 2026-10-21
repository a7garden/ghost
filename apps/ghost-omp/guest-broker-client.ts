import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { hasExactWorkerToolScope, type WorkerToolName } from "./native-tool-policy.ts";

const CONTRACT_VERSION = 1;
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_JS_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_CONTEXT_WINDOW = 872_000;
const MAX_PAYLOAD_BYTES = 4_194_304;
const MAX_REQUEST_FILE_BYTES = 2 * MAX_PAYLOAD_BYTES + 65_536;
const MAX_RESPONSE_FILE_BYTES = 2 * MAX_PAYLOAD_BYTES + 65_536;

interface GuestBrokerScope {
  version: 1;
  execution_id: string;
  authority_epoch: number;
  request_directory: string;
  response_directory: string;
  deadline_ms: number;
  max_requests: number;
}

export interface GuestModelConfig extends GuestBrokerScope {
  model_id: string;
  max_tokens: number;
  context_window: number;
  allowed_tools: WorkerToolName[];
}

export interface SubscriptionGuestConfig extends GuestBrokerScope {
  kind: "subscription_native";
  provider: "openai-codex";
  model_id: "gpt-6-luna";
  thinking: "max";
  resolved_reasoning: "max";
  max_tokens: 1024;
  context_window: number;
  allowed_tools: WorkerToolName[];
}


export type GuestBrokerMode =
  | { kind: "local"; config: GuestModelConfig }
  | { kind: "subscription_native"; config: SubscriptionGuestConfig };

type BrokerFileConfig = GuestModelConfig | SubscriptionGuestConfig;

interface OpenDirectory {
  handle: FileHandle;
  anchoredPath: string;
}

export interface GuestBrokerFileLimits {
  maxPayloadBytes: number;
  maxRequestFileBytes: number;
  maxResponseFileBytes: number;
}

export interface GuestBrokerFileReceipt {
  requestId: string;
  payloadSha256: string;
  responseBytes: Uint8Array;
}

export interface GuestBrokerFileClient {
  exchange(payloadBytes: Uint8Array, signal?: AbortSignal): Promise<GuestBrokerFileReceipt>;
  close(): Promise<void>;
}

export async function readGuestBrokerConfig(configPath: string): Promise<GuestBrokerMode> {
  if (process.platform !== "linux" || process.arch !== "arm64" || !path.isAbsolute(configPath)) {
    throw new Error("guest broker requires the pinned Linux ARM runtime and an absolute config path");
  }
  const canonicalPath = await realpath(configPath);
  if (canonicalPath !== path.resolve(configPath)) throw new Error("guest broker config path is not canonical");
  const file = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) {
      throw new Error("guest broker config file rejected");
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("guest broker config size rejected");
    const mode = parseConfig(bytes);
    await validateGuestDirectories(mode.config);
    return mode;
  } finally {
    await file.close();
  }
}

function parseConfig(bytes: Uint8Array): GuestBrokerMode {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("guest broker config is malformed");
  }
  const object = asRecord(value);
  if (object.kind === "subscription_native") {
    return { kind: "subscription_native", config: parseSubscriptionConfig(object) };
  }
  if (Object.hasOwn(object, "kind")) throw new Error("guest broker config kind rejected");
  return { kind: "local", config: parseLocalConfig(object) };
}

function parseLocalConfig(object: Record<string, unknown>): GuestModelConfig {
  const keys = [
    "version",
    "execution_id",
    "authority_epoch",
    "request_directory",
    "response_directory",
    "model_id",
    "max_tokens",
    "context_window",
    "allowed_tools",
    "deadline_ms",
    "max_requests",
  ];
  requireExactKeys(object, keys, "guest broker config");
  const allowedTools = object.allowed_tools;
  if (!hasExactWorkerToolScope(allowedTools)) {
    throw new Error("guest broker tool scope rejected");
  }
  const config: GuestModelConfig = {
    version: requireInteger(object.version, 1, 1, "version") as 1,
    execution_id: requireString(object.execution_id, 1, 128, "execution_id"),
    authority_epoch: requireInteger(object.authority_epoch, 1, MAX_JS_INTEGER, "authority_epoch"),
    request_directory: requireString(object.request_directory, 1, 4096, "request_directory"),
    response_directory: requireString(object.response_directory, 1, 4096, "response_directory"),
    model_id: requireString(object.model_id, 1, 128, "model_id"),
    max_tokens: requireInteger(object.max_tokens, 1, 4096, "max_tokens"),
    context_window: requireInteger(object.context_window, 1, 16_384, "context_window"),
    allowed_tools: [...allowedTools],
    deadline_ms: requireInteger(object.deadline_ms, 1, 180_000, "deadline_ms"),
    max_requests: requireInteger(object.max_requests, 1, 16, "max_requests"),
  };
  if (/\s|\p{Cc}/u.test(config.model_id) || config.context_window < config.max_tokens) {
    throw new Error("guest broker model binding rejected");
  }
  return config;
}

function parseSubscriptionConfig(object: Record<string, unknown>): SubscriptionGuestConfig {
  const keys = [
    "version",
    "kind",
    "execution_id",
    "authority_epoch",
    "request_directory",
    "response_directory",
    "provider",
    "model_id",
    "thinking",
    "resolved_reasoning",
    "max_tokens",
    "context_window",
    "allowed_tools",
    "deadline_ms",
    "max_requests",
  ];
  requireExactKeys(object, keys, "subscription broker config");
  const tools = object.allowed_tools;
  if (!hasExactWorkerToolScope(tools)) {
    throw new Error("subscription broker tool scope rejected");
  }
  if (object.kind !== "subscription_native"
    || object.provider !== "openai-codex"
    || object.model_id !== "gpt-6-luna"
    || object.thinking !== "max"
    || object.resolved_reasoning !== "max"
    || object.max_tokens !== 1024
    || object.deadline_ms !== 180_000
    || object.max_requests !== 16) {
    throw new Error("subscription broker selector or limits rejected");
  }
  return {
    version: requireInteger(object.version, 1, 1, "version") as 1,
    kind: "subscription_native",
    execution_id: requireString(object.execution_id, 1, 128, "execution_id"),
    authority_epoch: requireInteger(object.authority_epoch, 1, MAX_JS_INTEGER, "authority_epoch"),
    request_directory: requireString(object.request_directory, 1, 4096, "request_directory"),
    response_directory: requireString(object.response_directory, 1, 4096, "response_directory"),
    provider: "openai-codex",
    model_id: "gpt-6-luna",
    thinking: "max",
    resolved_reasoning: "max",
    max_tokens: 1024,
    context_window: requireInteger(object.context_window, 1024, MAX_CONTEXT_WINDOW, "context_window"),
    allowed_tools: [...tools],
    deadline_ms: 180_000,
    max_requests: 16,
  };
}

function requireExactKeys(object: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(object).length !== keys.length || Object.keys(object).some((key) => !keys.includes(key))) {
    throw new Error(`${label} fields rejected`);
  }
}

async function validateGuestDirectories(config: BrokerFileConfig): Promise<void> {
  if (path.resolve(config.request_directory) !== config.request_directory
    || path.resolve(config.response_directory) !== config.response_directory
    || config.request_directory === config.response_directory
    || isNested(config.request_directory, config.response_directory)
    || isNested(config.response_directory, config.request_directory)) {
    throw new Error("guest broker mount paths rejected");
  }
  for (const directory of [config.request_directory, config.response_directory]) {
    if (await realpath(directory) !== directory) throw new Error("guest broker mount path is not canonical");
    const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
    try {
      if (!(await handle.stat()).isDirectory()) throw new Error("guest broker mount is not a directory");
    } finally {
      await handle.close();
    }
  }
}

export async function openGuestBrokerFileClient(
  config: BrokerFileConfig,
  limits: GuestBrokerFileLimits,
): Promise<GuestBrokerFileClient> {
  validateLimits(limits);
  await validateGuestDirectories(config);
  const requestDirectory = await openDirectory(config.request_directory);
  let responseDirectory: OpenDirectory;
  try {
    responseDirectory = await openDirectory(config.response_directory);
  } catch (error) {
    await requestDirectory.handle.close();
    throw error;
  }

  let closed = false;
  let closePromise: Promise<void> | undefined;
  let requestsUsed = 0;
  const closeController = new AbortController();
  const active = new Set<Promise<GuestBrokerFileReceipt>>();

  const exchange = async (payloadBytes: Uint8Array, callerSignal?: AbortSignal): Promise<GuestBrokerFileReceipt> => {
    if (closed) throw new Error("guest broker file client is closed");
    if (callerSignal?.aborted || closeController.signal.aborted) throw abortError();
    if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > limits.maxPayloadBytes) {
      throw new Error("guest broker request size rejected");
    }
    let payloadJson: string;
    try {
      payloadJson = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    } catch {
      throw new Error("guest broker request encoding rejected");
    }
    if (requestsUsed >= config.max_requests) throw new Error("guest broker request limit reached");
    const requestId = randomUUID();
    const payloadSha256 = sha256(payloadBytes);
    const wire = JSON.stringify({
      version: CONTRACT_VERSION,
      request_id: requestId,
      execution_id: config.execution_id,
      authority_epoch: config.authority_epoch,
      payload_json: payloadJson,
      payload_sha256: payloadSha256,
    });
    if (Buffer.byteLength(wire, "utf8") > limits.maxRequestFileBytes) {
      throw new Error("guest broker request envelope rejected");
    }
    requestsUsed += 1;
    const operation = exchangeFiles(requestId, payloadSha256, wire, callerSignal);
    active.add(operation);
    try {
      const receipt = await operation;
      if (callerSignal?.aborted || closeController.signal.aborted) {
        await writeCancel(requestDirectory, `${requestId}.cancel.json`, requestId, payloadSha256);
        throw abortError();
      }
      return receipt;
    } finally {
      active.delete(operation);
    }
  };

  const exchangeFiles = async (
    requestId: string,
    payloadSha256: string,
    wire: string,
    callerSignal?: AbortSignal,
  ): Promise<GuestBrokerFileReceipt> => {
    const signal = callerSignal === undefined
      ? closeController.signal
      : AbortSignal.any([callerSignal, closeController.signal]);
    const requestFilename = `${requestId}.request.json`;
    const cancelFilename = `${requestId}.cancel.json`;
    await writeAtomic(requestDirectory, requestFilename, wire);
    const deadline = Date.now() + config.deadline_ms;
    while (true) {
      if (signal.aborted) {
        await writeCancel(requestDirectory, cancelFilename, requestId, payloadSha256);
        throw abortError();
      }
      const responseBytes = await readBounded(
        responseDirectory,
        `${requestId}.response.json`,
        limits.maxResponseFileBytes,
      );
      if (responseBytes !== undefined) {
        if (signal.aborted) {
          await writeCancel(requestDirectory, cancelFilename, requestId, payloadSha256);
          throw abortError();
        }
        return { requestId, payloadSha256, responseBytes };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        await writeCancel(requestDirectory, cancelFilename, requestId, payloadSha256);
        throw new Error("guest broker deadline elapsed");
      }
      await pause(Math.min(25, remaining), signal);
    }
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closeController.abort();
    closePromise = (async () => {
      await Promise.allSettled([...active]);
      await responseDirectory.handle.close();
      await requestDirectory.handle.close();
    })();
    return closePromise;
  };

  return { exchange, close };
}

function validateLimits(limits: GuestBrokerFileLimits): void {
  if (!Number.isSafeInteger(limits.maxPayloadBytes)
    || limits.maxPayloadBytes < 1
    || limits.maxPayloadBytes > MAX_PAYLOAD_BYTES
    || !Number.isSafeInteger(limits.maxRequestFileBytes)
    || limits.maxRequestFileBytes < limits.maxPayloadBytes
    || limits.maxRequestFileBytes > MAX_REQUEST_FILE_BYTES
    || !Number.isSafeInteger(limits.maxResponseFileBytes)
    || limits.maxResponseFileBytes < 1
    || limits.maxResponseFileBytes > MAX_RESPONSE_FILE_BYTES) {
    throw new Error("guest broker file limits rejected");
  }
}

async function openDirectory(directory: string): Promise<OpenDirectory> {
  if (await realpath(directory) !== directory) throw new Error("guest broker directory changed");
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("guest broker directory rejected");
    return { handle, anchoredPath: `/proc/self/fd/${handle.fd}` };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writeAtomic(directory: OpenDirectory, filename: string, contents: string): Promise<void> {
  if (path.basename(filename) !== filename || filename.includes("\\")) throw new Error("guest broker filename rejected");
  const target = path.join(directory.anchoredPath, filename);
  const temporary = path.join(directory.anchoredPath, `.guest-${randomUUID()}.tmp`);
  try {
    const existing = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_CLOEXEC,
    );
    await existing.close();
    throw new Error("guest broker request identifier collision");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const file = await open(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    0o600,
  );
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, target);
    await directory.handle.sync();
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeCancel(directory: OpenDirectory, filename: string, requestId: string, digest: string): Promise<void> {
  const marker = JSON.stringify({ version: CONTRACT_VERSION, request_id: requestId, payload_sha256: digest });
  try {
    await writeAtomic(directory, filename, marker);
  } catch {
    throw new Error("guest broker cancellation marker could not be committed");
  }
}

async function readBounded(directory: OpenDirectory, filename: string, maximum: number): Promise<Uint8Array | undefined> {
  if (path.basename(filename) !== filename || filename.includes("\\")) throw new Error("guest broker filename rejected");
  const filePath = path.join(directory.anchoredPath, filename);
  let file: FileHandle;
  try {
    file = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error("guest broker response path rejected");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maximum) {
      throw new Error("guest broker response file rejected");
    }
    const bytes = await file.readFile();
    if (bytes.byteLength > maximum) throw new Error("guest broker response size rejected");
    return bytes;
  } finally {
    await file.close();
  }
}

function requireString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`guest broker ${label} rejected`);
  }
  return value;
}

function requireInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`guest broker ${label} rejected`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guest broker value must be an object");
  }
  return value as Record<string, unknown>;
}

function isNested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
    return promise;
  }
  let cancelTimer = () => {};
  const finish = () => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  };
  const onAbort = () => {
    cancelTimer();
    finish();
  };
  const timer = setTimeout(finish, milliseconds);
  cancelTimer = () => clearTimeout(timer);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return promise;
}

function abortError(): Error {
  return new DOMException("Guest broker request aborted", "AbortError");
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
