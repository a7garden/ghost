import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@ghost/contract";
import { CommandError, forbidden, invalid, notFound } from "../core/errors.ts";
import { HOST_VERSION } from "../update/identity.ts";

/** Rewrites a stdio server's argv before launch, such as wrapping it in a sandbox. */
export type CommandWrapper = (argv: string[]) => string[];
export const identityCommand: CommandWrapper = (argv) => argv;

export interface McpTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: Record<string, unknown>;
  /** From the owner's `readTools` only; every unlisted tool is a write. */
  access: "read" | "write";
  /** As the server declared them. Untrusted: never used to classify a tool. */
  annotations: Record<string, unknown> | null;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource_link"; uri: string; name: string; mimeType: string | null; description: string | null };

export interface McpCallResult {
  content: McpContent[];
  /** The tool reported a failure in its result; the content explains it. */
  isError: boolean;
  /** Some content was cut or omitted to stay within the limits. */
  truncated: boolean;
}

/** MCP client of the Host. Implemented by `McpClients`. */
export interface McpPort {
  /** Every page of the server's tools; cached until the server announces a change. */
  listTools(serverId: string, signal?: AbortSignal): Promise<McpTool[]>;
  callTool(serverId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  /** Last stderr of a stdio server, kept across restarts. Owner diagnostics only: may hold secrets, never show it to a model. */
  stderrTail(serverId: string): string;
  close(): Promise<void>;
}

export interface McpLimits {
  connectMs: number;
  listMs: number;
  callMs: number;
  /** Largest single JSON-RPC message or SSE event read from a server. */
  messageBytes: number;
  /** UTF-8 text (including resource links) returned by one call. */
  textBytes: number;
  /** Base64 image data returned by one call. */
  imageBytes: number;
  contentItems: number;
  descriptionChars: number;
  tools: number;
  pages: number;
  stderrChars: number;
}

export const MCP_LIMITS: McpLimits = {
  connectMs: 30_000,
  listMs: 30_000,
  callMs: 120_000,
  messageBytes: 16 * 1024 * 1024,
  textBytes: 64_000,
  imageBytes: 5 * 1024 * 1024,
  contentItems: 64,
  descriptionChars: 4_096,
  tools: 1_000,
  pages: 100,
  stderrChars: 16_384,
};

export interface McpOptions {
  /** Current configuration of a server, or null when it is not registered. */
  server(id: string): McpServer | null;
  /** Values for a stdio server's `env` names, from the vault. */
  env?(server: McpServer): Promise<Record<string, string>>;
  /** Headers carrying the credential of an http server's connection. */
  authHeaders?(connectionId: string): Promise<Record<string, string>>;
  wrapCommand?: CommandWrapper;
  /** Called when a server announces `notifications/tools/list_changed`. */
  onToolsChanged?(serverId: string): void;
  limits?: Partial<McpLimits>;
}

const unavailable = (message: string) => new CommandError("unavailable", message);
const IMAGE_TYPES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const clip = (value: string, max: number) => value.length > max ? value.slice(0, max) : value;

/** https anywhere; plain http only to this machine. Credentials belong in a connection, not the URL. */
export function assertMcpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("MCP server URL is not a valid URL");
  }
  if (url.username || url.password) throw invalid("MCP server URL must not carry credentials; use a connection");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopback(url.hostname)) return url;
  throw forbidden("MCP server URL must be https, or http on a loopback address");
}

function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  // WHATWG URL serializes IPv6 canonically, so ::1 and ::ffff:127.x.y.z have one spelling each.
  return isIP(host) === 6 && (host === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host));
}

/**
 * Fails a response body past `limit` bytes; for an SSE stream the limit applies to each event.
 * `overflow` runs too, because a broken SSE stream alone would leave its request waiting for the deadline.
 */
function limitBody(limit: number, sse: boolean, overflow: () => void): TransformStream<Uint8Array, Uint8Array> {
  let size = 0;
  let line = 0;
  let previous = 0;
  const fail = (controller: TransformStreamDefaultController<Uint8Array>) => {
    overflow();
    controller.error(new Error(`MCP server sent a message over ${limit} bytes`));
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (!sse) {
        size += chunk.byteLength;
        if (size > limit) fail(controller);
        else controller.enqueue(chunk);
        return;
      }
      for (const byte of chunk) {
        if (byte === 10 || byte === 13) {
          // A blank line ends an event; the LF of a CRLF pair is not a second line end.
          if (line === 0 && !(byte === 10 && previous === 13)) size = 0;
          line = 0;
        } else {
          line++;
          if (++size > limit) {
            fail(controller);
            return;
          }
        }
        previous = byte;
      }
      controller.enqueue(chunk);
    },
  });
}

function boundedFetch(limit: number, overflow: () => void): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (!response.body || NULL_BODY_STATUS.has(response.status)) return response;
    const sse = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    return new Response(response.body.pipeThrough(limitBody(limit, sse, overflow)), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Cuts UTF-8 at a character boundary at or below `max` bytes. */
function cutUtf8(value: string, max: number): string {
  const bytes = encoder.encode(value);
  let end = Math.min(max, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function boundResult(result: CallToolResult, limits: McpLimits): McpCallResult {
  const content: McpContent[] = [];
  let textLeft = limits.textBytes;
  let imageLeft = limits.imageBytes;
  let truncated = result.content.length > limits.contentItems;
  const charge = (value: string) => {
    const size = encoder.encode(value).byteLength;
    if (size > textLeft) return false;
    textLeft -= size;
    return true;
  };
  const text = (value: string) => {
    if (charge(value)) {
      content.push({ type: "text", text: value });
      return;
    }
    truncated = true;
    const part = cutUtf8(value, textLeft);
    // Text after a cut would read as if nothing were missing between the pieces.
    textLeft = 0;
    if (part) content.push({ type: "text", text: part });
  };
  for (const item of result.content.slice(0, limits.contentItems)) {
    switch (item.type) {
      case "text":
        text(item.text);
        break;
      case "image":
        if (!IMAGE_TYPES[item.mimeType]) text(`[image omitted: unsupported type ${clip(item.mimeType, 64)}]`);
        else if (item.data.length > imageLeft) {
          truncated = true;
          text(`[image omitted: over the size limit]`);
        } else {
          imageLeft -= item.data.length;
          content.push({ type: "image", mimeType: item.mimeType, data: item.data });
        }
        break;
      case "audio":
        text(`[audio omitted: ${clip(item.mimeType, 64)}]`);
        break;
      case "resource_link": {
        const link: McpContent = {
          type: "resource_link",
          uri: clip(item.uri, 2_048),
          name: clip(item.name, 256),
          mimeType: item.mimeType === undefined ? null : clip(item.mimeType, 128),
          description: item.description === undefined ? null : clip(item.description, 1_024),
        };
        if (charge(JSON.stringify(link))) content.push(link);
        else truncated = true;
        break;
      }
      case "resource":
        if ("text" in item.resource) text(`[resource ${clip(item.resource.uri, 2_048)}]\n${item.resource.text}`);
        else text(`[binary resource omitted: ${clip(item.resource.uri, 2_048)}]`);
        break;
    }
  }
  if (result.structuredContent !== undefined && !result.content.some((item) => item.type === "text")) text(JSON.stringify(result.structuredContent));
  return { content, isError: result.isError === true, truncated };
}

type RawTool = Omit<McpTool, "access">;

function toolOf(tool: Tool, limits: McpLimits): RawTool {
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title ?? null,
    description: tool.description === undefined ? null : clip(tool.description, limits.descriptionChars),
    inputSchema: tool.inputSchema,
    annotations: tool.annotations ?? null,
  };
}

class Session {
  closed = false;
  tools: RawTool[] | null = null;
  /** Bumped by every list_changed notification so a listing that raced one is not cached. */
  generation = 0;

  constructor(
    readonly client: Client,
    readonly transport: Transport,
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }
}

interface Entry {
  key: string;
  ready: Promise<Session>;
}

/**
 * Lazily connected MCP clients, one per server. A server that exits or breaks its transport is
 * dropped and relaunched on the next use; a changed transport configuration reconnects.
 */
export class McpClients implements McpPort {
  private readonly limits: McpLimits;
  private readonly sessions = new Map<string, Entry>();
  private readonly stderr = new Map<string, string>();
  private shut = false;

  constructor(private readonly options: McpOptions) {
    this.limits = { ...MCP_LIMITS, ...options.limits };
  }

  async listTools(serverId: string, signal?: AbortSignal): Promise<McpTool[]> {
    const { server, session } = await this.session(serverId);
    const read = new Set(server.readTools);
    const withAccess = (tools: RawTool[]) => tools.map((tool): McpTool => ({ ...tool, access: read.has(tool.name) ? "read" : "write" }));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (session.tools) return withAccess(session.tools);
      const generation = session.generation;
      let tools: RawTool[];
      try {
        tools = await this.fetchTools(session, signal);
      } catch (error) {
        throw this.failure(server, session, error, "listing tools", this.limits.listMs, signal);
      }
      if (session.generation === generation) {
        session.tools = tools;
        return withAccess(tools);
      }
    }
    throw unavailable(`MCP server ${server.name} keeps changing its tool list`);
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (name.length === 0 || name.length > 128) throw invalid("MCP tool name must be 1 to 128 characters");
    const { server, session } = await this.session(serverId);
    try {
      const result = await session.client.callTool({ name, arguments: args }, undefined, {
        timeout: this.limits.callMs,
        maxTotalTimeout: this.limits.callMs,
        ...(signal ? { signal } : {}),
      });
      return boundResult(result as CallToolResult, this.limits);
    } catch (error) {
      throw this.failure(server, session, error, `tool ${clip(name, 128)}`, this.limits.callMs, signal);
    }
  }

  stderrTail(serverId: string): string {
    return this.stderr.get(serverId) ?? "";
  }

  async close(): Promise<void> {
    this.shut = true;
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map((entry) => entry.ready.then((session) => session.close(), () => undefined)));
  }

  private async session(serverId: string): Promise<{ server: McpServer; session: Session }> {
    const server = this.options.server(serverId);
    if (!server) throw notFound(`MCP server ${serverId} is not registered`);
    if (!server.enabled) throw forbidden(`MCP server ${server.name} is disabled`);
    const key = JSON.stringify(server.transport);
    for (let launches = 0; ; ) {
      if (this.shut) throw unavailable("MCP clients are shut down");
      const entry = this.sessions.get(serverId);
      if (entry?.key === key) {
        const session = await entry.ready;
        if (!session.closed) return { server, session };
        if (this.sessions.get(serverId) === entry) this.sessions.delete(serverId);
        continue;
      }
      if (entry) {
        this.sessions.delete(serverId);
        void entry.ready.then((session) => session.close(), () => undefined);
      }
      if (launches++ === 2) throw unavailable(`MCP server ${server.name} stopped right after starting`);
      const fresh: Entry = { key, ready: this.connect(server) };
      this.sessions.set(serverId, fresh);
      fresh.ready.catch(() => {
        if (this.sessions.get(serverId) === fresh) this.sessions.delete(serverId);
      });
    }
  }

  private async connect(server: McpServer): Promise<Session> {
    const transport = server.transport.kind === "stdio" ? await this.stdio(server) : await this.http(server);
    const client = new Client({ name: "ghost", version: HOST_VERSION }, { capabilities: {} });
    const session = new Session(client, transport);
    client.onclose = () => {
      session.closed = true;
    };
    // Transport errors surface as failed requests or a close; nothing reads them here.
    client.onerror = () => undefined;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      session.generation++;
      session.tools = null;
      this.options.onToolsChanged?.(server.id);
    });
    try {
      await client.connect(transport, { timeout: this.limits.connectMs });
    } catch (error) {
      await session.close();
      const status = error instanceof StreamableHTTPError && error.code !== undefined ? ` (HTTP ${error.code})` : "";
      throw unavailable(`MCP server ${server.name} did not start or answer initialize${status}`);
    }
    if (this.shut) {
      await session.close();
      throw unavailable("MCP clients are shut down");
    }
    return session;
  }

  private async stdio(server: McpServer): Promise<Transport> {
    if (server.transport.kind !== "stdio") throw new Error("not a stdio server");
    const { command, args, cwd } = server.transport;
    const argv = (this.options.wrapCommand ?? identityCommand)([command, ...args]);
    const [program, ...rest] = argv;
    if (program === undefined || program === "" || argv.some((part) => part.includes("\0"))) throw invalid(`MCP server ${server.name} has an invalid command`);
    const env = await this.envFor(server);
    const transport = new StdioClientTransport({
      command: program,
      args: rest,
      env,
      ...(cwd === null ? {} : { cwd }),
      stderr: "pipe",
      maxBufferSize: this.limits.messageBytes,
    });
    this.stderr.delete(server.id);
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const tail = (this.stderr.get(server.id) ?? "") + chunk.toString();
      this.stderr.set(server.id, tail.length > this.limits.stderrChars ? tail.slice(-this.limits.stderrChars) : tail);
    });
    return transport;
  }

  private async envFor(server: McpServer): Promise<Record<string, string>> {
    if (server.transport.kind !== "stdio" || server.transport.env.length === 0) return {};
    if (!this.options.env) throw unavailable(`MCP server ${server.name} needs secrets, but no secret source is configured`);
    const values = await this.options.env(server);
    const env: Record<string, string> = {};
    for (const name of server.transport.env) {
      const value = values[name];
      if (value === undefined) throw unavailable(`MCP server ${server.name} needs a value for ${name}`);
      if (value.includes("\0")) throw invalid(`The value for ${name} contains a NUL byte`);
      env[name] = value;
    }
    return env;
  }

  private async http(server: McpServer): Promise<Transport> {
    if (server.transport.kind !== "http") throw new Error("not an http server");
    const url = assertMcpUrl(server.transport.url);
    const { connectionId } = server.transport;
    let headers: Record<string, string> = {};
    if (connectionId !== null) {
      if (!this.options.authHeaders) throw unavailable(`MCP server ${server.name} needs a connection, but no credential source is configured`);
      headers = await this.options.authHeaders(connectionId);
    }
    const transport: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: boundedFetch(this.limits.messageBytes, () => void transport.close()),
    });
    return transport;
  }

  private async fetchTools(session: Session, signal: AbortSignal | undefined): Promise<RawTool[]> {
    const tools: RawTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < this.limits.pages; page++) {
      const result = await session.client.listTools(cursor === undefined ? undefined : { cursor }, {
        timeout: this.limits.listMs,
        ...(signal ? { signal } : {}),
      });
      for (const tool of result.tools) {
        if (tools.length === this.limits.tools) return tools;
        tools.push(toolOf(tool, this.limits));
      }
      cursor = result.nextCursor;
      if (cursor === undefined || seen.has(cursor)) return tools;
      seen.add(cursor);
    }
    return tools;
  }

  /** Errors safe to show a model: never the server's stderr, never raw transport detail. */
  private failure(server: McpServer, session: Session, error: unknown, what: string, deadlineMs: number, signal: AbortSignal | undefined): unknown {
    if (signal?.aborted) return signal.reason;
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) return unavailable(`MCP server ${server.name} did not finish ${what} within ${Math.ceil(deadlineMs / 1000)} seconds`);
      if (error.code === ErrorCode.ConnectionClosed) return unavailable(`MCP server ${server.name} stopped during ${what}; it restarts on the next use`);
      return invalid(`MCP server ${server.name} refused ${what}: ${clip(error.message, 1_000)}`);
    }
    // A broken transport or a malformed answer: relaunch on the next use rather than trust this session.
    void session.close();
    return unavailable(`MCP server ${server.name} failed during ${what}`);
  }
}
