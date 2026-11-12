// A tiny MCP server for tests. Run directly (`bun mcp-server.ts [page size]`) it serves stdio; `fakeMcpServer()` serves any transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const schema = { type: "object", properties: {} } as const;

export function fakeMcpServer(pageSize: number): Server {
  const tools: Tool[] = [
    { name: "echo", inputSchema: schema, annotations: { readOnlyHint: false } },
    { name: "wipe", description: "Claims to be harmless", inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: "pid", inputSchema: schema },
    { name: "argv", inputSchema: schema },
    { name: "env", inputSchema: schema },
    { name: "slow", inputSchema: schema },
    { name: "crash", inputSchema: schema },
    { name: "big", inputSchema: schema },
    { name: "mixed", inputSchema: schema },
    { name: "grow", inputSchema: schema },
    { name: "fail", inputSchema: schema },
  ];
  const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const offset = Number(request.params?.cursor ?? 0);
    const page = tools.slice(offset, offset + pageSize);
    return { tools: page, ...(offset + pageSize < tools.length ? { nextCursor: String(offset + pageSize) } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const args = request.params.arguments ?? {};
    const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
    switch (request.params.name) {
      case "echo": return text(String(args.text));
      case "pid": return text(String(process.pid));
      case "argv": return text(JSON.stringify(process.argv.slice(2)));
      case "env": return text(`${process.env.FAKE_SECRET ?? "unset"} ${process.env.GHOST_TEST_LEAK ?? "unset"}`);
      case "slow":
        await Bun.sleep(Number(args.ms));
        return text("done");
      case "crash":
        process.stderr.write("fatal: token=SECRET-STDERR-TOKEN\n");
        setTimeout(() => process.exit(3), 10);
        return new Promise(() => undefined);
      case "big": return { content: [{ type: "text", text: "é".repeat(Number(args.chars)) }, { type: "text", text: "after" }] };
      case "mixed":
        return {
          content: [
            { type: "text", text: "hello" },
            { type: "image", mimeType: "image/png", data: PNG },
            { type: "image", mimeType: "image/svg+xml", data: PNG },
            { type: "resource_link", uri: "file:///notes.md", name: "notes" },
            { type: "resource", resource: { uri: "file:///a.txt", text: "inline body" } },
          ],
        };
      case "grow":
        tools.push({ name: "extra", inputSchema: schema });
        await server.sendToolListChanged();
        return text("grown");
      case "fail": return { content: [{ type: "text", text: "nope" }], isError: true };
      default: throw new Error(`unknown tool ${request.params.name}`);
    }
  });
  return server;
}

if (import.meta.main) await fakeMcpServer(Number(process.argv[2]) || 100).connect(new StdioServerTransport());
