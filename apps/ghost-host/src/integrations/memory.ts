import type { Config } from "../config.ts";
import { sha256 } from "../core/ids.ts";
import type { MemoryHit, MemoryPort } from "./ports.ts";

/**
 * Oxibrain personal memory.
 *
 * The engine is a caller-owned child process that speaks newline-delimited
 * JSON-RPC 2.0 over its stdio: `auth` (the token travels in the request, never
 * on the command line), `handshake` (transport capability negotiation), then
 * `tools/call` for every read and write. The child is spawned per operation and
 * killed afterwards, so a revoked token or a changed engine scope is never
 * inherited from a previous session.
 */
const PROTOCOL_VERSION = 1;
const MIN_STORE_FORMAT_VERSION = 1;
const CLIENT_VERSION = "ghost-host";

/** One operation (spawn, authentication, handshake, one tool call) never exceeds this. */
const OPERATION_TIMEOUT_MS = 30_000;
/** Bounded output: a response line larger than this is refused instead of buffered. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Bounded source text, mirroring the legacy source-content limit. */
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
/** Bounded stderr kept for diagnostics. */
const MAX_STDERR_BYTES = 32 * 1024;

/** The token budget range the legacy tool surface accepted. */
const MIN_TOKEN_BUDGET = 128;
const MAX_TOKEN_BUDGET = 2048;
/** The search limit range this host accepts from a model argument. */
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 100;

/** A configured space name: short, ASCII, and safe to send as a JSON value. */
const SPACE_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

interface MemorySettings {
  executable: string;
  dir: string;
  token: string;
  /** Ghost id → Oxibrain space id; `*` is the space of every Ghost without its own entry. */
  spaces: Record<string, string>;
}

type Json = unknown;

interface RpcResponse {
  id?: number;
  result?: Json;
  error?: { code?: number; message?: string };
}

interface ToolResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

/** Rejects with `message` when `promise` does not settle within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** One authenticated stdio session with the Oxibrain engine. */
class BrainSession {
  private nextId = 1;
  private buffer = "";
  private closed = false;
  private stderr = "";
  private constructor(
    private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  static spawn(settings: MemorySettings): BrainSession {
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn([settings.executable, "admin", "serve", "--stdio", "--dir", settings.dir], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        // Only what the engine needs to find its tools and home; host secrets stay out.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      });
    } catch (error) {
      throw new Error(`cannot start the Oxibrain engine: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = new BrainSession(proc, proc.stdout.getReader());
    void drainStderr(proc.stderr, (text) => {
      session.stderr = text;
    });
    return session;
  }

  /** The token is a request parameter; it never appears in argv or the environment. */
  async authenticate(token: string, deadline: number): Promise<void> {
    const id = await this.send("auth", { token });
    const result = recordOf(await this.receive(id, deadline));
    if (result.authenticated !== true) throw new Error("the Oxibrain engine rejected the configured token");
  }

  async handshake(deadline: number): Promise<void> {
    const id = await this.send("handshake", {
      protocol_version: PROTOCOL_VERSION,
      min_compatible: PROTOCOL_VERSION,
      max_compatible: PROTOCOL_VERSION,
      min_store_format_version: MIN_STORE_FORMAT_VERSION,
      client_version: CLIENT_VERSION,
      supported_operations: ["mcp_tool_call", "notifications"],
    });
    await this.receive(id, deadline);
  }

  /** Runs one tool and returns its text content. */
  async callTool(name: string, args: Record<string, Json>, deadline: number): Promise<string> {
    const id = await this.send("tools/call", { name, arguments: args });
    const result = recordOf(await this.receive(id, deadline)) as ToolResult;
    if (result.isError === true) throw new Error(extractText(result) || `the Oxibrain engine failed to run ${name}`);
    return extractText(result);
  }

  async callToolJson(name: string, args: Record<string, Json>, deadline: number): Promise<Json> {
    const text = await this.callTool(name, args, deadline);
    try {
      return JSON.parse(text) as Json;
    } catch {
      throw new Error(`the Oxibrain engine returned malformed JSON for ${name}`);
    }
  }

  async callToolData(name: string, args: Record<string, Json>, deadline: number): Promise<Json> {
    const envelope = recordOf(await this.callToolJson(name, args, deadline));
    if (!("data" in envelope)) throw new Error(`the Oxibrain engine returned no data for ${name}`);
    return envelope.data;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.proc.stdin.end();
    } catch {
      // The child may already be gone; the kill below still reaps it.
    }
    try {
      this.proc.kill();
    } catch {
      // Already exited.
    }
    void this.reader.cancel().catch(() => {});
  }

  private async send(method: string, params: Json): Promise<number> {
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    await this.write(`${request}\n`);
    return id;
  }

  /** Writes one line to the child, however many chunks the pipe takes. */
  private async write(line: string): Promise<void> {
    const bytes = new TextEncoder().encode(line);
    let offset = 0;
    while (offset < bytes.length) {
      offset += this.proc.stdin.write(bytes.subarray(offset));
      await this.proc.stdin.flush();
    }
  }

  private async receive(id: number, deadline: number): Promise<Json> {
    for (;;) {
      const line = await this.readLine(deadline);
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(line) as RpcResponse;
      } catch {
        throw new Error("the Oxibrain engine sent a malformed response");
      }
      // Server-initiated notifications carry no id; they are not answers.
      if (typeof parsed.id !== "number" || parsed.id !== id) continue;
      if (parsed.error) throw new Error(parsed.error.message ?? "the Oxibrain engine rejected the request");
      return parsed.result;
    }
  }

  private async readLine(deadline: number): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      if (this.buffer.length > MAX_RESPONSE_BYTES) throw new Error("the Oxibrain engine response exceeded the size limit");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("the Oxibrain engine timed out");
      const chunk = await withTimeout(this.reader.read(), remaining, "the Oxibrain engine timed out");
      if (chunk.done) throw new Error(`the Oxibrain engine closed the connection${this.stderr ? `: ${this.stderr}` : ""}`);
      this.buffer += new TextDecoder().decode(chunk.value, { stream: true });
    }
  }
}

function extractText(result: ToolResult): string {
  const parts = (result.content ?? [])
    .filter((item) => item.type === undefined || item.type === "text")
    .map((item) => item.text ?? "");
  return parts.join("");
}

/** Keeps the child's stderr from blocking it and preserves a bounded tail for diagnostics. */
async function drainStderr(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
  const reader = stream.getReader();
  let tail = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      tail = (tail + new TextDecoder().decode(chunk.value)).slice(-MAX_STDERR_BYTES);
      onText(tail);
    }
  } catch {
    // The child exited; nothing else to drain.
  }
}

/** Runs one tool call in a fresh authenticated session and always reaps the child. */
async function withSession<T>(
  settings: MemorySettings,
  run: (session: BrainSession, deadline: number) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  const session = BrainSession.spawn(settings);
  try {
    await session.authenticate(settings.token, deadline);
    await session.handshake(deadline);
    return await run(session, deadline);
  } finally {
    session.close();
  }
}

/** Memory-plane and documents-plane hits, flattened into one list. */
function hitsOf(data: Json): MemoryHit[] {
  const envelope = recordOf(data);
  const hits: MemoryHit[] = [];
  const memory = Array.isArray(envelope.memory) ? envelope.memory : [];
  for (const raw of memory) {
    const hit = recordOf(raw);
    const text = asString(hit.snippet) ?? asString(hit.entity_surface) ?? "";
    const source = asString(hit.entity_id) ?? asString(hit.entity_surface) ?? "";
    hits.push({ text, source, score: asNumber(hit.score) });
  }
  const documents = Array.isArray(envelope.documents) ? envelope.documents : [];
  for (const raw of documents) {
    const hit = recordOf(raw);
    const content = recordOf(hit.text);
    const text = asString(content.text) ?? "";
    const source = asString(hit.locator) ?? asString(hit.root) ?? "";
    hits.push({ text, source, score: asNumber(hit.score) });
  }
  return hits;
}

/** The recall envelope carries token-budgeted layers; their text is the context. */
function recallOf(envelope: Json): { text: string; sources: string[] } {
  const data = recordOf(recordOf(envelope).data);
  const layers = Array.isArray(data.layers) ? data.layers : [];
  const texts: string[] = [];
  const sources: string[] = [];
  for (const raw of layers) {
    const layer = recordOf(raw);
    const text = asString(layer.text);
    if (text !== null) texts.push(text);
    const provenance = layer.provenance;
    if (Array.isArray(provenance)) {
      for (const item of provenance) {
        const source = asString(item);
        if (source !== null && !sources.includes(source)) sources.push(source);
      }
    }
  }
  return { text: texts.join("\n\n"), sources };
}

/** The episode id the engine reports after a successful ingest. */
function episodeIdOf(text: string): string {
  const id = text.replace(/^Ingested as episode:\s*/, "").trim();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("the Oxibrain engine did not report an episode id");
  return id;
}

/** Deterministic source locator for one retained text, mirroring the legacy locator shape. */
function sourceLocator(ghostId: string, origin: { conversationId: string; workId: string | null }, content: string): string {
  const workId = origin.workId ?? "";
  const identity = [
    `${ghostId.length}:${ghostId}`,
    `${origin.conversationId.length}:${origin.conversationId}`,
    `${workId.length}:${workId}`,
    sha256(content),
  ].join(":");
  return `ghost-source/v1/${sha256(identity)}`;
}

class OxibrainMemory implements MemoryPort {
  constructor(private readonly settings: MemorySettings) {}

  /** A Ghost can use memory only when a space is mapped to it. */
  available(ghostId: string): boolean {
    return this.spaceFor(ghostId) !== null;
  }

  async search(ghostId: string, query: string, limit: number): Promise<MemoryHit[]> {
    const space = this.requireSpace(ghostId);
    if (typeof query !== "string" || query.trim() === "") throw new Error("a memory search needs a query");
    const bounded = Math.max(MIN_SEARCH_LIMIT, Math.min(MAX_SEARCH_LIMIT, Math.trunc(limit) || MIN_SEARCH_LIMIT));
    const data = await withSession(this.settings, (session, deadline) =>
      session.callToolData("search", { query, space, mode: "auto", limit: bounded }, deadline),
    );
    return hitsOf(data);
  }

  async recall(ghostId: string, query: string, tokenBudget: number): Promise<{ text: string; sources: string[] }> {
    const space = this.requireSpace(ghostId);
    if (typeof query !== "string" || query.trim() === "") throw new Error("a memory recall needs a query");
    const budget = Math.max(MIN_TOKEN_BUDGET, Math.min(MAX_TOKEN_BUDGET, Math.trunc(tokenBudget) || MIN_TOKEN_BUDGET));
    const envelope = await withSession(this.settings, (session, deadline) =>
      session.callToolJson("recall", { query, space, token_budget: budget }, deadline),
    );
    return recallOf(envelope);
  }

  /** Stores untrusted source text with its origin; it is evidence, never a fact. */
  async retain(
    ghostId: string,
    text: string,
    origin: { conversationId: string; workId: string | null },
  ): Promise<{ id: string }> {
    const space = this.requireSpace(ghostId);
    if (typeof text !== "string" || text.length === 0) throw new Error("retained memory text must not be empty");
    if (Buffer.byteLength(text, "utf8") > MAX_CONTENT_BYTES) throw new Error("retained memory text exceeds the size limit");
    if (!origin || typeof origin.conversationId !== "string" || origin.conversationId.length === 0) {
      throw new Error("retained memory needs its origin conversation");
    }
    const sourcePath = sourceLocator(ghostId, origin, text);
    const result = await withSession(this.settings, (session, deadline) =>
      session.callTool("ingest", { content: text, space, source_path: sourcePath, extract: false, trust: "untrusted" }, deadline),
    );
    return { id: episodeIdOf(result) };
  }

  private spaceFor(ghostId: string): string | null {
    const space = this.settings.spaces[ghostId] ?? this.settings.spaces["*"];
    if (typeof space !== "string" || !SPACE_PATTERN.test(space)) return null;
    return space;
  }

  private requireSpace(ghostId: string): string {
    const space = this.spaceFor(ghostId);
    if (!space) throw new Error("this Ghost has no mapped memory space");
    return space;
  }
}

/** The memory port, or null when the host has no memory configured. */
export function createMemory(config: Config): MemoryPort | null {
  const settings = config.memory;
  if (!settings) return null;
  return new OxibrainMemory(settings);
}
