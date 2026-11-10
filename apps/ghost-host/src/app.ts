import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startPush } from "./api/push.ts";
import { startServer } from "./api/server.ts";
import type { Config } from "./config.ts";
import { Core } from "./core/core.ts";
import type { Engine } from "./core/ports.ts";
import { createEngine, EngineStartupCleanupError } from "./engine/index.ts";
import { createDocuments } from "./integrations/documents.ts";
import { createMemory } from "./integrations/memory.ts";
import { createBrowser } from "./integrations/browser.ts";
import { createDesktop } from "./integrations/desktop.ts";
import { createReach } from "./integrations/reach.ts";
import { createSkills } from "./integrations/skills.ts";
import { Ledger } from "./ledger/ledger.ts";
import { createSandbox, type SandboxService } from "./sandbox/index.ts";
import { FsArtifactStore } from "./stores/artifacts.ts";
import { FileSecrets } from "./stores/secrets.ts";
import { createVault, type Vault } from "./stores/vault.ts";
import { acquireRootLock } from "./state-lock.ts";
import { createToolSet } from "./tools/index.ts";
import type { BrowserPort, DesktopPort, DocumentsPort, SkillsPort, HostPort } from "./integrations/ports.ts";
import { MacHost } from "./integrations/host.ts";
import { HostWatch } from "./core/hostwatch.ts";
import { ProviderCatalog } from "./integrations/provider-catalog.ts";
import { settingsView } from "./core/commands.ts";
import { SourceConnections } from "./integrations/activity-sources.ts";
import { SourceStore } from "./stores/sources.ts";
import { hostIsIdle, Updater } from "./update/index.ts";

export interface App {
  core: Core;
  engine: Engine;
  ledger: Ledger;
  documents: DocumentsPort;
  skills: SkillsPort | null;
  host: HostPort | null;
  vault: Vault;
  /** Host-side Chrome; the owner's handoff live view reaches it through the API. */
  browser: BrowserPort | null;
  close(): Promise<void>;
}

/** What local clients read to reach the host: written 0600 at `<root>/host.json`. */
export interface HostFile {
  port: number;
  token: string;
  pid: number;
}

const log = (message: string, detail?: unknown) => console.error(`[ghost] ${message}`, detail ?? "");

/**
 * Open the state root: take the root lock, then ledger, stores, sandbox, integrations,
 * engine. Does not serve. Close/startup failure releases ownership after cleanup;
 * if a live engine cannot be proven stopped, ownership stays held until process exit.
 */
export async function openApp(config: Config): Promise<App> {
  // A pre-Bun root (Rust host's workspace.db) is never opened in place: it may still be
  // served by the old host, and this host cannot read it. `ghost import` copies it instead.
  if (existsSync(join(config.root, "workspace.db")) && !existsSync(join(config.root, "ledger.db"))) {
    throw new Error(`${config.root} is a legacy Ghost state root; import it into a new root with \`ghost import --from ${config.root} --root <new root>\``);
  }
  const lock = acquireRootLock(config.root);
  let openedLedger: Ledger | null = null;
  let openedSandbox: SandboxService | null = null;
  let openedCore: Core | null = null;
  let openedCatalog: ProviderCatalog | null = null;
  let openedEngine: Engine | null = null;
  let openedVault: Vault | null = null;
  let openedBrowser: BrowserPort | null = null;
  let openedDesktop: DesktopPort | null = null;
  let openedSources: SourceConnections | null = null;
  let openedSourceStore: SourceStore | null = null;
  let unsafeEngine = false;
  let coreStopped = false;
  let coreDrained = false;
  let closing: Promise<void> | null = null;
  const cleanup = async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => void | Promise<void>) => {
      try { await action(); } catch (error) { errors.push(error); }
    };
    // A catalog failure must not skip stopping/draining the core or closing Pi.
    await Promise.all([
      attempt(async () => { await openedCatalog?.close(); }),
      attempt(async () => { await openedCore?.codexCatalog.close(); }),
    ]);
    if (openedCore && !coreStopped) await attempt(() => { openedCore!.stop(); coreStopped = true; });
    await Promise.all([
      attempt(async () => { await openedSources?.close(); }),
      attempt(async () => { await openedSandbox?.close(); openedSandbox = null; }),
    ]);
    if (openedCore && !coreDrained) await attempt(async () => { await openedCore!.idle(); coreDrained = true; });
    if (openedEngine) await attempt(async () => {
      await openedEngine!.close();
      openedEngine = null;
      coreDrained = false; // Pi's final callbacks may have queued more core work.
    });
    if (openedCore && !openedEngine && !unsafeEngine && !coreDrained) {
      await attempt(async () => { await openedCore!.idle(); coreDrained = true; });
    }
    // A rejected engine close is not proof that its tasks stopped. Retain ownership
    // and the ledger in that case; close() can retry, or process exit releases the lock.
    if (!unsafeEngine && !openedEngine && !openedSandbox && (!openedCore || (coreStopped && coreDrained))) {
      // No tool can run any more: end browser sessions (login state saved) and seal the vault.
      await attempt(async () => { await openedBrowser?.shutdown(); openedBrowser = null; });
      // Stops Ghost Control and the Geist worker under it.
      await attempt(async () => { await openedDesktop?.shutdown(); openedDesktop = null; });
      await attempt(() => { openedVault?.close(); openedVault = null; });
      await attempt(() => { openedSourceStore?.close(); openedSourceStore = null; });
      // Live browser or desktop processes keep ownership: close() can retry their shutdown.
      if (!openedBrowser && !openedDesktop) {
        await attempt(() => { openedLedger?.close(); openedLedger = null; });
        if (!openedLedger) await attempt(() => lock.close());
      }
    }
    if (errors.length) throw new AggregateError(errors, "failed to close Ghost state root");
  };
  const close = (): Promise<void> => {
    if (!closing) closing = cleanup().finally(() => { closing = null; });
    return closing;
  };
  try {
    const ledger = (openedLedger = new Ledger(join(config.root, "ledger.db")));
    const artifacts = new FsArtifactStore(config.root);
    const sandbox = (openedSandbox = createSandbox(config, artifacts));
    openedCatalog = new ProviderCatalog({ cachePath: join(config.root, "models.json") });
    openedSources = new SourceConnections({ root: config.root, currentConnection: (id) => ledger.findConnection(id) });
    const core = (openedCore = new Core({
      ledger, artifacts, sandbox, secrets: new FileSecrets(config.root), log,
      catalog: openedCatalog,
      codexCachePath: join(config.root, "codex-models.json"),
      activitySources: openedSources,
      sources: (openedSourceStore = new SourceStore(config.root)),
    }));
    const documents = createDocuments(core);
    const skills = createSkills(config);
    const host = config.mac ? new MacHost({ roots: config.mac.roots, stateRoot: config.root }) : null;
    const vault = (openedVault = createVault(config.root));
    const browser = (openedBrowser = createBrowser(config, { root: config.root }));
    const desktop = (openedDesktop = createDesktop(config, { root: config.root }));
    const tools = createToolSet({ core, sandbox, memory: createMemory(config), documents, skills, host, reach: createReach(config), browser, vault, desktop });
    const engine = (openedEngine = await createEngine({ core, storagePath: join(config.root, "pi.db"), tools, sandbox, log }));
    core.attach(engine);
    return {
      core,
      engine,
      ledger,
      documents,
      skills,
      host,
      vault,
      browser,
      close,
    };
  } catch (error) {
    unsafeEngine = error instanceof EngineStartupCleanupError;
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Ghost startup and cleanup failed");
    }
    throw error;
  }
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
  let server: { port: number; stop(): Promise<void> } | null = null;
  let push: { stop(): void } | null = null;
  let hostWatch: HostWatch | null = null;
  let updater: Updater | null = null;
  const closeServing = async () => {
    const errors: unknown[] = [];
    try { push?.stop(); push = null; } catch (error) { errors.push(error); }
    try { await hostWatch?.stop(); hostWatch = null; } catch (error) { errors.push(error); }
    try { await app.core.autonomy.stop(); } catch (error) { errors.push(error); }
    try { await updater?.close(); } catch (error) { errors.push(error); }
    try { await server?.stop(); server = null; } catch (error) { errors.push(error); }
    // Do not release ownership while a server or watcher may still submit work.
    if (!push && !hostWatch && !server) {
      try { await app.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "failed to stop serving Ghost state root");
  };
  try {
    try { updater = new Updater({ root: config.root, publicOrigin: config.publicOrigin, idle: () => hostIsIdle(app.core), log }); }
    catch (error) { log("업데이트를 시작하지 못했습니다.", error); }
    if (app.ledger.ghosts().length === 0) app.core.createGhost({ name: "Ghost", persona: "", isDefault: true });
    await app.core.start();
    const catalogChanged = () => app.ledger.tx(() => app.ledger.emit({ type: "settings", settings: settingsView(app.core) }));
    app.core.catalog.start(catalogChanged);
    app.core.codexCatalog.start(catalogChanged);
    const token = ownerToken(config.root);
    server = startServer({ core: app.core, config, ownerToken: token, documents: app.documents, skills: app.skills, vault: app.vault, browser: app.browser, updater });
    push = startPush(app.core, config);
    const hostFile = join(config.root, "host.json");
    writeFileSync(hostFile, `${JSON.stringify({ port: server.port, token, pid: process.pid } satisfies HostFile)}\n`, { mode: 0o600 });
    chmodSync(hostFile, 0o600);
    hostWatch = app.host && config.mac?.watch ? new HostWatch(app.core, app.host, config.mac.watch) : null;
    hostWatch?.start();
    app.core.autonomy.start();
    updater?.start();
    log(`serving ${config.root} on http://${config.host}:${server.port}`);
  } catch (error) {
    try {
      await closeServing();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Ghost serve startup and cleanup failed");
    }
    throw error;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await closeServing();
      process.exit(0);
    } catch (error) {
      closing = false; // Retain ownership and allow another graceful shutdown attempt.
      log("shutdown failed", error);
    }
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
