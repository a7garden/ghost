import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Scope, PolicyRule, McpServer, Ghost, Activity, Connection, Limits, ModelSlot, SlotName, validate, type Command, type ConfigRevision, type DocRef, type Principal, type ModelSlot as Slot, type Scope as ScopeValue, type PolicyRule as RuleValue, type McpServer as ServerValue, type Ghost as GhostValue, type Activity as ActivityValue, type Limits as LimitsValue } from "@ghost/contract";
import type { Core } from "./core.ts";
import { conflict, invalid } from "./errors.ts";
import { newId } from "./ids.ts";

const liveStates = ["queued", "running", "waiting", "verifying", "blocked"] as const;
type Entity = ConfigRevision["entity"];
type Entry = { entity: Entity; entityId: string | null; value: unknown };

export type ConnectionMetadata = Omit<Connection, "hasCredential" | "credentialVersion" | "updatedAt">;

export function connectionMetadata(connection: Connection | null): ConnectionMetadata | null {
  if (!connection) return null;
  const source = connection.config;
  let config: Connection["config"];
  if (source.kind === "api") {
    const headers = Object.fromEntries(Object.entries(source.headers).filter(([name]) => name.toLowerCase() !== source.authHeader.toLowerCase() && !/authorization|cookie|token|secret|password|api[-_]?key/i.test(name)));
    config = { kind: "api", baseUrl: source.baseUrl, authHeader: source.authHeader, authPrefix: source.authPrefix, testPath: source.testPath, headers, ghostIds: source.ghostIds,
      ...(source.readPaths ? { readPaths: source.readPaths.map(({ method, path }) => ({ method, path })) } : {}) };
  } else if (source.kind === "mail") {
    config = { kind: "mail", host: source.host, port: source.port, username: source.username, mailbox: source.mailbox, smtpHost: source.smtpHost, smtpPort: source.smtpPort, smtpSecure: source.smtpSecure, ...(source.authType ? { authType: source.authType } : {}) };
  } else config = { kind: source.kind, baseUrl: source.baseUrl };
  return { id: connection.id, name: connection.name, config, createdAt: connection.createdAt, ...(connection.serviceId !== undefined ? { serviceId: connection.serviceId } : {}), ...(connection.iconUrl !== undefined ? { iconUrl: connection.iconUrl } : {}) };
}

export function absoluteDirectory(path: string): string {
  try {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) throw new Error();
    return realpathSync(path);
  } catch { throw invalid("scope paths must be existing absolute directories"); }
}

export function checkAttachments(core: Core, refs: DocRef[]) {
  for (const ref of refs) if (ref.kind === "page") {
    const scope = core.ledger.scope(ref.scopeId);
    if (!scope.vaultPath) throw invalid("an attached page needs a scope with a document vault");
    if (isAbsolute(ref.locator) || ref.locator.split(/[\\/]/).includes("..")) throw invalid("an attached page locator must stay inside its vault");
  }
}

function configuration(core: Core): Entry[] {
  const ledger = core.ledger;
  return [
    ...ledger.scopes().map(value => ({ entity: "scope" as const, entityId: value.id, value })),
    ...ledger.ghosts().map(value => ({ entity: "ghost" as const, entityId: value.id, value })),
    ...ledger.policyRules().map(value => ({ entity: "rule" as const, entityId: value.id, value })),
    ...ledger.mcpServers().map(value => ({ entity: "mcp" as const, entityId: value.id, value })),
    ...ledger.activities(true).map(value => ({ entity: "activity" as const, entityId: value.id, value })),
    ...ledger.connections().map(value => ({ entity: "connection" as const, entityId: value.id, value: connectionMetadata(value) })),
    ...Object.entries(ledger.settings().slots ?? {}).map(([entityId, value]) => ({ entity: "slot" as const, entityId, value })),
    { entity: "slot", entityId: null, value: ledger.settings().defaultSlot ?? null },
    { entity: "limits", entityId: null, value: ledger.limits() },
  ];
}

/** Runs inside the command's receipt transaction, including all secondary Ghost/activity mutations. */
export function reviseConfiguration<T>(core: Core, principal: Principal | { kind: "ghost"; ghostId: string }, command: Command, run: () => T, reason: string = command.type): T {
  const reverted = command.type === "config.revert" ? core.ledger.configRevision(command.revisionId) : null;
  const before = configuration(core);
  const result = run();
  if (command.type.startsWith("ghost.") || command.type.startsWith("activity.")) checkConfiguration(core);
  const after = configuration(core);
  const keys = new Set([...before, ...after].map(entry => JSON.stringify([entry.entity, entry.entityId])));
  let revisions = 0;
  for (const key of keys) {
    const [entity, entityId] = JSON.parse(key) as [Entity, string | null];
    const old = before.find(entry => entry.entity === entity && entry.entityId === entityId)?.value ?? null;
    const next = after.find(entry => entry.entity === entity && entry.entityId === entityId)?.value ?? null;
    if (isDeepStrictEqual(old, next)) continue;
    const scopedLimits = entity === "scope" && (command.type === "limits.set" || (reverted?.entity === "limits" && reverted.entityId === entityId));
    revisions++;
    core.ledger.putConfigRevision({ id: newId(), entity: scopedLimits ? "limits" : entity, entityId,
      before: scopedLimits && old && typeof old === "object" && "limits" in old ? old.limits : old,
      after: scopedLimits && next && typeof next === "object" && "limits" in next ? next.limits : next,
      actor: { kind: principal.kind, id: principal.kind === "device" ? principal.deviceId : principal.kind === "ghost" ? principal.ghostId : null },
      reason: command.type === "config.revert" ? `${reason} (revert ${command.revisionId})` : reason, at: Date.now() });
  }
  if (reverted && revisions === 0) {
    const entry = after.find(item => item.entity === reverted.entity && item.entityId === reverted.entityId);
    core.ledger.putConfigRevision({ ...reverted, id: newId(), before: entry?.value ?? reverted.before, after: entry?.value ?? reverted.before, actor: { kind: principal.kind, id: principal.kind === "device" ? principal.deviceId : principal.kind === "ghost" ? principal.ghostId : null }, reason: `config.revert:${reverted.id}`, at: Date.now() });
  }
  return result;
}

/** Check the prospective graph, never repair references by widening them to global authority. */
export function checkConfiguration(core: Core) {
  const ledger = core.ledger;
  const scopes = new Set(ledger.scopes().map(scope => scope.id));
  const ghosts = new Set(ledger.ghosts().filter(ghost => ghost.deletedAt === null).map(ghost => ghost.id));
  const slots = ledger.settings().slots ?? {};
  const requireScope = (id: string | null | undefined) => { if (id != null && !scopes.has(id)) throw conflict(`scope ${id} is still referenced or missing`); };
  const requireGhost = (id: string | null | undefined) => { if (id != null && !ghosts.has(id)) throw conflict(`Ghost ${id} is still referenced or missing`); };
  const requireSlot = (name: string | null | undefined) => { if (name != null && !slots[name]) throw conflict(`slot ${name} is still referenced or missing`); };
  for (const scope of ledger.scopes()) { requireGhost(scope.ghostId); checkAttachments(core, scope.attachments); }
  for (const ghost of ledger.ghosts()) if (ghost.deletedAt === null) checkAttachments(core, ghost.attachments);
  for (const work of ledger.worksInState(...liveStates)) {
    requireScope(work.scopeId); checkAttachments(core, work.attachments); requireSlot(work.slot); requireSlot(work.retry?.slot);
  }
  for (const rule of ledger.policyRules()) {
    requireScope(rule.scopeId); requireGhost(rule.ghostId);
    if (rule.triggerId && !ledger.activities().some(activity => activity.id === rule.triggerId)) throw conflict("rule refers to a missing activity");
    if (rule.reviewer?.kind === "ghost") requireGhost(rule.reviewer.ghostId);
    if (rule.reviewer?.kind === "slot") requireSlot(rule.reviewer.slot);
    if (rule.createdBy.kind === "ghost") requireGhost(rule.createdBy.ghostId);
  }
  for (const activity of ledger.activities()) {
    requireScope(activity.scopeId); requireGhost(activity.ghostId);
    const ghost = ledger.ghost(activity.ghostId);
    if (activity.execution.kind === "host" && !ghost.hostExecution) throw conflict("activity would restore PC execution its Ghost no longer has");
    if (activity.source.kind === "commit") requireScope(activity.source.scopeId);
    if ("connectionId" in activity.source && !ledger.findConnection(activity.source.connectionId)) throw conflict("activity refers to a missing connection");
  }
  for (const server of ledger.mcpServers()) if (server.transport.kind === "http" && server.transport.connectionId && !ledger.findConnection(server.transport.connectionId)) throw conflict("MCP server refers to a missing connection");
  requireSlot(ledger.settings().defaultSlot);
  for (const slot of Object.values(slots)) for (const model of [slot.model, ...slot.fallbacks]) if (!ledger.providers().some(provider => provider.id === model.provider)) throw conflict("slot refers to a missing provider");
  for (const goal of core.goals.goals()) if (goal.state !== "closed") requireScope(goal.scopeId);
}

export function configurationCommand(core: Core, command: Command): Record<string, unknown> | undefined {
  const ledger = core.ledger;
  const now = Date.now();
  switch (command.type) {
    case "scope.create": {
      const { type: _, ...input } = command;
      const scope = { id: newId(), name: input.name, paths: input.paths.map(absoluteDirectory), vaultPath: input.vaultPath == null ? null : absoluteDirectory(input.vaultPath), ghostId: input.ghostId ?? null, state: input.state ?? "active" as const, attachments: input.attachments ?? [], limits: input.limits ?? {}, createdAt: now, updatedAt: now };
      ledger.putScope(scope); checkConfiguration(core); return { scopeId: scope.id };
    }
    case "scope.update":
    case "scope.attach": {
      const { type: _, scopeId, ...patch } = command;
      const scope = { ...ledger.scope(scopeId), ...patch, updatedAt: now };
      if (command.type === "scope.update" && command.paths !== undefined) scope.paths = command.paths.map(absoluteDirectory);
      if (command.type === "scope.update" && command.vaultPath !== undefined) scope.vaultPath = command.vaultPath === null ? null : absoluteDirectory(command.vaultPath);
      ledger.putScope(scope); checkConfiguration(core); return {};
    }
    case "scope.delete":
      ledger.scope(command.scopeId); ledger.deleteScope(command.scopeId); checkConfiguration(core); return {};
    case "slot.set": {
      const { name, model, fallbacks } = command;
      for (const ref of [model, ...fallbacks]) if (!ledger.providers().some(provider => provider.id === ref.provider)) throw invalid("slot refers to a missing provider");
      ledger.putSetting("slots", { ...ledger.settings().slots, [name]: { model, fallbacks } });
      ledger.emit({ type: "settings", settings: ledger.settings() }); return {};
    }
    case "slot.delete": {
      const slots = { ...ledger.settings().slots };
      if (!slots[command.name]) throw invalid("unknown slot");
      delete slots[command.name]; ledger.putSetting("slots", slots); checkConfiguration(core);
      ledger.emit({ type: "settings", settings: ledger.settings() }); return {};
    }
    case "limits.set":
      if (command.scopeId != null) {
        const scope = ledger.scope(command.scopeId);
        ledger.putScope({ ...scope, limits: command.limits, updatedAt: now });
      } else { ledger.putSetting("limits", { ...ledger.limits(), ...command.limits }); ledger.emit({ type: "settings", settings: ledger.settings() }); }
      return {};
    case "rule.create": {
      const { type: _, ...input } = command;
      const rule = { ...input, id: newId(), revision: 1, createdBy: { kind: "owner" as const } };
      ledger.putPolicyRule(rule); checkConfiguration(core); return { ruleId: rule.id };
    }
    case "rule.update": {
      const { type: _, ruleId, ...patch } = command;
      const previous = ledger.policyRule(ruleId);
      const next = { ...previous, revision: previous.revision + 1 };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) Reflect.deleteProperty(next, key);
        else Reflect.set(next, key, value);
      }
      if (!validate(PolicyRule, next)) throw invalid("invalid policy rule");
      ledger.putPolicyRule(next); checkConfiguration(core); return {};
    }
    case "rule.delete": ledger.policyRule(command.ruleId); ledger.deletePolicyRule(command.ruleId); return {};
    case "mcp.create": {
      const { type: _, ...input } = command;
      const server = { ...input, id: newId(), createdAt: now, updatedAt: now };
      checkServer(server); ledger.putMcpServer(server); checkConfiguration(core); return { serverId: server.id };
    }
    case "mcp.update": {
      const { type: _, serverId, ...patch } = command;
      const server = { ...ledger.mcpServer(serverId), ...patch, updatedAt: now };
      checkServer(server); ledger.putMcpServer(server); checkConfiguration(core); return {};
    }
    case "mcp.delete": ledger.mcpServer(command.serverId); ledger.deleteMcpServer(command.serverId); return {};
    case "config.revert": revert(core, ledger.configRevision(command.revisionId)); return {};
    default: return undefined;
  }
}

function checkServer(server: ServerValue) {
  if (server.transport.kind === "stdio") {
    if (server.transport.cwd !== null) absoluteDirectory(server.transport.cwd);
  } else {
    let url: URL;
    try { url = new URL(server.transport.url); } catch { throw invalid("invalid MCP URL"); }
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw invalid("MCP requires https or a loopback http URL without credentials");
  }
}

function revert(core: Core, revision: ConfigRevision) {
  const ledger = core.ledger;
  const id = revision.entityId;
  const value = revision.before;
  const latest = ledger.configRevisions(revision.entity, revision.entityId).at(-1);
  if (latest?.id !== revision.id) throw conflict("Configuration has a newer revision; refresh before reverting.");
  const currentValue = configuration(core).find((entry) => entry.entity === revision.entity && entry.entityId === id)?.value ?? null;
  const current = revision.entity === "limits" && id !== null ? ledger.scope(id).limits : currentValue;
  if (!isDeepStrictEqual(current, revision.after)) throw conflict("Configuration changed since this revision; refresh before reverting.");
  const shape = (schema: Parameters<typeof validate>[0]) => { if (!validate(schema, value)) throw conflict("revision has invalid configuration"); };
  switch (revision.entity) {
    case "scope":
      if (value === null) ledger.deleteScope(id!);
      else { shape(Scope); const scope = value as ScopeValue; scope.paths.forEach(absoluteDirectory); if (scope.vaultPath) absoluteDirectory(scope.vaultPath); ledger.putScope(scope); }
      break;
    case "rule": if (value === null) ledger.deletePolicyRule(id!); else { shape(PolicyRule); ledger.putPolicyRule(value as RuleValue); } break;
    case "mcp": if (value === null) ledger.deleteMcpServer(id!); else { shape(McpServer); checkServer(value as ServerValue); ledger.putMcpServer(value as ServerValue); } break;
    case "slot": {
      if (id === null) { if (value !== null) shape(SlotName); ledger.putSetting("defaultSlot", value); }
      else {
        const slots: Record<string, Slot> = { ...ledger.settings().slots };
        if (value === null) delete slots[id]; else { shape(ModelSlot); slots[id] = value as Slot; }
        ledger.putSetting("slots", slots);
      }
      ledger.emit({ type: "settings", settings: ledger.settings() }); break;
    }
    case "connection": {
      if (!id) throw conflict("Connection revision is missing its identity");
      const current = ledger.findConnection(id);
      if (isDeepStrictEqual(revision.before, revision.after)) throw conflict("Authentication-only revisions cannot be reverted; reconnect through connection settings.");
      if (value === null) {
        if (current?.hasCredential || core.activitySources?.credentialPresent(id)) throw conflict("A credential-bearing connection must be removed through connection settings.");
        ledger.deleteConnection(id);
      } else {
        if (!validate(ConnectionMetadataSchema, value)) throw conflict("Revision has invalid connection metadata");
        const metadata = value as ConnectionMetadata;
        if (metadata.id !== id) throw conflict("Connection revision identity changed");
        if (current?.hasCredential) {
          const identity = (config: Connection["config"]) => {
            if (config.kind !== "api") return config;
            const { ghostIds: _grants, readPaths: _reads, ...authentication } = config;
            return authentication;
          };
          if (!isDeepStrictEqual(identity(current.config), identity(metadata.config))) throw conflict("Authentication endpoints cannot be reverted while a credential is connected; reconnect through connection settings.");
        }
        ledger.putConnection({ ...metadata, hasCredential: current?.hasCredential ?? false, credentialVersion: current?.credentialVersion ?? null, updatedAt: Date.now() });
      }
      core.activities.invalidateConnection(id);
      break;
    }
    case "limits":
      if (id === null) { shape(Limits); ledger.putSetting("limits", value); ledger.emit({ type: "settings", settings: ledger.settings() }); }
      else { if (!validate(importPartialLimits, value)) throw conflict("revision has invalid limits"); const scope = ledger.scope(id); ledger.putScope({ ...scope, limits: value as Partial<LimitsValue> }); }
      break;
    case "ghost": {
      if (value === null) {
        const conversations = ledger.conversations({ ghostId: id! });
        if (conversations.some(conversation => conversation.busy || ledger.piConversationId(conversation.id) !== null)
          || ledger.db.query("SELECT 1 FROM works WHERE ghost_id=? OR origin_conversation_id IN (SELECT id FROM conversations WHERE ghost_id=?) LIMIT 1").get(id!, id!)
          || ledger.db.query("SELECT 1 FROM schedules WHERE ghost_id=? LIMIT 1").get(id!)) throw conflict("Ghost has durable history or active references");
        for (const conversation of conversations) {
          ledger.db.query("DELETE FROM conversations WHERE id=?").run(conversation.id);
          ledger.emit({ type: "conversation.removed", id: conversation.id });
        }
        ledger.db.query("DELETE FROM ghosts WHERE id=?").run(id!);
        ledger.emit({ type: "ghost.removed", id: id! });
        break;
      }
      shape(Ghost);
      const ghost = value as GhostValue;
      const current = ledger.ghost(ghost.id);
      if (!ghost.isDefault && current.isDefault) throw conflict("choose another default Ghost before this revert");
      if (ghost.isDefault && !current.isDefault) {
        if (ghost.state !== "active" || ghost.deletedAt !== null) throw conflict("the restored default Ghost must be active");
        const previousDefault = ledger.defaultGhost();
        if (previousDefault) { ledger.putGhost({ ...previousDefault, isDefault: false }); core.refreshGhost(previousDefault.id); }
      }
      if (ghost.deletedAt !== null && ledger.worksInState(...liveStates).some(work => work.ghostId === ghost.id || (work.acceptance.reviewer?.kind === "ghost" && work.acceptance.reviewer.ghostId === ghost.id))) throw conflict("Ghost still has live Work");
      ledger.conversation(ghost.directConversationId); ledger.putGhost(ghost); core.refreshGhost(ghost.id); break;
    }
    case "activity": {
      const current = id ? ledger.findActivity(id) : null;
      if (current && ledger.activityRuns(current.id).some(run => liveStates.includes(run.state as typeof liveStates[number]))) throw conflict("activity still has live Work");
      if (value === null) {
        if (current && (ledger.activityRuns(current.id).length || ledger.db.query("SELECT 1 FROM works WHERE activity_id=? LIMIT 1").get(current.id))) throw conflict("activity has durable Work history");
        if (current) core.activities.removePolicy(current.id);
        ledger.db.query("DELETE FROM activities WHERE id=?").run(id!);
        ledger.emit({ type: "activity.removed", id: id! });
      } else {
        shape(Activity);
        const activity = { ...(value as ActivityValue), revision: Math.max(current?.revision ?? 0, (value as ActivityValue).revision) + 1, updatedAt: Date.now() };
        const ghost = ledger.ghost(activity.ghostId);
        if (activity.execution.kind === "host" && !ghost.hostExecution) throw conflict("activity would restore PC execution its Ghost no longer has");
        ledger.putActivity(activity);
        if (activity.deletedAt !== null) core.activities.removePolicy(activity.id);
        else core.activities.syncPolicy(activity, current ?? undefined);
      }
      break;
    }
  }
  checkConfiguration(core);
}

const importPartialLimits = Type.Partial(Limits);
const ConnectionMetadataSchema = Type.Omit(Connection, ["hasCredential", "credentialVersion", "updatedAt"]);
