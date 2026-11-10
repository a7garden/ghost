import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { connectionCredentialScope, FallbackList, GhostToolList, SkillList, validate, type Command, type CommandRequest, type Connection, type Ghost, type GhostState, type GhostTool, type Look, type ModelRef, type Space } from "@ghost/contract";
import type { Access } from "./access.ts";
import type { Core } from "./core.ts";
import type { CommandEffectTool } from "./effects.ts";
import type { DocumentsPort } from "../integrations/ports.ts";
import { CommandError, conflict, invalid } from "./errors.ts";
import { digestOf, newId, sha256 } from "./ids.ts";
import { supportsAutomaticModels } from "../integrations/provider-catalog.ts";
import { validateConnectionConfig } from "../integrations/activity-sources.ts";
import { projectContext } from "@ghost/contract";

export interface CommandContext {
  /** Origin a paired device should use, e.g. https://ghost.example.ts.net */
  publicOrigin: string;
  /** PDC vault access; null when the host runs without document support. */
  documents: DocumentsPort | null;
  /** Host-side authority check for an in-flight owner authorization; never model-supplied. */
  authorize?: () => void;
}

/** Pairing codes: 8 Crockford base32 characters, valid for 10 minutes. */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_TTL_MS = 10 * 60 * 1000;

export const hashSecret = (secret: string) => sha256(`ghost-secret/1\0${secret}`);

export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % 32]).join("");
}

type Outcome = Record<string, unknown>;
type Flight = { principal: string; digest: string; outcome: Promise<Outcome> };
const inFlight = new WeakMap<Core, Map<string, Flight>>();

/** Ledger mutations and receipts share a commit; external operations use their domain journals. */
export async function execute(core: Core, access: Access, request: CommandRequest, context: CommandContext): Promise<Outcome> {
  const principal = access.principal.kind === "owner" ? "owner" : `device:${access.principal.deviceId}`;
  access.authorize(request.command);
  // Refuse credential answers before even deriving a command digest or reserving a receipt.
  if (request.command.type === "decision.resolve" && core.ledger.findDecision(request.command.decisionId)?.proposal?.secureForm
    && (request.command.outcome !== "deny" || request.command.answer !== undefined)) {
    throw conflict("use the secure form to answer this request; ordinary answers are not accepted");
  }
  const digest = digestOf(request.command);
  let flights = inFlight.get(core);
  if (!flights) inFlight.set(core, flights = new Map());
  const previous = core.ledger.request(request.requestId);
  const active = flights.get(request.requestId);
  for (const identity of [previous, active]) {
    if (identity && (identity.principal !== principal || identity.digest !== digest)) throw conflict("request id reused with a different command");
  }
  if (active) return active.outcome;
  if (previous?.state === "done") return previous.outcome;
  // Start on the next microtask, after publishing the same-process join point.
  const outcome = Promise.resolve().then(async () => {
    const asyncCommand = ["message.send", "message.cancel", "decision.resolve", "sandbox.control", "document.save", "avatar.create", "provider.delete", "connection.upsert", "connection.delete", "connection.test", "activity.run"].includes(request.command.type)
      || (request.command.type === "provider.upsert" && request.command.apiKey !== undefined);
    if (!asyncCommand) {
      return core.ledger.tx(() => {
        const result = runSync(core, access, request, context);
        core.ledger.putRequest(request.requestId, principal, digest, result);
        return result;
      });
    }
    if (!previous) core.ledger.tx(() => {
      let claim: Outcome = {};
      if (["document.save", "provider.upsert", "provider.delete", "connection.delete"].includes(request.command.type)
        || (request.command.type === "connection.upsert" && request.command.credential !== undefined)) {
        const ghost = core.ledger.defaultGhost();
        if (!ghost) throw conflict("a default Ghost is required to journal this command");
        claim.conversationId = ghost.directConversationId;
      }
      if (request.command.type === "connection.upsert") claim.connectionId = request.command.connectionId ?? newId();
      core.ledger.claimRequest(request.requestId, principal, digest, claim);
      if (request.command.type === "decision.resolve") core.decisions.resolveState(request.command.decisionId, { outcome: request.command.outcome, answer: request.command.answer });
    });
    const result = await runAsync(core, request, context, principal, digest);
    if (core.ledger.request(request.requestId)?.state === "done") return result;
    core.ledger.tx(() => {
      if (request.command.type === "sandbox.control") core.ledger.emit({ type: "sandbox", sandbox: core.sandbox.status(request.command.ghostId) });
      core.ledger.putRequest(request.requestId, principal, digest, result);
    });
    return result;
  });
  flights.set(request.requestId, { principal, digest, outcome });
  try {
    return await outcome;
  } finally {
    flights.delete(request.requestId);
  }
}


async function runAsync(core: Core, request: CommandRequest, context: CommandContext, principal: string, digest: string): Promise<Outcome> {
  const { ledger } = core;
  const { command, requestId } = request;
  switch (command.type) {
    case "message.send":
      // Pi admission identity is distinct from the API mutation/receipt transaction.
      await core.sendMessage(command.conversationId, command.text, requestId, command.attachments ?? [], command.spaceIds ?? []);
      return {};
    case "message.cancel":
      await core.effects.cancelMessage(command.conversationId, requestId);
      return {};
    case "decision.resolve":
      await core.run(`decision:${command.decisionId}`, () => core.decisions.finishResolution(command.decisionId));
      return {};
    case "activity.run":
      return core.run(`activity:request:${requestId}`, () => core.activities.run(command.activityId, { dryRun: command.dryRun, requestId }));
    case "connection.upsert":
    case "connection.delete":
    case "connection.test": {
      const connectionId = command.type === "connection.upsert"
        ? ledger.request(requestId)!.outcome.connectionId as string
        : command.connectionId;
      if (!core.activitySources) throw new CommandError("unavailable", "source connections are not available");
      const sources = core.activitySources;
      // Authentication probes are reads; OAuth refresh owns the account's write lane.
      if (command.type === "connection.test") return sources.test(ledger.connection(connectionId));
      return core.run(`connection:${connectionId}`, async () => {
        context.authorize?.();
        const previous = command.type === "connection.delete" || command.connectionId !== undefined
          ? ledger.connection(connectionId) : ledger.findConnection(connectionId);
        if (command.type === "connection.upsert") {
          try { validateConnectionConfig(command.config); }
          catch (error) { throw invalid(error instanceof Error ? error.message : "invalid connection configuration"); }
          if (command.credential !== undefined && command.credential !== null && (!command.credential || command.credential.length > 8192 || /[\r\n\0]/.test(command.credential))) {
            throw invalid("enter a non-empty token or app password without line breaks");
          }
          if (command.credential === undefined) {
            if (previous && digestOf(connectionCredentialScope(previous.config)) !== digestOf(connectionCredentialScope(command.config))) throw invalid("re-enter or explicitly remove the credential when changing account configuration");
            return ledger.tx(() => {
              const now = Date.now();
              ledger.putConnection({
                id: connectionId, name: command.name, config: command.config,
                ...(command.serviceId !== undefined ? { serviceId: command.serviceId } : previous?.serviceId !== undefined ? { serviceId: previous.serviceId } : {}),
                ...(command.iconUrl === null ? {} : command.iconUrl !== undefined ? { iconUrl: command.iconUrl } : previous?.iconUrl !== undefined ? { iconUrl: previous.iconUrl } : {}),
                hasCredential: previous?.hasCredential ?? false, credentialVersion: previous?.credentialVersion ?? null,
                createdAt: previous?.createdAt ?? now, updatedAt: now,
              });
              const result = { connectionId };
              ledger.putRequest(requestId, principal, digest, result);
              return result;
            });
          }
        }
        const conversationId = ledger.request(requestId)!.outcome.conversationId as string;
        const credential = command.type === "connection.delete" ? null : command.credential!;
        const credentialVersion = credential === null ? null : newId();
        const metadata = {
          serviceId: command.type === "connection.upsert" ? command.serviceId ?? previous?.serviceId : previous!.serviceId,
          iconUrl: command.type === "connection.upsert" ? command.iconUrl === null ? undefined : command.iconUrl ?? previous?.iconUrl : previous!.iconUrl,
        };
        const staged = ledger.tx(() => {
          const start = core.effects.beginCommand({ conversationId, requestId, tool: command.type, input: command, summary: `API ${command.type}` });
          if (start.kind === "replay") return { start, connection: null };
          const now = Date.now();
          const connection: Connection = {
            id: connectionId,
            name: command.type === "connection.upsert" ? command.name : previous!.name,
            config: command.type === "connection.upsert" ? command.config : previous!.config,
            ...(metadata.serviceId !== undefined ? { serviceId: metadata.serviceId } : {}),
            ...(metadata.iconUrl !== undefined ? { iconUrl: metadata.iconUrl } : {}),
            hasCredential: false, credentialVersion, createdAt: previous?.createdAt ?? now, updatedAt: now,
          };
          ledger.putConnection(connection);
          core.activities.invalidateConnection(connectionId);
          return { start, connection };
        });
        if (staged.start.kind === "replay") return recordedCommandOutcome(staged.start.effect.state, staged.start.effect.result);
        try {
          // Disconnect and invalidate old source authority before touching the secret file.
          await sources.setCredential(connectionId, credential, credentialVersion);
          context.authorize?.();
          return ledger.tx(() => {
            if (command.type === "connection.delete") ledger.deleteConnection(connectionId);
            else ledger.putConnection({ ...staged.connection!, hasCredential: credential !== null, updatedAt: Date.now() });
            const result = command.type === "connection.delete" ? {} : { connectionId };
            core.effects.finish(staged.start.effect.id, `api-result:${JSON.stringify(result)}`);
            ledger.putRequest(requestId, principal, digest, result);
            return result;
          });
        } catch {
          // Transport/filesystem errors may contain the supplied credential. Persist no raw text.
          const message = "connection credential change has an unknown outcome; reconcile it before retrying";
          core.effects.unknown(staged.start.effect.id, message);
          throw new CommandError("unavailable", message);
        }
      });
    }
    case "sandbox.control": {
      const ghost = ledger.ghost(command.ghostId);
      return journalCommand(core, requestId, command, ghost.directConversationId, async () => {
        await core.sandbox.control(command.ghostId, command.action);
        return {};
      });
    }
    case "document.save": {
      if (!context.documents) throw new CommandError("unavailable", "document spaces are not available");
      ledger.space(command.spaceId);
      const documents = context.documents;
      const proposal = {
        spaceId: command.spaceId, title: command.title, body: command.body,
        profile: command.profile ?? "pdc-markdown/1", pageId: command.pageId, expectedHash: command.expectedHash,
      };
      const conversationId = ledger.request(requestId)!.outcome.conversationId as string;
      // Preflight failures are retryable. Once save starts, an uncertain write must be reconciled.
      const existing = ledger.effectByCall(conversationId, `api:${requestId}`);
      if (!existing) await documents.check(proposal);
      return journalCommand(core, requestId, command, conversationId, async () => {
        const page = await documents.save(proposal);
        return { pageId: page.pageId, hash: page.hash };
      });
    }
    case "avatar.create": {
      // Blob storage is content-addressed; an interruption can leave only an unreferenced blob.
      const [header, base64] = command.image.split(",", 2) as [string, string];
      const mediaType = header.slice("data:".length, header.indexOf(";"));
      const ref = await core.artifacts.put(Buffer.from(base64, "base64"), `${command.name}.${mediaType.split("/")[1]}`, mediaType);
      const avatar = { id: newId(), name: command.name, description: command.description, imageDigest: ref.digest, design: command.design ?? null, createdAt: Date.now() };
      return ledger.tx(() => {
        ledger.addArtifact(null, ref);
        ledger.putAvatar(avatar);
        const result = { avatarId: avatar.id };
        ledger.putRequest(requestId, principal, digest, result);
        return result;
      });
    }
    case "provider.upsert":
    case "provider.delete": {
      const conversationId = ledger.request(requestId)!.outcome.conversationId as string;
      const start = core.effects.beginCommand({ conversationId, requestId, tool: command.type, input: command, summary: command.type });
      if (start.kind === "replay") return recordedCommandOutcome(start.effect.state, start.effect.result);
      try {
        // Credentials live outside SQLite. Never repeat an interrupted replacement, which
        // could overwrite a newer OAuth login or API key. No secret enters the ledger.
        if (command.type === "provider.delete") core.secrets.put(command.providerId, null);
        else if (command.apiKey !== undefined) core.secrets.put(command.id, command.apiKey);
        return ledger.tx(() => {
          if (command.type === "provider.delete") ledger.deleteProvider(command.providerId);
          else ledger.putProvider({ id: command.id, kind: command.kind, name: command.name, baseUrl: command.baseUrl ?? null, models: command.models });
          ledger.emit({ type: "settings", settings: settingsView(core) });
          core.effects.finish(start.effect.id, "api-result:{}");
          ledger.putRequest(requestId, principal, digest, {});
          return {};
        });
      } catch (error) {
        core.effects.unknown(start.effect.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    default:
      throw new Error(`synchronous command ${command.type} entered the async dispatcher`);
  }
}

/** Reuse the domain effect journal: pending/unknown writes never run a second time. */
async function journalCommand(core: Core, requestId: string, command: Extract<Command, { type: CommandEffectTool }>, conversationId: string, perform: () => Promise<Outcome>): Promise<Outcome> {
  const result = await core.effects.runCommand({
    conversationId, requestId, tool: command.type,
    input: command, summary: `API ${command.type}`,
  }, async () => `api-result:${JSON.stringify(await perform())}`);
  return recordedCommandOutcome("done", result);
}

function recordedCommandOutcome(state: string, result: string | null): Outcome {
  if (state !== "done" || !result?.startsWith("api-result:")) {
    throw conflict("the command outcome requires owner reconciliation; a reconciled effect is not an API success receipt");
  }
  return JSON.parse(result.slice("api-result:".length)) as Outcome;
}

function runSync(core: Core, access: Access, { command }: CommandRequest, context: CommandContext): Outcome {
  const { ledger } = core;
  switch (command.type) {

    case "conversation.create":
      return { conversationId: core.createDirectConversation(command.ghostId, command.title).id };

    case "conversation.update": {
      const conversation = ledger.conversation(command.conversationId);
      const next = {
        ...conversation,
        title: command.title ?? conversation.title,
        model: command.model === undefined ? conversation.model : command.model,
      };
      ledger.tx(() => ledger.putConversation(next));
      void core.lane(`conversation:${next.id}`, () => core.openConversation(next.id));
      return {};
    }

    case "work.create": {
      const ghost = ledger.ghost(command.ghostId);
      const work = core.works.createRoot({
        ghostId: ghost.id,
        title: command.title,
        brief: projectContext((command.spaceIds ?? []).map(id => ledger.space(id))) + command.brief,
        acceptance: command.acceptance,
        deadlineAt: command.deadlineAt ?? null,
        originConversationId: command.originConversationId ?? ghost.directConversationId,
        execution: command.execution,
      });
      return { workId: work.id };
    }

    case "work.update":
      core.works.update(command.workId, { title: command.title, brief: command.brief, acceptance: command.acceptance, deadlineAt: command.deadlineAt });
      return {};

    case "work.cancel":
      core.works.cancel(command.workId);
      return {};

    case "work.resume":
      core.works.resume(command.workId);
      return {};

    case "message.send":
    case "message.cancel":
    case "decision.resolve":
    case "sandbox.control":
    case "document.save":
    case "avatar.create":
    case "provider.delete":
    case "connection.upsert":
    case "connection.delete":
    case "connection.test":
    case "activity.run":
      throw new Error(`async command ${command.type} entered a ledger transaction`);

    case "ghost.create": {
      const ghost = core.createGhost({
        name: command.name,
        persona: command.persona,
        model: command.model ?? null,
        look: command.look,
        tools: command.tools,
        fallbacks: command.fallbacks,
        skills: command.skills,
        hostExecution: command.hostExecution,
      });
      return { ghostId: ghost.id };
    }

    case "ghost.update":
      updateGhost(core, command.ghostId, {
        name: command.name,
        persona: command.persona,
        model: command.model === undefined ? undefined : command.model,
        look: command.look,
        state: command.state,
        tools: command.tools,
        fallbacks: command.fallbacks,
        skills: command.skills,
        hostExecution: command.hostExecution,
      });
      return {};

    case "ghost.delete":
      deleteGhost(core, command.ghostId);
      return {};

    case "ghost.adapt":
      core.adaptations.set(command.ghostId, command.notes, "owner", "");
      return {};

    case "ghost.set_default": {
      const ghost = ledger.ghost(command.ghostId);
      if (ghost.state !== "active") throw conflict(`${ghost.name} is ${ghost.state}`);
      // The demoted default is captured before the promotion: putGhost itself clears every other default.
      const demoted = ledger.ghosts().filter((other) => other.id !== ghost.id && other.isDefault);
      ledger.tx(() => ledger.putGhost({ ...ghost, isDefault: true, updatedAt: Date.now() }));
      for (const other of demoted) ledger.tx(() => ledger.putGhost({ ...other, isDefault: false }));
      // Both sides re-open at once: the new main gains the management tools, the former main loses them.
      core.refreshGhost(ghost.id);
      for (const other of demoted) core.refreshGhost(other.id);
      return {};
    }


    case "schedule.create":
      return { scheduleId: core.schedules.create(command).id };

    case "schedule.update":
      core.schedules.update(command.scheduleId, command);
      return {};

    case "schedule.delete":
      core.schedules.delete(command.scheduleId);
      return {};

    case "autonomy.set":
      core.autonomy.setEnabled(command.ghostId, command.enabled);
      return {};
    case "duty.switch":
      return { duty: core.duty.switch(command.onDuty) };
    case "duty.hours":
      return { duty: core.duty.setHours(command.hours) };
    case "activity.create":
      return { activityId: core.activities.create(command.config).id };

    case "activity.update":
      core.activities.update(command.activityId, command.expectedRevision, command.config);
      return {};

    case "activity.pause":
      core.activities.pause(command.activityId, command.paused, command.cancelRunning);
      return {};

    case "activity.delete":
      core.activities.delete(command.activityId);
      return {};

    case "activity.stop_all":
      if (command.ghostId !== undefined) ledger.ghost(command.ghostId);
      for (const activity of ledger.activities()) {
        if (activity.deletedAt === null && (command.ghostId === undefined || activity.ghostId === command.ghostId)) core.activities.pause(activity.id, true, true);
      }
      return {};


    case "space.create": {
      if (!isAbsolute(command.path) || !existsSync(command.path) || !statSync(command.path).isDirectory()) throw invalid("the space path must be an existing absolute directory");
      const space: Space = { id: newId(), name: command.name, path: command.path, createdAt: Date.now() };
      ledger.tx(() => ledger.putSpace(space));
      return { spaceId: space.id };
    }

    case "space.update": {
      const space = ledger.space(command.spaceId);
      const next = { ...space, name: command.name ?? space.name };
      ledger.tx(() => ledger.putSpace(next));
      return {};
    }

    case "space.delete": {
      const space = ledger.space(command.spaceId);
      ledger.tx(() => ledger.deleteSpace(space.id));
      return {};
    }


    case "avatar.delete":
      if (ledger.ghosts().some((ghost) => ghost.look.avatarId === command.avatarId)) throw conflict("a Ghost still uses this avatar");
      ledger.tx(() => ledger.deleteAvatar(command.avatarId));
      return {};

    case "settings.update":
      ledger.tx(() => {
        if (command.defaultModel !== undefined) ledger.putSetting("defaultModel", command.defaultModel);
        if (command.reviewModel !== undefined) ledger.putSetting("reviewModel", command.reviewModel);
        if (command.ownerLanguage !== undefined) ledger.putSetting("ownerLanguage", command.ownerLanguage);
        if (command.approvals !== undefined) ledger.putSetting("approvals", command.approvals);
        ledger.emit({ type: "settings", settings: settingsView(core) });
      });
      for (const ghost of ledger.ghosts()) if (ghost.model === null) core.refreshGhost(ghost.id);
      return {};


    case "provider.upsert":
      ledger.putProvider({ id: command.id, kind: command.kind, name: command.name, baseUrl: command.baseUrl ?? null, models: command.models });
      ledger.emit({ type: "settings", settings: settingsView(core) });
      return {};

    case "device.pairing_start": {
      const code = newPairingCode();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      ledger.tx(() => ledger.insertPairing(hashSecret(code), expiresAt));
      return { code, expiresAt, origin: context.publicOrigin };
    }

    case "device.update": {
      const device = ledger.device(command.deviceId);
      ledger.tx(() => ledger.updateDevice({ ...device, name: command.name ?? device.name }));
      return {};
    }

    case "device.revoke":
      ledger.device(command.deviceId);
      ledger.tx(() => ledger.revokeDevice(command.deviceId, Date.now()));
      return {};

    case "device.push_register":
      if (access.principal.kind !== "device") throw invalid("only a paired device registers for push");
      ledger.tx(() => ledger.setPushToken(access.principal.kind === "device" ? access.principal.deviceId : "", command.token, command.environment));
      return {};

    case "device.alerts_update":
      if (access.principal.kind !== "device") throw invalid("only a paired device sets its alerts");
      ledger.tx(() => ledger.setDeviceAlerts(access.principal.kind === "device" ? access.principal.deviceId : "", command.alerts));
      return {};

    case "notification.read": {
      const now = Date.now();
      ledger.tx(() => {
        for (const id of command.notificationIds) {
          const notification = ledger.notification(id);
          if (notification.readAt === null) ledger.putNotification({ ...notification, readAt: now });
        }
      });
      return {};
    }

    case "goal.create": {
      const goal = core.goals.create(command);
      // A new direction is worth the main's next look; the wake path keeps its duty, budget and busy gates.
      ledger.afterCommit(() => core.autonomy.goalsChanged());
      return { goalId: goal.id };
    }

    case "goal.update":
      core.goals.update(command.goalId, { title: command.title, why: command.why, boundaries: command.boundaries, signal: command.signal, state: command.state });
      return {};

    case "milestone.update":
      core.goals.settleByOwner(command.milestoneId, command.state, command.outcome);
      return {};
  }
  const exhaustive: never = command;
  throw new CommandError("invalid", `unknown command ${(exhaustive as Command).type}`);
}


/** One editable aspect of a Ghost; owner-only hostExecution is never passed by model tools. */
export interface GhostPatch {
  name?: string;
  persona?: string;
  model?: ModelRef | null;
  look?: Look;
  state?: GhostState;
  tools?: GhostTool[];
  fallbacks?: ModelRef[];
  skills?: string[];
  hostExecution?: boolean;
}

/**
 * The single Ghost-editing rule set, shared by the owner's `ghost.update` command and the main
 * Ghost's `ghost_update` tool. Re-opens the Ghost's live conversations so tool changes apply at once.
 */
export function updateGhost(core: Core, ghostId: string, patch: GhostPatch): Ghost {
  const ghost = core.ledger.ghost(ghostId);
  if (ghost.deletedAt !== null) throw conflict(`${ghost.name} was deleted`);
  if (patch.state && patch.state !== "active" && ghost.isDefault) throw conflict("choose another default Ghost first");
  if (patch.tools !== undefined && !validate(GhostToolList, patch.tools)) throw invalid("tools must be a duplicate-free list of known tool names");
  if (patch.fallbacks !== undefined && !validate(FallbackList, patch.fallbacks)) throw invalid("fallbacks must be at most 3 models");
  if (patch.skills !== undefined && !validate(SkillList, patch.skills)) throw invalid("skills must be a duplicate-free list of skill names");
  const next: Ghost = {
    ...ghost,
    name: patch.name ?? ghost.name,
    persona: patch.persona ?? ghost.persona,
    model: patch.model === undefined ? ghost.model : patch.model,
    look: patch.look ?? ghost.look,
    state: patch.state ?? ghost.state,
    tools: patch.tools ?? ghost.tools,
    fallbacks: patch.fallbacks ?? ghost.fallbacks,
    skills: patch.skills ?? ghost.skills,
    hostExecution: patch.hostExecution ?? ghost.hostExecution ?? false,
    updatedAt: Date.now(),
  };
  core.ledger.tx(() => {
    core.ledger.putGhost(next);
    // The main conversation is titled after its Ghost until the owner renames it.
    const main = core.ledger.conversation(ghost.directConversationId);
    if (next.name !== ghost.name && main.title === ghost.name) core.ledger.putConversation({ ...main, title: next.name });
  });
  core.refreshGhost(ghost.id);
  return next;
}

const LIVE_WORK_STATES = ["queued", "running", "waiting", "verifying", "blocked"] as const;

/**
 * Remove a retired Ghost from every list. Its row stays as a tombstone (`deletedAt`) so past Works,
 * conversations and effects keep their assignee; its schedules go away.
 */
export function deleteGhost(core: Core, ghostId: string): void {
  const { ledger } = core;
  const ghost = ledger.ghost(ghostId);
  if (ghost.deletedAt !== null) return;
  if (ghost.isDefault) throw conflict("the default Ghost cannot be deleted");
  if (ghost.state !== "retired") throw conflict(`retire ${ghost.name} before deleting it`);
  const live = ledger.worksInState(...LIVE_WORK_STATES);
  if (live.some((work) => work.ghostId === ghost.id)) throw conflict(`${ghost.name} still has live Work`);
  if (live.some((work) => work.acceptance.reviewer?.kind === "ghost" && work.acceptance.reviewer.ghostId === ghost.id)) {
    throw conflict(`${ghost.name} still reviews live Work`);
  }
  if (ledger.pendingDecisions().some((decision) => decision.ghostId === ghost.id)) throw conflict(`${ghost.name} still has pending decisions`);
  const now = Date.now();
  ledger.tx(() => {
    for (const schedule of ledger.schedules()) if (schedule.ghostId === ghost.id) ledger.deleteSchedule(schedule.id);
    ledger.putGhost({ ...ghost, deletedAt: now, updatedAt: now });
  });
  // A retired Ghost can still be answering a direct message; deletion ends that run.
  for (const conversation of ledger.conversations({ ghostId: ghost.id })) if (conversation.busy) ledger.afterCommit(() => { void core.engine.abort(conversation.id); });
}

export function settingsView(core: Core) {
  core.codexCatalog.sync();
  const settings = core.ledger.settings();
  return {
    ...settings,
    providers: settings.providers.map((provider) => {
      const credential = core.secrets.credential(provider.id);
      const catalogIds = new Set(core.catalog.modelsFor({ ...provider, models: [] }, credential?.type).map(model => model.id));
      return {
        ...provider,
        configuredModels: provider.models,
        manualModelIds: provider.models.filter(model => !catalogIds.has(model.id)).map(model => model.id),
        automaticModels: supportsAutomaticModels(provider),
        models: core.catalog.modelsFor(provider, credential?.type),
        hasCredential: credential !== undefined,
        // api_key or oauth while a valid credential exists; the field disappears with it.
        ...(credential === undefined ? {} : { authType: credential.type }),
      };
    }),
  };
}
