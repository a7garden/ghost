import { isDeepStrictEqual } from "node:util";
import type { Command, ConfigRevision, PolicyRule, DocRef } from "@ghost/contract";
import type { Core } from "./core.ts";
import { forbidden, invalid } from "./errors.ts";
import { absoluteDirectory, connectionMetadata } from "./configuration.ts";
import { digestOf } from "./ids.ts";
import { isPolicyTightening } from "./policy-context.ts";

export interface ConfigurationPlan { widening: boolean; fingerprint: string; scopeId: string | null }

/** Execution-time scope checks, never prompt-only authorization. Incomparable edits require the owner. */
export function planGhostConfiguration(core: Core, ghostId: string, command: Command): ConfigurationPlan {
  const ledger = core.ledger;
  const ghost = ledger.ghost(ghostId);
  if (ghost.deletedAt !== null || ghost.state !== "active") throw forbidden("The configuring Ghost is unavailable");
  let scopeId: string | null = null;
  let widening = true;
  const attachments = (refs: DocRef[], ownScope: string | null) => {
    for (const ref of refs) {
      if (ref.kind === "page" && !ghost.isDefault && ref.scopeId !== ownScope) throw forbidden("Attachments must stay in the received scope");
    }
  };
  const limitsTighten = (old: Record<string, number>, next: Record<string, number>) => Object.entries(next).every(([key, value]) => value <= (old[key] ?? 0));
  const scopeChange = (old: Record<string, unknown> | null, next: Record<string, unknown> | null) => {
    if (!next) return true;
    if (!old) return !(next.paths as string[]).length && !next.vaultPath && !((next.attachments ?? []) as DocRef[]).some((ref) => ref.kind === "page") && limitsTighten(ledger.limits(), { ...ledger.limits(), ...next.limits as object });
    const oldPaths = old.paths as string[];
    if ((next.paths as string[]).some((path) => !oldPaths.includes(absoluteDirectory(path)))) return false;
    if (next.vaultPath !== old.vaultPath && next.vaultPath !== null) return false;
    if (next.ghostId !== old.ghostId) return false;
    const priorAttachments = (old.attachments ?? []) as DocRef[];
    if (((next.attachments ?? []) as DocRef[]).some((ref) => ref.kind === "page" && ref.scopeId !== next.id && !priorAttachments.some((oldRef) => isDeepStrictEqual(ref, oldRef)))) return false;
    return limitsTighten({ ...ledger.limits(), ...old.limits as object }, { ...ledger.limits(), ...next.limits as object });
  };
  switch (command.type) {
    case "ghost.create":
      if (!ghost.isDefault) throw forbidden("Only the default Ghost configures Ghosts");
      widening = true;
      break;
    case "ghost.update": case "ghost.delete": {
      if (!ghost.isDefault) throw forbidden("Only the default Ghost configures Ghosts");
      const target = ledger.ghost(command.ghostId);
      if (target.isDefault) throw forbidden("The default Ghost's settings remain owner-only");
      if (command.type === "ghost.delete") { widening = false; break; }
      const next = { ...target, ...command };
      attachments(next.attachments, null);
      widening = (next.hostExecution && !target.hostExecution)
        || next.tools.some((tool) => !target.tools.includes(tool))
        || !isDeepStrictEqual(next.model, target.model)
        || !isDeepStrictEqual(next.fallbacks, target.fallbacks)
        || (target.state !== "active" && next.state === "active")
        || next.attachments.some((ref) => ref.kind === "page" && !target.attachments.some((old) => isDeepStrictEqual(old, ref)));
      break;
    }
    case "scope.create": {
      if (!ghost.isDefault) throw forbidden("Only the default Ghost creates scopes");
      attachments(command.attachments ?? [], null);
      widening = !scopeChange(null, { ...command, paths: command.paths, vaultPath: command.vaultPath ?? null, limits: command.limits ?? {} });
      break;
    }
    case "scope.update": case "scope.attach": case "scope.delete": {
      scopeId = command.scopeId;
      const old = ledger.scope(scopeId);
      const next = command.type === "scope.delete" ? null : { ...old, ...command };
      if (next) attachments(next.attachments, scopeId);
      widening = !scopeChange(old, next);
      break;
    }
    case "limits.set": {
      scopeId = command.scopeId ?? null;
      const old = ledger.limits(scopeId);
      const next = scopeId ? { ...ledger.limits(), ...command.limits } : { ...old, ...command.limits };
      widening = !limitsTighten(old, next); break;
    }
    case "rule.create": {
      scopeId = command.scopeId ?? null;
      if (!ghost.isDefault && command.ghostId !== undefined && command.ghostId !== ghost.id) throw forbidden("A scope rule cannot configure another Ghost");
      widening = command.decision !== "deny"; break;
    }
    case "rule.update": case "rule.delete": {
      const old = ledger.policyRule(command.ruleId);
      scopeId = old.scopeId ?? null;
      let next: PolicyRule | null = null;
      if (command.type === "rule.update") {
        const { type: _, ruleId: _ruleId, ...patch } = command;
        next = { ...old };
        for (const [key, value] of Object.entries(patch)) { if (value === null) Reflect.deleteProperty(next, key); else Reflect.set(next, key, value); }
        if (!ghost.isDefault && ((next.scopeId ?? null) !== scopeId || (next.ghostId !== undefined && next.ghostId !== ghost.id))) throw forbidden("A rule cannot leave the received scope");
      }
      widening = !isPolicyTightening(old, next); break;
    }
    case "slot.set": case "slot.delete": case "mcp.create": case "mcp.update": case "mcp.delete": {
      if (!ghost.isDefault) throw forbidden("Model slots and MCP servers are global settings");
      if (command.type === "slot.delete" || command.type === "mcp.delete") widening = false;
      else if (command.type === "mcp.update") {
        const old = ledger.mcpServer(command.serverId);
        const next = { ...old, ...command };
        widening = !(isDeepStrictEqual(next.transport, old.transport) && next.readTools.every((tool) => old.readTools.includes(tool)) && (!next.enabled || old.enabled));
      } else if (command.type === "slot.set") widening = !isDeepStrictEqual((ledger.settings().slots ?? {})[command.name], { model: command.model, fallbacks: command.fallbacks });
      break;
    }
    case "config.revert": {
      const revision = ledger.configRevision(command.revisionId);
      const before = revision.before as Record<string, unknown> | null;
      const after = revision.after as Record<string, unknown> | null;
      if (revision.entity === "scope") { scopeId = revision.entityId; widening = !scopeChange(after, before); if (before) attachments(before.attachments as DocRef[], scopeId); }
      else if (revision.entity === "limits") { scopeId = revision.entityId; widening = !before || !limitsTighten(ledger.limits(scopeId), { ...(scopeId ? ledger.limits() : ledger.limits(scopeId)), ...before }); }
      else if (revision.entity === "rule") {
        scopeId = (after?.scopeId ?? before?.scopeId ?? null) as string | null;
        if (!ghost.isDefault && before && ((before.scopeId ?? null) !== scopeId || (before.ghostId !== undefined && before.ghostId !== ghost.id))) throw forbidden("Restored rule must stay in the received scope");
        widening = !isPolicyTightening(after as PolicyRule | null, before as PolicyRule | null);
      } else {
        if (!ghost.isDefault) throw forbidden("Only the default Ghost reverts global configuration");
        if (revision.entity === "ghost") throw forbidden("Ghost settings are not changed through config_revert; use the owner settings");
        widening = before !== null;
      }
      break;
    }
    default: throw invalid("This command is not available as a configuration tool");
  }
  if (!ghost.isDefault) {
    if (!scopeId) throw forbidden("Only the default Ghost configures global settings");
    const scope = ledger.scope(scopeId);
    if ((scope.ghostId ?? ledger.defaultGhost()?.id) !== ghost.id) throw forbidden("This Ghost does not receive the requested scope");
  }
  const fingerprint = digestOf({ ghost, ghosts: ledger.ghosts(), settings: ledger.settings(), scopes: ledger.scopes(), rules: ledger.policyRules(), servers: ledger.mcpServers(), connections: ledger.connections().map((connection) => ({ metadata: connectionMetadata(connection), credentialVersion: connection.credentialVersion, hasCredential: connection.hasCredential })), revisions: ledger.configRevisions().map((revision: ConfigRevision) => revision.id) });
  return { scopeId, widening, fingerprint };
}
