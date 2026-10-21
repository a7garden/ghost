import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile, type Stats } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readGuestBrokerConfig } from "./guest-broker-client.ts";
import { registerGuestModel } from "./guest-model.ts";
import { registerSubscriptionGuestModel } from "./subscription-guest-model.ts";
import { NATIVE_OMP_TOOL_NAMES, WORKER_TOOL_APPROVALS } from "./native-tool-policy.ts";

const PINNED_OMP_VERSION = "18.8.6";

/**
 * Explicit pinned skill manifest (ghost-worker-skills/1), staged by the trusted
 * guest runtime. Absent env means `skills: []` — ambient discovery stays off and
 * the historical native proof path is unchanged. Every entry must resolve inside
 * the declared skills root and match its recorded SHA-256 digest.
 */
type PinnedSkill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  containRoot: string;
};

async function pinnedSkills(): Promise<PinnedSkill[]> {
  const manifestPath = process.env.GHOST_WORKER_SKILLS_MANIFEST;
  if (manifestPath === undefined || manifestPath === "") return [];
  const rootArg = requireValue(process.env.GHOST_WORKER_SKILLS_ROOT, "worker skills root is missing");
  if (!path.isAbsolute(manifestPath) || !path.isAbsolute(rootArg)) {
    throw new Error("worker skills manifest and root must be absolute");
  }
  const root = await realpath(rootArg);
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schema?: string;
    skills?: { name?: unknown; description?: unknown; sha256?: unknown; privacy?: unknown; file?: unknown }[];
  };
  if (raw.schema !== "ghost-worker-skills/1" || !Array.isArray(raw.skills)) {
    throw new Error("worker skills manifest is invalid");
  }
  const skills: PinnedSkill[] = [];
  for (const entry of raw.skills) {
    const name = typeof entry.name === "string" ? entry.name : "";
    const description = typeof entry.description === "string" ? entry.description : "";
    const sha256 = typeof entry.sha256 === "string" ? entry.sha256 : "";
    const file = typeof entry.file === "string" ? entry.file : "";
    const privacy = entry.privacy === undefined ? "private" : entry.privacy;
    if (!/^[a-z0-9_-]{1,64}$/.test(name) || !/^[0-9a-f]{64}$/.test(sha256) || !path.isAbsolute(file)
      || (privacy !== "public" && privacy !== "private" && privacy !== "local_only")) {
      throw new Error("worker skills manifest entry is invalid");
    }
    const resolved = await realpath(file);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error("pinned skill escaped the worker skills root");
    }
    const content = await readFile(resolved);
    if (createHash("sha256").update(content).digest("hex") !== sha256) {
      throw new Error("pinned skill content does not match its digest");
    }
    skills.push({
      name,
      description,
      filePath: resolved,
      baseDir: path.dirname(resolved),
      source: "ghost-pinned",
      containRoot: root,
    });
  }
  return skills;
}

type ModuleExports = Record<string, unknown>;
type SettingsHandle = object;
type SessionManagerHandle = { dispose?: () => Promise<void> | void };
type AuthStorageHandle = { close?: () => Promise<void> | void };
type SettingsApi = { loadIsolated(options: Record<string, unknown>): Promise<SettingsHandle> };
type SessionManagerApi = {
  open(file: string, directory: string, storage: unknown, options: Record<string, unknown>): Promise<SessionManagerHandle>;
};
type SdkApi = {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: unknown; modelFallbackMessage?: string }>;
  discoverAuthStorage(agentDir?: string, options?: Record<string, unknown>): Promise<AuthStorageHandle>;
};
type RpcApi = { runRpcMode(session: unknown, options: { headless: boolean }): Promise<never> };
type ModelRegistryHandle = {
  find(provider: string, modelId: string): unknown;
  registerProvider(provider: string, config: Record<string, unknown>, sourceId: string): void;
  unregisterProvider?(provider: string): void;
};
type ModelRegistryConstructor = new (
  authStorage: AuthStorageHandle,
  modelsPath: string,
  options: Record<string, unknown>,
) => ModelRegistryHandle;
type PiAiAuthStorageApi = { create(dbPath: string): Promise<AuthStorageHandle> };
type GuestTransportHandle = { model: unknown; close: () => Promise<void> };

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(label);
  return value;
}

/**
 * Resume continuation (worker `browser.resume` relaunches only).
 *
 * The worker writes a consumed-once sentinel beside the sealed session when a
 * relaunch must deliver a committed owner decision to a tool call the previous
 * runtime left unanswered. The continuation NEVER re-sends the task and never
 * fabricates session content: the SDK continues from its own restored context
 * (`Agent.continue()`), which
 *   - re-executes an assistant tail with unpaired runnable tool calls under
 *     their ORIGINAL tool-call identity — the worker answers from the durable
 *     receipt, so the SAME tool call receives the actual approve/deny result;
 *   - or continues the original turn from an already delivered toolResult.
 * Any other restored tail is left untouched for supervisor reconciliation.
 *
 * The runner records exactly ONE bounded outcome beside the session
 * (`ghost-resume-continue-outcome/1`): the sentinel state, the SDK-shaped tail
 * classification, and whether `Agent.continue()` was started — or, if it
 * rejected, why. A quiet restored session is NOT proof of completion (SDK
 * `isSettled` means only "nothing is live"), so the worker consumes this
 * record: without a recorded completed assistant tail the resume stays
 * explicitly unproven there — never a settled success. Nothing is caught and
 * hidden: every rejection lands in the record.
 */
const RESUME_SENTINEL_NAME = "ghost-resume-continue.json";
const MAX_RESUME_SENTINEL_BYTES = 4096;
const RESUME_OUTCOME_NAME = "ghost-resume-continue-outcome.json";
const MAX_RESUME_OUTCOME_BYTES = 4096;
const MAX_RESUME_OUTCOME_ERROR_BYTES = 512;

type ResumeMarker = { schema: "ghost-resume-continue/2"; tool_call_id: string };
type ResumeTail = "unpaired_tool_calls" | "tool_result" | "assistant_final" | "empty" | "other_tail";

type ResumeOutcomeRecord = {
  schema: "ghost-resume-continue-outcome/1";
  sentinel: "valid";
  tail: ResumeTail;
  continued: boolean;
  error?: string;
};

type ResumeContinuationSession = {
  messages: { role?: unknown; stopReason?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown }[];
  agent: { continue: () => Promise<void>; replaceMessages: (messages: ResumeContinuationSession["messages"]) => void };
  refreshRpcHostTools: (tools: unknown[]) => Promise<void>;
};

/**
 * Consumed-once sentinel read. Absent means this launch is not a resume; any
 * PRESENT but unreadable, oversized, or schema-mismatched marker throws: a
 * resume relaunch that cannot honor its continuation contract fails closed
 * before the session is opened, never silently degrading to a launch that
 * leaves a committed owner decision undelivered.
 */
async function consumeResumeSentinel(sessionDir: string): Promise<ResumeMarker | undefined> {
  const sentinel = path.join(sessionDir, RESUME_SENTINEL_NAME);
  let info: Stats;
  try {
    info = await lstat(sentinel);
  } catch {
    return undefined;
  }
  if (!info.isFile() || info.size > MAX_RESUME_SENTINEL_BYTES) {
    throw new Error("resume sentinel is not a bounded regular file");
  }
  const raw = await readFile(sentinel);
  // Consumed once, whatever it contains: a marker can never accumulate.
  await rm(sentinel, { force: true });
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Partial<ResumeMarker>;
  if (parsed.schema !== "ghost-resume-continue/2"
    || typeof parsed.tool_call_id !== "string" || parsed.tool_call_id.length === 0 || parsed.tool_call_id.length > 256) {
    throw new Error("resume sentinel schema or original tool identity is invalid");
  }
  // This launch owns the outcome record: a stale one from a previous launch
  // must never be observable to the worker.
  await rm(path.join(sessionDir, RESUME_OUTCOME_NAME), { force: true });
  return parsed as ResumeMarker;
}

/**
 * Mirror of the SDK's own restored-tail rules (`unpairedToolCallTail` +
 * `Agent.continue()`'s rejection branches in pi-agent-core 18.8.6): an
 * assistant tail with runnable unpaired tool calls re-executes them; a
 * toolResult tail continues the turn; an assistant tail that already yielded
 * (`stop`, no runnable calls) is the COMPLETED original final record and
 * `continue()` would reject it; everything else stays untouched.
 */
function classifyResumeTail(messages: ResumeContinuationSession["messages"]): ResumeTail {
  const tail = messages.at(-1);
  if (!tail) return "empty";
  if (tail.role === "assistant") {
    const runnable = Array.isArray(tail.content)
      && (tail.content as { type?: unknown }[]).some((block) => block?.type === "toolCall");
    if ((tail.stopReason === "toolUse" || tail.stopReason === "stop") && runnable) return "unpaired_tool_calls";
    if (tail.stopReason === "stop" && !runnable) return "assistant_final";
    return "other_tail";
  }
  return tail.role === "toolResult" ? "tool_result" : "other_tail";
}

/**
 * Closing the old RPC transport may append an SDK error for an unanswered
 * host call. The committed Owner receipt, not that transport error, answers
 * the call. Keep the original disk history; restore the original assistant
 * frame in memory so the SDK delivers the durable receipt under the same ID.
 * Other calls in that frame also pass through the worker's digest-bound cache.
 */
function restoreOriginalResumeFrame(session: ResumeContinuationSession, toolCallId: string): void {
  const messages = session.messages;
  const assistantIndex = messages.findLastIndex(message => message.role === "assistant");
  const assistant = messages[assistantIndex];
  if (!assistant || !Array.isArray(assistant.content)
    || !assistant.content.some(block => block?.type === "toolCall" && block.id === toolCallId)) {
    throw new Error("the original interrupted tool frame is no longer the restored SDK tail");
  }
  let delivered: ResumeContinuationSession["messages"][number] | undefined;
  for (let index = assistantIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "toolResult") {
      throw new Error("the original interrupted tool frame is no longer the restored SDK tail");
    }
    if (message.toolCallId === toolCallId) delivered = message;
  }
  if (delivered && delivered.isError !== true) return;
  session.agent.replaceMessages(messages.slice(0, assistantIndex + 1));
}

async function writeResumeOutcome(sessionDir: string, record: ResumeOutcomeRecord): Promise<void> {
  const body = `${JSON.stringify(record)}\n`;
  // The worker discards an over-bound record as unproven: uphold the same
  // bound here so a record is never written that cannot serve as evidence.
  if (Buffer.byteLength(body, "utf8") > MAX_RESUME_OUTCOME_BYTES) {
    throw new Error("resume outcome record exceeds its bound");
  }
  const target = path.join(sessionDir, RESUME_OUTCOME_NAME);
  const temporary = path.join(sessionDir, `${RESUME_OUTCOME_NAME}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Drive the resume continuation. Returns once the continuation is STARTED
 * (never waiting for a whole model turn); the live continuation records its
 * own outcome — including every `Agent.continue()` rejection, with the error —
 * when it ends.
 */
async function driveResumeContinuation(sessionDir: string, session: ResumeContinuationSession, toolCallId: string): Promise<void> {
  restoreOriginalResumeFrame(session, toolCallId);
  const tail = classifyResumeTail(session.messages);
  const continuable = tail === "unpaired_tool_calls" || tail === "tool_result" || tail === "other_tail";
  if (!continuable) {
    // The SDK itself would reject `continue()` here; the untouched tail is
    // recorded so the worker can reconcile deterministically.
    await writeResumeOutcome(sessionDir, { schema: "ghost-resume-continue-outcome/1", sentinel: "valid", tail, continued: false });
    return;
  }
  void (async () => {
    let outcome: ResumeOutcomeRecord;
    try {
      await session.agent.continue();
      outcome = { schema: "ghost-resume-continue-outcome/1", sentinel: "valid", tail, continued: true };
    } catch (error) {
      // Recorded, never hidden: the worker reconciles this as an explicitly
      // unproven resume — the committed owner decision stays undelivered.
      const message = error instanceof Error ? error.message : String(error);
      outcome = {
        schema: "ghost-resume-continue-outcome/1",
        sentinel: "valid",
        tail,
        continued: false,
        error: message.length > MAX_RESUME_OUTCOME_ERROR_BYTES
          ? message.slice(0, MAX_RESUME_OUTCOME_ERROR_BYTES)
          : message,
      };
    }
    await writeResumeOutcome(sessionDir, outcome);
  })().catch(() => {
    // A failed outcome write leaves NO record: the worker treats a missing
    // record as explicitly unproven, never as success — failing closed.
  });
}

/**
 * Wrap the live session so the continuation starts the moment the worker has
 * registered the host tools (`set_host_tools`): the re-executed tool call must
 * find its tool. A not-continuable tail records its outcome and that bounded
 * write completes BEFORE the RPC response is written, so the worker observes
 * it in the same launch; a live continuation starts unheld — the response is
 * never held for a whole model turn, and the worker's following `get_state`
 * observes the live continuation (`isStreaming`) instead of mistaking a quiet
 * restored session for one still to be driven.
 */
function wrapResumeContinuation(sessionDir: string, target: unknown, toolCallId: string): unknown {
  const session = target as ResumeContinuationSession;
  let started = false;
  return new Proxy(target as object, {
    get(real, property, _receiver) {
      if (property === "refreshRpcHostTools") {
        return async (...args: unknown[]) => {
          const realMethod = Reflect.get(real, property, real) as (...callArgs: unknown[]) => Promise<void>;
          const value = await realMethod.apply(real, args);
          if (!started) {
            started = true;
            await driveResumeContinuation(sessionDir, session, toolCallId).catch(async error => {
              const message = error instanceof Error ? error.message : String(error);
              await writeResumeOutcome(sessionDir, {
                schema: "ghost-resume-continue-outcome/1", sentinel: "valid",
                tail: classifyResumeTail(session.messages), continued: false,
                error: message.slice(0, MAX_RESUME_OUTCOME_ERROR_BYTES),
              });
              // A failed outcome write leaves NO record: the worker treats a
              // missing record as explicitly unproven, never as success.
            });
          }
          return value;
        };
      }
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? (value as (...callArgs: unknown[]) => unknown).bind(real) : value;
    },
  });
}


function parseArgs(argv: string[]): { packageRoot: string; config: string; brokerConfig?: string } {
  let packageRoot: string | undefined;
  let config: string | undefined;
  let brokerConfig: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--package-root") packageRoot = argv[++index];
    else if (flag === "--config") config = argv[++index];
    else if (flag === "--broker-config") {
      if (brokerConfig !== undefined || argv[index + 1] === undefined) {
        throw new Error("missing or duplicate guest broker config");
      }
      brokerConfig = argv[++index];
    } else throw new Error("unexpected trusted runner argument");
  }
  return {
    packageRoot: requireValue(packageRoot, "missing package root"),
    config: requireValue(config, "missing coordinator config"),
    ...(brokerConfig === undefined ? {} : { brokerConfig }),
  };
}

function packageExportPath(packageRoot: string, exportsMap: Record<string, unknown>, subpath: string): string {
  const request = `./${subpath}`;
  for (const [pattern, rawTarget] of Object.entries(exportsMap)) {
    let capture: string | undefined;
    if (pattern === request) capture = "";
    else {
      const star = pattern.indexOf("*");
      if (star < 0) continue;
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
      capture = request.slice(prefix.length, request.length - suffix.length);
    }
    const targetRecord = typeof rawTarget === "string" ? { import: rawTarget } : rawTarget as Record<string, unknown> | undefined;
    const target = typeof targetRecord?.import === "string"
      ? targetRecord.import
      : typeof targetRecord?.default === "string" ? targetRecord.default : undefined;
    if (!target || !target.startsWith("./src/")) continue;
    const resolved = path.resolve(packageRoot, target.replace("*", capture ?? ""));
    if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${path.sep}`)) throw new Error("package export escaped package root");
    return resolved;
  }
  throw new Error(`required OMP package export is missing: ${request}`);
}

async function main(): Promise<void> {
  // Match pinned OMP 18.8.6's CLI RPC defaults. This launcher calls the SDK
  // directly, bypassing main.ts: without this gate an unnamed worker starts
  // an auxiliary title inference on the same serialized local model while
  // its actual Work is still consuming its fixed deadline/request budget.
  // Set it before importing the SDK, whose environment view may be cached.
  process.env.PI_NO_TITLE = "1";
  const { packageRoot: packageRootArg, config: configArg, brokerConfig: brokerConfigArg } = parseArgs(process.argv.slice(2));
  if (!path.isAbsolute(packageRootArg) || !path.isAbsolute(configArg)
    || (brokerConfigArg !== undefined && !path.isAbsolute(brokerConfigArg))) {
    throw new Error("trusted runner paths must be absolute");
  }
  const packageRoot = await realpath(packageRootArg);
  if (!(await stat(packageRoot)).isDirectory()) throw new Error("OMP package root is not a directory");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
    exports?: Record<string, unknown>;
  };
  if (manifest.version !== PINNED_OMP_VERSION) throw new Error("OMP package version mismatch");
  const exportsMap = requireValue(manifest.exports, "OMP package export map is missing");

  const config = await realpath(configArg);
  if (!(await stat(config)).isFile()) throw new Error("coordinator config is not a regular file");
  const sessionDirArg = requireValue(process.env.GHOST_OMP_SESSION_DIR, "worker session locator is missing");
  const sessionDir = await realpath(sessionDirArg);
  if (!path.isAbsolute(sessionDirArg) || sessionDir !== path.resolve(sessionDirArg) || !(await stat(sessionDir)).isDirectory()) {
    throw new Error("worker session locator is invalid");
  }
  const cwd = await realpath(process.cwd());
  const runtimeDir = path.join(sessionDir, "omp-runtime");
  try {
    await mkdir(runtimeDir, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const runtimeInfo = await lstat(runtimeDir);
  if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory() || (runtimeInfo.mode & 0o077) !== 0) {
    throw new Error("worker runtime state path is invalid");
  }

  // The package root is coordinator-selected at runtime; importing literal package names would bypass that pinned root.
  const load = async (subpath: string): Promise<ModuleExports> =>
    await import(pathToFileURL(packageExportPath(packageRoot, exportsMap, subpath)).href) as ModuleExports;
  const [sdkModule, settingsModule, sessionModule, rpcModule] = await Promise.all([
    load("sdk"),
    load("config/settings"),
    load("session/session-manager"),
    load("modes/rpc/rpc-mode"),
  ]);
  const Settings = requireValue(settingsModule.Settings as SettingsApi | undefined, "OMP Settings API is unavailable");
  const SessionManager = requireValue(sessionModule.SessionManager as SessionManagerApi | undefined, "OMP SessionManager API is unavailable");
  const sdk = sdkModule as unknown as SdkApi;
  const rpc = rpcModule as unknown as RpcApi;
  const brokerConfig = brokerConfigArg === undefined ? undefined : await readGuestBrokerConfig(brokerConfigArg);

  let authStorage: AuthStorageHandle | undefined;
  let sessionManager: SessionManagerHandle | undefined;
  let session: unknown;
  let modelRegistry: ModelRegistryHandle | undefined;
  let guestTransport: GuestTransportHandle | undefined;
  let resumeSentinel: ResumeMarker | undefined;
  const skills = await pinnedSkills();
  try {
    const settings = await Settings.loadIsolated({
      cwd: path.parse(sessionDir).root,
      agentDir: runtimeDir,
      inMemory: true,
      readOnly: true,
      configFiles: brokerConfig === undefined ? [config] : [],
      overrides: {
        "retry.enabled": false,
        "retry.modelFallback": false,
        "retry.usageAwareFallback": false,
        "retry.usageReservePct": 0,
        "retry.fallbackChains": {},
        "auth.accountPolicies": [],
        "tools.approvalMode": "always-ask",
        "tools.approval": brokerConfig === undefined
          ? { canary_read: "allow", canary_write: "allow" }
          : WORKER_TOOL_APPROVALS,
        ...(brokerConfig === undefined ? {} : {
          "bash.enabled": true,
          "grep.enabled": true,
          "glob.enabled": true,
          "astGrep.enabled": true,
          "astEdit.enabled": true,
          "todo.enabled": true,
          "eval.py": false,
          "eval.js": true,
          "eval.autoProvision": false,
          "eval.tools.enabled": false,
        }),
      },
    });
    if (brokerConfig === undefined) {
      authStorage = await sdk.discoverAuthStorage(undefined, { settings, cwd });
    } else {
      const aiRoot = await realpath(path.join(path.dirname(packageRoot), "pi-ai"));
      const aiManifest = JSON.parse(await readFile(path.join(aiRoot, "package.json"), "utf8")) as {
        version?: string;
        exports?: Record<string, unknown>;
      };
      if (aiManifest.version !== PINNED_OMP_VERSION) throw new Error("Pi AI package version mismatch");
      const aiExports = requireValue(aiManifest.exports, "Pi AI package export map is missing");
      const loadAi = async (subpath: string): Promise<ModuleExports> =>
        await import(pathToFileURL(packageExportPath(aiRoot, aiExports, subpath)).href) as ModuleExports;
      const [piAiModule, modelRegistryModule] = await Promise.all([
        loadAi("index"),
        load("config/model-registry"),
      ]);
      const PiAuthStorage = requireValue(piAiModule.AuthStorage as PiAiAuthStorageApi | undefined, "Pi AI AuthStorage API is unavailable");
      const ModelRegistry = requireValue(
        modelRegistryModule.ModelRegistry as ModelRegistryConstructor | undefined,
        "OMP ModelRegistry API is unavailable",
      );
      authStorage = await PiAuthStorage.create(path.join(runtimeDir, "guest-auth.sqlite"));
      modelRegistry = new ModelRegistry(authStorage, path.join(runtimeDir, "models.yml"), {
        settings,
        ignoreLocalModelConfig: true,
        cacheDbPath: path.join(runtimeDir, "model-cache.sqlite"),
      });
      if (brokerConfig.kind === "local") {
        guestTransport = await registerGuestModel({
          config: brokerConfig.config,
          modelRegistry,
          piAi: piAiModule as unknown as { streamSimple: unknown; NO_AUTH_SENTINEL: unknown },
        });
      } else {
        const [piNativeModule, eventStreamModule] = await Promise.all([
          loadAi("providers/pi-native-client"),
          loadAi("utils/event-stream"),
        ]);
        guestTransport = await registerSubscriptionGuestModel({
          config: brokerConfig.config,
          modelRegistry,
          piNative: {
            streamPiNative: piNativeModule.streamPiNative,
            toolWireSchema: piAiModule.toolWireSchema,
            createAssistantMessageEventStream: eventStreamModule.createAssistantMessageEventStream,
            NO_AUTH_SENTINEL: piAiModule.NO_AUTH_SENTINEL,
          },
        });
      }
    }
    sessionManager = await SessionManager.open(path.join(sessionDir, "worker-session.jsonl"), sessionDir, undefined, {
      initialCwd: cwd,
      suppressBreadcrumb: true,
    });
    // A resume launch continues the SAME restored session in place. The
    // worker writes this consumed-once sentinel beside the session only for a
    // relaunch that must deliver a committed owner decision to an unanswered
    // tool call; a PRESENT but invalid marker fails the launch (fail closed),
    // and any other launch consumes and ignores a stale marker.
    resumeSentinel = await consumeResumeSentinel(sessionDir);
    const created = await sdk.createAgentSession({
      cwd,
      agentDir: runtimeDir,
      settings,
      authStorage,
      sessionManager,
      ...(modelRegistry === undefined || guestTransport === undefined
        ? {}
        : { modelRegistry, model: guestTransport.model, rebindModelAfterDiscovery: false }),
      hasUI: false,
      interactivePrompts: false,
      settingsApproval: false,
      autoApprove: false,
      allowSessionModelFallback: false,
      requireYieldTool: false,
      cacheWarming: false,
      prewalk: undefined,
      deferredPrewalk: undefined,
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      disableExtensionDiscovery: true,
      additionalExtensionPaths: [],
      extensions: [],
      customTools: [],
      allowRestrictedCustomTools: false,
      restrictToolNames: true,
      toolNames: brokerConfig === undefined ? [] : [...NATIVE_OMP_TOOL_NAMES],
      // Explicit pinned skills only; ambient discovery stays off (skills root
      // discovery is disabled by the isolated settings and no discovery option
      // is passed). Absent manifest keeps the historical `skills: []` session.
      skills,
      rules: [],
      contextFiles: [],
      promptTemplates: [],
      slashCommands: [],
      spawns: "none",
      bindProcessState: false,
      skipPythonPreflight: true,
    });
    if (created.modelFallbackMessage) throw new Error("OMP attempted model fallback");
    session = resumeSentinel ? wrapResumeContinuation(sessionDir, created.session, resumeSentinel.tool_call_id) : created.session;
  } catch {
    try { await guestTransport?.close(); } catch {}
    try { await sessionManager?.dispose?.(); } catch {}
    try { await authStorage?.close?.(); } catch {}
    throw new Error("scoped OMP initialization failed");
  }
  try {
    await rpc.runRpcMode(session, { headless: true });
  } finally {
    try { await guestTransport?.close(); } catch {}
    try { await sessionManager?.dispose?.(); } catch {}
    try { await authStorage?.close?.(); } catch {}
  }
}

main().catch(() => {
  process.stderr.write("scoped OMP startup failed\n");
  process.exitCode = 1;
});
