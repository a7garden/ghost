import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { createMemory } from "../src/integrations/memory.ts";

/**
 * A tiny stand-in for the Oxibrain engine: it records the argv it was started
 * with and every JSON-RPC request it receives, and answers like the real
 * engine does.
 */
const FAKE_ENGINE = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const logDir = join(import.meta.dir, "log");
const lockDir = join(import.meta.dir, "engine-lock");
try {
  mkdirSync(lockDir);
} catch {
  process.stderr.write("store is locked — another oxibrain process owns it\\n");
  process.exit(1);
}
process.on("exit", () => rmSync(lockDir, { recursive: true, force: true }));
// Integration test: a real child retains its OS-level store lock during shutdown;
// the parent's fake clock cannot drive this separate process's termination.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 30));
writeFileSync(join(logDir, "argv.json"), JSON.stringify(process.argv.slice(2)));

function respond(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function handle(line) {
  const request = JSON.parse(line);
  appendFileSync(join(logDir, "requests.jsonl"), JSON.stringify(request) + "\\n");
  const id = request.id;
  if (request.method === "auth") {
    if (request.params?.token !== "test-token") {
      respond({ jsonrpc: "2.0", id, error: { code: -32001, message: "fixture authentication denied" } });
      return;
    }
    respond({ jsonrpc: "2.0", id, result: { authenticated: true } });
    return;
  }
  if (request.method === "handshake") {
    respond({
      jsonrpc: "2.0",
      id,
      result: {
        min_compatible: 1,
        max_compatible: 1,
        store_format_version: 1,
        supported_operations: ["mcp_tool_call"],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    const name = request.params.name;
    if (name === "search") {
      if (request.params.arguments.query === "fixture-failure") {
        respond({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "fixture search failed" }] } });
        return;
      }
      const envelope = {
        data: {
          memory: [
            { entity_id: "entity-1", entity_surface: "Alice", entity_type: "Person", score: 0.75, snippet: "Alice grows tomatoes." },
          ],
          documents: [
            {
              document_id: "document-1",
              root: "vault",
              locator: "notes/garden.md",
              revision: "revision-1",
              ordinal: 0,
              text: { kind: "untrusted", text: "The tomatoes need water.", provenance: { ref: "vault:notes/garden.md", trust: "untrusted" } },
              modified_at: 1,
              score: 0.5,
            },
          ],
          freshness: { reconciled_roots: [], skipped_roots: [], skipped_files: 0, stale_after_retry: [], dense_coverage: null },
        },
      };
      respond({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } });
      return;
    }
    if (name === "recall") {
      const envelope = {
        data: {
          layers: [{ kind: "query_neighborhood", text: "The owner decided to water the tomatoes.", estimated_tokens: 8, provenance: ["episode://abc"] }],
          total_tokens: 8,
          truncated: false,
        },
        meta: { dropped: {} },
      };
      respond({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(envelope) }] } });
      return;
    }
    if (name === "ingest") {
      respond({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Ingested as episode: " + "a".repeat(64) }] } });
      return;
    }
    respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported tool " + name } });
    return;
  }
  respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "unexpected method " + request.method } });
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handle(line);
    index = buffer.indexOf("\\n");
  }
}
`;

interface EngineFixture {
  config: Config;
  logDir: string;
  brainDir: string;
  requests: () => { method: string; params?: Record<string, unknown> }[];
  argv: () => string[];
}

function engineFixture(token = "test-token"): EngineFixture {
  const root = mkdtempSync(join(tmpdir(), "ghost-brain-"));
  const logDir = join(root, "log");
  const brainDir = join(root, "brain");
  mkdirSync(logDir);
  mkdirSync(brainDir);
  const script = join(root, "brain-fixture");
  writeFileSync(script, FAKE_ENGINE);
  chmodSync(script, 0o700);
  const config: Config = {
    root,
    host: "127.0.0.1",
    port: 62062,
    publicOrigin: "http://127.0.0.1:62062",
    uiDir: null,
    sandbox: { kind: "local" },
    memory: { executable: script, dir: brainDir, token, spaces: { "ghost-1": "space-a" } },
    voice: null,
    apns: null,
    skills: null,
    reach: null,
    browser: null,
  };
  return {
    config,
    logDir,
    brainDir,
    requests: () => {
      const log = join(logDir, "requests.jsonl");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    },
    argv: () => JSON.parse(readFileSync(join(logDir, "argv.json"), "utf8")) as string[],
  };
}

describe("memory", () => {
  test("without a memory configuration the host has no memory port", () => {
    const fixture = engineFixture();
    const config: Config = { ...fixture.config, memory: null };
    expect(createMemory(config)).toBeNull();
  });

  test("search sends the engine's request shape and maps the hits", async () => {
    const fixture = engineFixture();
    const memory = createMemory(fixture.config);
    expect(memory).not.toBeNull();

    const hits = await memory!.search("ghost-1", "tomatoes", 5);

    expect(hits).toEqual([
      { text: "Alice grows tomatoes.", source: "entity-1", score: 0.75 },
      { text: "The tomatoes need water.", source: "notes/garden.md", score: 0.5 },
    ]);

    const requests = fixture.requests();
    // The token travels in the auth request, never on the command line.
    expect(requests[0]?.method).toBe("auth");
    expect(requests[0]?.params?.["token"]).toBe("test-token");
    expect(fixture.argv()).toEqual(["admin", "serve", "--stdio", "--dir", fixture.brainDir]);
    expect(JSON.stringify(fixture.argv())).not.toContain("test-token");

    const call = requests.find((request) => request.method === "tools/call");
    expect(call?.params?.["name"]).toBe("search");
    expect(call?.params?.["arguments"]).toEqual({ query: "tomatoes", space: "space-a", mode: "auto", limit: 5 });
  });

  test("parallel memory calls across Ghosts wait for the previous engine to exit", async () => {
    const fixture = engineFixture();
    const memory = createMemory({ ...fixture.config, memory: { ...fixture.config.memory!, spaces: { "*": "space-all" } } })!;

    const [first, second, recalled, retained] = await Promise.all([
      memory.search("ghost-1", "인텔리턴트", 8),
      memory.search("ghost-2", "intelligent UI 지능형 UI", 8),
      memory.recall("ghost-1", "what did we decide", 512),
      memory.retain("ghost-2", "the owner said hello", { conversationId: "conversation-1", workId: null }),
    ]);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(recalled.text).toBe("The owner decided to water the tomatoes.");
    expect(retained.id).toBe("a".repeat(64));
    expect(fixture.requests().filter((request) => request.method === "tools/call").map((request) => request.params?.["name"])).toEqual(["search", "search", "recall", "ingest"]);
  });

  test("a failed operation keeps its error and releases the queue for the next call", async () => {
    const fixture = engineFixture();
    const memory = createMemory(fixture.config)!;

    const results = await Promise.allSettled([
      memory.search("ghost-1", "fixture-failure", 8),
      memory.search("ghost-1", "tomatoes", 8),
    ]);

    expect(results[0]?.status).toBe("rejected");
    if (results[0]?.status === "rejected") expect(results[0].reason.message).toBe("fixture search failed");
    expect(results[1]?.status).toBe("fulfilled");
    if (results[1]?.status === "fulfilled") expect(results[1].value).toHaveLength(2);
  });

  test("recall asks for a token budget and returns the layers and their sources", async () => {
    const fixture = engineFixture();
    const memory = createMemory(fixture.config)!;

    const recalled = await memory.recall("ghost-1", "what did we decide", 512);

    expect(recalled.text).toBe("The owner decided to water the tomatoes.");
    expect(recalled.sources).toEqual(["episode://abc"]);
    const call = fixture.requests().find((request) => request.method === "tools/call");
    expect(call?.params?.["arguments"]).toEqual({ query: "what did we decide", space: "space-a", token_budget: 512 });
  });

  test("retain stores untrusted source text with its origin", async () => {
    const fixture = engineFixture();
    const memory = createMemory(fixture.config)!;

    const retained = await memory.retain("ghost-1", "the owner said hello", { conversationId: "conversation-1", workId: null });

    expect(retained.id).toBe("a".repeat(64));
    const call = fixture.requests().find((request) => request.method === "tools/call");
    const args = call?.params?.["arguments"] as Record<string, unknown>;
    expect(args["content"]).toBe("the owner said hello");
    expect(args["space"]).toBe("space-a");
    expect(args["extract"]).toBe(false);
    expect(args["trust"]).toBe("untrusted");
    expect(args["source_path"]).toMatch(/^ghost-source\/v1\/[0-9a-f]{64}$/);
  });

  test("a Ghost without a mapped space has no memory", async () => {
    const fixture = engineFixture();
    const memory = createMemory(fixture.config)!;

    expect(memory.available("ghost-1")).toBe(true);
    expect(memory.available("ghost-2")).toBe(false);
    await expect(memory.search("ghost-2", "tomatoes", 3)).rejects.toThrow(/no mapped memory space/);

    // The refused Ghost never reached the engine.
    expect(fixture.requests()).toEqual([]);
  });

  test("the `*` space serves every Ghost without its own entry", async () => {
    const fixture = engineFixture();
    const memory = createMemory({ ...fixture.config, memory: { ...fixture.config.memory!, spaces: { "ghost-1": "space-a", "*": "space-all" } } })!;

    expect(memory.available("ghost-2")).toBe(true);
    await memory.search("ghost-2", "tomatoes", 3);
    await memory.search("ghost-1", "tomatoes", 3);

    const spaces = fixture.requests().filter((request) => request.method === "tools/call").map((request) => (request.params?.["arguments"] as Record<string, unknown>)["space"]);
    expect(spaces).toEqual(["space-all", "space-a"]);
  });

  test("a rejected token fails the operation instead of falling back", async () => {
    const fixture = engineFixture("wrong-token");
    const memory = createMemory(fixture.config)!;

    await expect(memory.search("ghost-1", "tomatoes", 3)).rejects.toThrow(/authentication denied/);
  });
});
