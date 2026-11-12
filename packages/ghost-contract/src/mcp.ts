import { Type, type Static } from "typebox";
import { Id, nullable, Timestamp } from "./entities.ts";

/** Name of an environment variable handed to a stdio server; its value comes from the vault at launch. */
export const McpEnvName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,127}$" });
export type McpEnvName = Static<typeof McpEnvName>;

/** Tool name as the server lists it (MCP 2025-11-25: 1 to 128 characters). */
export const McpToolName = Type.String({ minLength: 1, maxLength: 128 });
export type McpToolName = Static<typeof McpToolName>;

/**
 * How the Host reaches an MCP server. A stdio server is launched without a shell; `env` lists only
 * variable names, never values, so a secret never sits in configuration. An http server speaks
 * Streamable HTTP; `connectionId` names the connection whose credential becomes its auth header.
 */
export const McpTransport = Type.Union([
  Type.Object({
    kind: Type.Literal("stdio"),
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    args: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 256 }),
    env: Type.Array(McpEnvName, { maxItems: 64, uniqueItems: true }),
    /** Working directory of the server process; null inherits the Host's. */
    cwd: nullable(Type.String({ minLength: 1, maxLength: 4096 })),
  }),
  Type.Object({
    kind: Type.Literal("http"),
    /** https, or http only on a loopback host. */
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    connectionId: nullable(Id),
  }),
]);
export type McpTransport = Static<typeof McpTransport>;

/**
 * An MCP server the owner attached. Server-declared tool annotations are untrusted: a tool is a
 * read only when the owner listed it in `readTools`; every other tool is treated as a write.
 */
export const McpServer = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  enabled: Type.Boolean(),
  transport: McpTransport,
  readTools: Type.Array(McpToolName, { maxItems: 1024, uniqueItems: true }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type McpServer = Static<typeof McpServer>;
