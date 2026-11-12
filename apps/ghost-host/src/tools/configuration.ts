import { Type } from "typebox";
import { Command, matchesToolPatterns, parse, type GhostTool } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { configurationCommand, reviseConfiguration } from "../core/configuration.ts";
import { planGhostConfiguration } from "../core/ghost-configuration.ts";
import { readMetrics } from "../core/metrics.ts";
import { conflict, forbidden, invalid } from "../core/errors.ts";
import { digestOf, idFor } from "../core/ids.ts";
import { NoEffect } from "../core/effects.ts";
import { errorResult, requireAllowed } from "./shared.ts";

const text = (value: string): ToolExecutionResult => ({ content: [{ type: "text", text: value }] });
const CONFIG_COMMANDS = ["scope.create", "scope.update", "scope.attach", "scope.delete", "slot.set", "slot.delete", "limits.set", "rule.create", "rule.update", "rule.delete", "mcp.create", "mcp.update", "mcp.delete", "config.revert"] as const;
interface Proposal { command: Command; reason: string; fingerprint: string; ghostId: string; tool: string }

export function createConfigurationTools(core: Core): Extension {
  const apply = (input: Proposal) => core.ledger.tx(() => {
    const plan = planGhostConfiguration(core, input.ghostId, input.command);
    if (plan.fingerprint !== input.fingerprint) throw conflict("Configuration or grants changed while this request waited. Read the latest configuration and propose again.");
    return reviseConfiguration(core, { kind: "ghost", ghostId: input.ghostId }, input.command, () => {
      const result = configurationCommand(core, input.command);
      if (result === undefined) throw invalid("Unsupported configuration command");
      if (input.command.type === "rule.create" && typeof result.ruleId === "string") {
        const rule = core.ledger.policyRule(result.ruleId);
        core.ledger.putPolicyRule({ ...rule, createdBy: { kind: "ghost", ghostId: input.ghostId } });
      }
      return JSON.stringify(result);
    }, input.reason);
  });
  const tools = [...CONFIG_COMMANDS, "rule.propose" as const].map((requested) => {
    const commandType = requested === "rule.propose" ? "rule.create" : requested;
    const name = requested.replace(".", "_");
    const schema = Command.anyOf.find((entry) => entry.properties.type.const === commandType)!;
    core.effects.onApproved(name, async (effect) => {
      const decision = core.ledger.decisionsAwaitingFollowUp().find((entry) => entry.effectId === effect.id && entry.state === "approved");
      const input = decision?.proposal?.input as Proposal | undefined;
      if (!input || input.tool !== name || digestOf({ command: input.command, reason: input.reason, ghostId: input.ghostId, tool: input.tool }) !== effect.inputDigest) throw new NoEffect("The approved configuration identity is invalid.");
      const conversation = core.ledger.conversation(effect.conversationId);
      const ghost = core.ledger.ghost(conversation.ghostId);
      if (ghost.id !== input.ghostId || ghost.state !== "active" || ghost.deletedAt !== null || !matchesToolPatterns(ghost.tools, name) || !["direct", "wake"].includes(conversation.kind)) throw new NoEffect("The configuring Ghost or tool grant was revoked.");
      try { return apply(input); } catch (error) { throw new NoEffect(error instanceof Error ? error.message : String(error)); }
    });
    return defineTool({
      name,
      description: `Apply ${commandType} in your received scope. Tightening takes effect immediately with a revision; widening requires an owner decision with no timeout. Refresh after a conflict.`,
      parameters: Type.Object({ ...Type.Omit(schema, ["type"]).properties, ...(requested === "rule.propose" ? { ruleId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) } : {}), reason: Type.String({ minLength: 1, maxLength: 2048 }) }),
      replay: "unsafe",
      async execute(args, api) {
        try {
          const scope = requireAllowed(core, api, name as GhostTool);
          if (!["direct", "wake"].includes(scope.conversation.kind)) throw forbidden("Configuration runs only in direct or wake conversations");
          const { reason, ...fields } = args as Record<string, unknown>;
          if (typeof reason !== "string" || !reason.trim() || reason.length > 2048) throw invalid("Configuration changes require a bounded reason");
          const command = parse(Command, { ...fields, type: requested === "rule.propose" && typeof fields.ruleId === "string" ? "rule.update" : commandType });
          const identity = { command, reason: String(reason), ghostId: scope.ghost.id, tool: name };
          const requestId = idFor(scope.conversation.id, `${api.callId}:configuration`);
          const receipt = core.ledger.request(requestId);
          if (receipt) {
            if (receipt.principal !== `ghost:${scope.ghost.id}` || receipt.digest !== digestOf(identity)) throw conflict("Call identity belongs to different configuration input");
            return text(String(receipt.outcome.text));
          }
          const prior = core.ledger.effectByCall(scope.conversation.id, api.callId);
          if (prior) {
            if (prior.tool !== name || prior.inputDigest !== digestOf(identity)) throw conflict("Call identity belongs to different configuration input");
            if (prior.state === "done" || prior.state === "denied") return text(prior.result ?? prior.state);
            return text(`Configuration decision remains ${prior.state} (${prior.id}); no change was replayed.`);
          }
          const plan = planGhostConfiguration(core, scope.ghost.id, command);
          const input: Proposal = { ...identity, fingerprint: plan.fingerprint };
          if (!plan.widening) return text(core.ledger.tx(() => {
            const result = apply(input);
            core.ledger.putRequest(requestId, `ghost:${scope.ghost.id}`, digestOf(identity), { text: result });
            return result;
          }));
          const metrics = readMetrics(core.ledger, { scopeId: plan.scopeId });
          const effect = core.effects.propose({ conversationId: scope.conversation.id, callId: api.callId, tool: name, input: identity,
            summary: `${commandType}: ${reason}`, title: `구성 권한 변경: ${commandType}`, detail: `${reason}\n\n${JSON.stringify(command)}\n\n${JSON.stringify(metrics)}`,
            proposal: { input, metrics, forceOwner: true } });
          return text(core.effects.proposalStatus(effect));
        } catch (error) { return errorResult(error); }
      },
    });
  });
  const metrics = defineTool({
    name: "metrics_read", description: "Read actual Work outcomes, elapsed time, usage, cost, quota waits, repeated failures and stored rule decisions. Unavailable usage or cost is null, not zero.",
    parameters: Type.Object({ scopeId: Type.Optional(Type.Union([Type.String(), Type.Null()])), ghostId: Type.Optional(Type.String()), slot: Type.Optional(Type.String()), ruleId: Type.Optional(Type.String()) }), replay: "safe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "metrics_read" as GhostTool);
        if (!scope.ghost.isDefault) {
          if (!args.scopeId || (core.ledger.scope(args.scopeId).ghostId ?? core.ledger.defaultGhost()?.id) !== scope.ghost.id) throw forbidden("Metrics must select a scope received by this Ghost");
        }
        return text(JSON.stringify(readMetrics(core.ledger, args)));
      } catch (error) { return errorResult(error); }
    },
  });
  const history = defineTool({
    name: "config_history", description: "Read configuration revisions and current scope configuration. Select a received scope unless you are the default Ghost.",
    parameters: Type.Object({ scopeId: Type.Optional(Type.Union([Type.String(), Type.Null()])) }), replay: "safe",
    async execute(args, api) {
      try {
        const scope = requireAllowed(core, api, "config_history" as GhostTool);
        if (!scope.ghost.isDefault && (!args.scopeId || (core.ledger.scope(args.scopeId).ghostId ?? core.ledger.defaultGhost()?.id) !== scope.ghost.id)) throw forbidden("Configuration history must stay in the received scope");
        const revisions = core.ledger.configRevisions().filter((revision) => args.scopeId === undefined || (revision.entity === "scope" || revision.entity === "limits") && revision.entityId === args.scopeId || revision.entity === "rule" && [revision.before, revision.after].some((value) => value && typeof value === "object" && "scopeId" in value && value.scopeId === args.scopeId));
        return text(JSON.stringify({ scopes: core.ledger.scopes().filter((entry) => args.scopeId === undefined || entry.id === args.scopeId), rules: core.ledger.policyRules().filter((entry) => args.scopeId === undefined || entry.scopeId === args.scopeId), revisions }));
      } catch (error) { return errorResult(error); }
    },
  });
  return defineExtension({ name: "ghost.configuration", tools: [...tools, metrics, history] });
}
