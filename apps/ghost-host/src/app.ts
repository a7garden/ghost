import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startPush } from "./api/push.ts";
import { startServer } from "./api/server.ts";
import type { Config } from "./config.ts";
import { Core } from "./core/core.ts";
import type { Engine } from "./core/ports.ts";
import { createEngine } from "./engine/index.ts";
import { createDocuments } from "./integrations/documents.ts";
import { createMemory } from "./integrations/memory.ts";
import { Ledger } from "./ledger/ledger.ts";
import { createSandbox } from "./sandbox/index.ts";
import { FsArtifactStore } from "./stores/artifacts.ts";
import { FileSecrets } from "./stores/secrets.ts";
import { createToolSet } from "./tools/index.ts";
import type { DocumentsPort } from "./integrations/ports.ts";

export interface App {
  core: Core;
  engine: Engine;
  ledger: Ledger;
  documents: DocumentsPort;
  close(): Promise<void>;
}

/** What local clients read to reach the host: written 0600 at `<root>/host.json`. */
export interface HostFile {
  port: number;
  token: string;
  pid: number;
}

const log = (message: string, detail?: unknown) => console.error(`[ghost] ${message}`, detail ?? "");

/** Open the state root: ledger, stores, sandbox, integrations, engine. Does not serve. */
export async function openApp(config: Config): Promise<App> {
  // A pre-Bun root (Rust host's workspace.db) is never opened in place: it may still be
  // served by the old host, and this host cannot read it. `ghost import` copies it instead.
  if (existsSync(join(config.root, "workspace.db")) && !existsSync(join(config.root, "ledger.db"))) {
    throw new Error(`${config.root} is a legacy Ghost state root; import it into a new root with \`ghost import --from ${config.root} --root <new root>\``);
  }
  mkdirSync(config.root, { recursive: true, mode: 0o700 });
  const ledger = new Ledger(join(config.root, "ledger.db"));
  const artifacts = new FsArtifactStore(config.root);
  const sandbox = createSandbox(config, artifacts);
  const core = new Core({ ledger, artifacts, sandbox, secrets: new FileSecrets(config.root), log });
  const documents = createDocuments(core);
  const tools = createToolSet({ core, sandbox, memory: createMemory(config), documents });
  const engine = await createEngine({ core, storagePath: join(config.root, "pi.db"), tools, sandbox, log });
  core.attach(engine);
  return {
    core,
    engine,
    ledger,
    documents,
    async close() {
      core.stop();
      await core.idle();
      await engine.close();
      ledger.close();
    },
  };
}

/** The owner token survives restarts so the Mac app keeps working; created once. */
function ownerToken(root: string): string {
  const path = join(root, "host.json");
  if (existsSync(path)) {
    const file = JSON.parse(readFileSync(path, "utf8")) as Partial<HostFile>;
    if (typeof file.token === "string" && file.token.length >= 32) return file.token;
  }
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** `ghost serve`: open, bootstrap a first Ghost, start rules, serve the API. */
export async function serve(config: Config) {
  const app = await openApp(config);
  if (app.ledger.ghosts().length === 0) app.core.createGhost({ name: "Ghost", persona: "", isDefault: true });
  await app.core.start();
  const token = ownerToken(config.root);
  const server = startServer({ core: app.core, config, ownerToken: token, documents: app.documents });
  const push = startPush(app.core, config);
  const hostFile = join(config.root, "host.json");
  writeFileSync(hostFile, `${JSON.stringify({ port: server.port, token, pid: process.pid } satisfies HostFile)}\n`, { mode: 0o600 });
  chmodSync(hostFile, 0o600);
  log(`serving ${config.root} on http://${config.host}:${server.port}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    push?.stop();
    await server.stop();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
