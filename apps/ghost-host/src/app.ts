import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startPush } from "./api/push.ts";
import { startServer } from "./api/server.ts";
import { CodingSessions } from "./coding/index.ts";
import type { CodingSessionsPort } from "./coding/ports.ts";
import type { Config } from "./config.ts";
import { Core } from "./core/core.ts";
import type { Engine } from "./core/ports.ts";
import { createEngine, EngineStartupCleanupError } from "./engine/index.ts";
import { createDocuments } from "./integrations/documents.ts";
import { MemoryStore } from "./stores/memory.ts";
import { MemoryDreams } from "./memory/dreams.ts";
import { createBrowser } from "./integrations/browser.ts";
import { LocalAccounts } from "./integrations/local-accounts.ts";
import { LoginShelf } from "./integrations/login-shelf.ts";
import { Shade } from "./integrations/shade.ts";
import { createDesktop } from "./integrations/desktop.ts";
import { createReach } from "./integrations/reach.ts";
import { createSkills } from "./integrations/skills.ts";
import { createToss } from "./integrations/toss.ts";
import { Ledger } from "./ledger/ledger.ts";
import { createSandbox, type SandboxService } from "./sandbox/index.ts";
import { FsArtifactStore } from "./stores/artifacts.ts";
import { FileSecrets } from "./stores/secrets.ts";
import { createVault, type Vault } from "./stores/vault.ts";
import { acquireRootLock } from "./state-lock.ts";
import { createToolSet } from "./tools/index.ts";
import type { BrowserPort, DesktopPort, DocumentsPort, HerdrPort, SkillsPort, HostPort } from "./integrations/ports.ts";
import { MacHost } from "./integrations/host.ts";
import { codingPrefs, Herdr } from "./integrations/herdr.ts";
import { OmpInfoProvider } from "./integrations/omp.ts";
import { CodingWatcher } from "./integrations/coding-watch.ts";
import { Terminals } from "./terminal/index.ts";
import { terminalNotifier } from "./terminal/notify.ts";
import { HostWatch } from "./core/hostwatch.ts";
import { ProviderCatalog } from "./integrations/provider-catalog.ts";
import { settingsView } from "./core/commands.ts";
import { SourceConnections } from "./integrations/activity-sources.ts";
import { SourceStore } from "./stores/sources.ts";
import { hostIsIdle, Updater } from "./update/index.ts";
import { detectLayout, registerHostBundle } from "./update/storage.ts";
import { MailService } from "./integrations/mail.ts";
import { MailWatcher } from "./integrations/mail-watch.ts";
import { createHostMcpClients, type McpClients } from "./integrations/mcp.ts";
import { createLiveCallEngine } from "./integrations/calls-live.ts";
import { createLocalCallEngine, type LocalCallEngine } from "./integrations/calls-local.ts";
import { Workbench } from "./workbench/service.ts";

export interface App {
  core: Core;
  engine: Engine;
  ledger: Ledger;
  documents: DocumentsPort;
  skills: SkillsPort | null;
  herdr: HerdrPort | null;
  terminals: Terminals | null;
  codingSessions: CodingSessionsPort | null;
  workbench: Workbench | null;
  omp: OmpInfoProvider | null;
  codingWatcher: CodingWatcher | null;
  host: HostPort | null;
  vault: Vault;
  /** Host-side Chrome; the owner's handoff live view reaches it through the API. */
  browser: BrowserPort | null;
  memory: MemoryStore;
  memoryDreams: MemoryDreams;
  mail: MailService;
  /** What the handoff card offers for the page the owner is on; null without a browser. */
  logins: LoginShelf | null;
  shade: Shade;
  localAccounts: LocalAccounts;
  mailWatcher: MailWatcher;
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
  let openedMail: MailService | null = null;
  let openedMailWatcher: MailWatcher | null = null;
  let openedCodingWatcher: CodingWatcher | null = null;
  let openedHerdr: Herdr | null = null;
  let openedTerminals: Terminals | null = null;
  let openedCodingSessions: CodingSessions | null = null;
  let openedMcp: McpClients | null = null;
  let openedSourceStore: SourceStore | null = null;
  let openedMemory: MemoryStore | null = null;
  let openedDreams: MemoryDreams | null = null;
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
    await attempt(async () => { await openedDreams?.close(); openedDreams = null; });
    await attempt(async () => { await openedCodingSessions?.shutdown(); openedCodingSessions = null; });
    await attempt(async () => { await openedTerminals?.shutdown(); openedTerminals = null; });
    if (openedCore && !coreStopped) await attempt(() => { openedCore!.stop(); coreStopped = true; });
    await Promise.all([
      attempt(async () => { await openedMailWatcher?.stop(); openedMailWatcher = null; }),
      attempt(() => { openedCodingWatcher?.stop(); openedCodingWatcher = null; }),
      attempt(async () => { await openedHerdr?.shutdownControls(); openedHerdr = null; }),
      attempt(async () => { await openedMail?.close(); }),
      attempt(async () => { await openedMcp?.close(); openedMcp = null; }),
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
    if (!unsafeEngine && !openedEngine && !openedSandbox && !openedMcp && !openedCodingSessions && (!openedCore || (coreStopped && coreDrained))) {
      // No tool can run any more: end browser sessions (login state saved) and seal the vault.
      await attempt(async () => { await openedBrowser?.shutdown(); openedBrowser = null; });
      // Stops Ghost Control and the Geist worker under it.
      await attempt(async () => { await openedDesktop?.shutdown(); openedDesktop = null; });
      await attempt(() => { openedVault?.close(); openedVault = null; });
      await attempt(() => { openedSourceStore?.close(); openedSourceStore = null; });
      await attempt(() => { openedMemory?.close(); openedMemory = null; });
      // Live browser or desktop processes keep ownership: close() can retry their shutdown.
      if (!openedBrowser && !openedDesktop && !openedTerminals) {
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
    const mail = (openedMail = new MailService({ connections: () => ledger.connections(), sources: openedSources }));
    const core = (openedCore = new Core({
      ledger, artifacts, sandbox, secrets: new FileSecrets(config.root), log,
      catalog: openedCatalog,
      codexCachePath: join(config.root, "codex-models.json"),
      activitySources: openedSources,
      sources: (openedSourceStore = new SourceStore(config.root)),
    }));
    const terminals = (openedTerminals = config.coding === false ? null : new Terminals(config.root, { log, onEvent: terminalNotifier(core) }));
    const documents = createDocuments(core);
    const skills = createSkills(config);
    const host = config.mac ? new MacHost({ roots: config.mac.roots, stateRoot: config.root }) : null;
    const vault = (openedVault = createVault(config.root));
    const mcp = (openedMcp = createHostMcpClients({ root: config.root, ledger, sources: openedSources, vault }));
    const shade = new Shade({ prefs: {
      // Shade's own agent-write switch is the owner's consent to add items; this only lets the owner turn mirroring off.
      saveLogins: () => ledger.setting<boolean>("shade:saveLogins", true),
      setSaveLogins: (value) => ledger.tx(() => ledger.putSetting("shade:saveLogins", value)),
    } });
    let logins: LoginShelf | null = null;
    const browser = (openedBrowser = createBrowser(config, { root: config.root, onLogin(ref, login) {
      const startedAt = Date.now();
      const item = vault.saveLogin(ref.ghostId, login);
      core.ledger.tx(() => core.notify({ id: `browser-login:${item.id}:${item.updatedAt}`, kind: "message", ghostId: ref.ghostId, conversationId: ref.conversationId, workId: null, decisionId: null, title: "로그인 정보를 금고에 저장했어요", body: `${item.origin} · ${item.username}` }));
      void logins?.captured(ref, login, item, startedAt);
      return item.id;
    } }));
    logins = browser ? new LoginShelf({ vault, shade, browser }) : null;
    const localAccounts = new LocalAccounts();
    const desktop = (openedDesktop = createDesktop(config, { root: config.root }));
    const memory = (openedMemory = new MemoryStore(config.root));
    const herdr = (openedHerdr = config.coding === false ? null : new Herdr(undefined, { root: config.root, log, prefs: () => codingPrefs(core.ledger.setting<unknown>("coding", null)) }));
    if (herdr) {
      core.coding.attach(herdr);
      void herdr.recoverControls().catch((error) => log("herdr 터미널 복구 실패", error));
    }
    const omp = config.coding === false ? null : new OmpInfoProvider();
    const codingWatcher = (openedCodingWatcher = herdr === null ? null : new CodingWatcher(core, herdr));
    const codingSessions = (openedCodingSessions = config.coding === false ? null : new CodingSessions({
      root: config.root, ledger, settings: () => { core.codexCatalog.sync(); return ledger.settings(); }, secrets: core.secrets, catalog: core.catalog, log,
      authorizeGhost: (requester, id) => core.coding.authorizeEmbeddedCreate(requester, id),
    }));
    core.setCodingSessions(codingSessions);
    const workbench = config.coding === false ? null : new Workbench(ledger, codingSessions, terminals, config.root);
    const tools = createToolSet({ core, sandbox, memory, memoryEngine: () => openedEngine, documents, skills, host, herdr, reach: createReach(config), browser, vault, desktop, mail, toss: createToss(), mcp });
    const engine = (openedEngine = await createEngine({ core, storagePath: join(config.root, "pi.db"), tools, sandbox, memory, log }));
    const memoryDreams = (openedDreams = new MemoryDreams({ core, memory, engine, log }));
    core.attach(engine);
    const mailWatcher = (openedMailWatcher = new MailWatcher(core, mail));
    return {
      core,
      engine,
      ledger,
      documents,
      skills,
      herdr,
      terminals,
      codingSessions,
      workbench,
      omp,
      codingWatcher,
      host,
      vault,
      browser,
      logins,
      shade,
      localAccounts,
      memory,
      memoryDreams,
      mail,
      mailWatcher,
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
  let liveCalls: { stop(): void } | null = null;
  let localCalls: LocalCallEngine | null = null;
  let updater: Updater | null = null;
  const closeServing = async () => {
    const errors: unknown[] = [];
    try { liveCalls?.stop(); liveCalls = null; } catch (error) { errors.push(error); }
    try { localCalls?.stop(); localCalls = null; } catch (error) { errors.push(error); }
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
    try { updater = new Updater({ root: config.root, publicOrigin: config.publicOrigin, idle: () => hostIsIdle(app.core, app.terminals) && !app.memoryDreams.isBusy(), log }); }
    catch (error) { log("업데이트를 시작하지 못했습니다.", error); }
    const layout = detectLayout();
    if (layout) registerHostBundle(layout).catch((error: unknown) => log("Ghost Host 번들을 시스템에 등록하지 못했습니다.", error));
    if (app.ledger.ghosts().length === 0) app.core.createGhost({ name: "Ghost", persona: "", isDefault: true });
    app.core.calls.register("realtime", (liveCalls = createLiveCallEngine({ core: app.core })));
    try {
      localCalls = createLocalCallEngine({ core: app.core, speechUrl: config.voice?.speechUrl ?? "http://127.0.0.1:62076" });
      app.core.calls.register("local", localCalls);
      localCalls.start();
    } catch (error) {
      log("로컬 음성 통화 엔진을 시작하지 못했습니다.", error);
    }
    await app.core.start();
    const catalogChanged = () => app.ledger.tx(() => app.ledger.emit({ type: "settings", settings: settingsView(app.core) }));
    app.core.catalog.start(catalogChanged);
    app.core.codexCatalog.start(catalogChanged);
    const token = ownerToken(config.root);
    server = startServer({ core: app.core, config, ownerToken: token, documents: app.documents, skills: app.skills, herdr: app.herdr, terminals: app.terminals, workbench: app.workbench, omp: app.omp, vault: app.vault, browser: app.browser, logins: app.logins, shade: app.shade, localAccounts: app.localAccounts, memory: app.memory, memoryDreams: app.memoryDreams, mail: app.mail, updater });
    push = startPush(app.core, config);
    const hostFile = join(config.root, "host.json");
    writeFileSync(hostFile, `${JSON.stringify({ port: server.port, token, pid: process.pid } satisfies HostFile)}\n`, { mode: 0o600 });
    chmodSync(hostFile, 0o600);
    hostWatch = app.host && config.mac?.watch ? new HostWatch(app.core, app.host, config.mac.watch) : null;
    hostWatch?.start();
    app.core.autonomy.start();
    app.memoryDreams.start();
    void app.mailWatcher.start();
    app.codingWatcher?.start();
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
