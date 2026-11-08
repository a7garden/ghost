import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { FallbackList, GhostToolList, SkillList, validate, type Command, type CommandRequest, type Ghost, type GhostState, type GhostTool, type Look, type ModelRef, type Space } from "@ghost/contract";
import type { Access } from "./access.ts";
import type { Core } from "./core.ts";
import type { DocumentsPort } from "../integrations/ports.ts";
import { CommandError, conflict, invalid } from "./errors.ts";
import { digestOf, newId, sha256 } from "./ids.ts";

export interface CommandContext {
  /** Origin a paired device should use, e.g. https://ghost.example.ts.net */
  publicOrigin: string;
  /** PDC vault access; null when the host runs without document support. */
  documents: DocumentsPort | null;
}

/** Pairing codes: 8 Crockford base32 characters, valid for 10 minutes. */
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_TTL_MS = 10 * 60 * 1000;

export const hashSecret = (secret: string) => sha256(`ghost-secret/1\0${secret}`);

export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => PAIRING_ALPHABET[byte % 32]).join("");
}

/** Requests running right now, so a concurrent retry joins the first run instead of starting another. */
const inFlight = new Map<string, { principal: string; digest: string; outcome: Promise<Record<string, unknown>> }>();

/**
 * Execute one client command. A repeated request id with the same bytes returns the
 * recorded (or in-flight) outcome without running again; with different bytes it conflicts.
 * The receipt is written after the command's own ledger writes, so a host crash in that
 * instant leaves the effect without a receipt and a retry runs the command again.
 */
export async function execute(core: Core, access: Access, request: CommandRequest, context: CommandContext): Promise<Record<string, unknown>> {
  const principal = access.principal.kind === "owner" ? "owner" : `device:${access.principal.deviceId}`;
  const digest = digestOf(request.command);
  const previous = core.ledger.request(request.requestId) ?? inFlight.get(request.requestId);
  if (previous) {
    if (previous.principal !== principal || previous.digest !== digest) throw conflict("request id reused with a different command");
    return previous.outcome;
  }
  access.authorize(request.command);
  const outcome = run(core, access, request, context);
  inFlight.set(request.requestId, { principal, digest, outcome });
  try {
    const result = await outcome;
    core.ledger.putRequest(request.requestId, principal, digest, result);
    return result;
  } finally {
    inFlight.delete(request.requestId);
  }
}

async function run(core: Core, access: Access, { requestId, command }: CommandRequest, context: CommandContext): Promise<Record<string, unknown>> {
  const { ledger } = core;
  switch (command.type) {
    case "message.send":
      await core.sendMessage(command.conversationId, command.text, requestId, command.attachments ?? []);
      return {};

    case "message.cancel":
      ledger.conversation(command.conversationId);
      await core.engine.abort(command.conversationId);
      return {};

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
        brief: command.brief,
        acceptance: command.acceptance,
        deadlineAt: command.deadlineAt ?? null,
        originConversationId: command.originConversationId ?? ghost.directConversationId,
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

    case "decision.resolve":
      await core.decisions.resolve(command.decisionId, { outcome: command.outcome, answer: command.answer });
      return {};

    case "ghost.create": {
      const ghost = core.createGhost({
        name: command.name,
        persona: command.persona,
        model: command.model ?? null,
        look: command.look,
        tools: command.tools,
        fallbacks: command.fallbacks,
        skills: command.skills,
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
      });
      return {};

    case "ghost.delete":
      deleteGhost(core, command.ghostId);
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

    case "sandbox.control":
      ledger.ghost(command.ghostId);
      await core.sandbox.control(command.ghostId, command.action);
      ledger.tx(() => ledger.emit({ type: "sandbox", sandbox: core.sandbox.status(command.ghostId) }));
      return {};

    case "schedule.create":
      return { scheduleId: core.schedules.create(command).id };

    case "schedule.update":
      core.schedules.update(command.scheduleId, command);
      return {};

    case "schedule.delete":
      core.schedules.delete(command.scheduleId);
      return {};

    case "space.create": {
      if (!isAbsolute(command.path) || !existsSync(command.path) || !statSync(command.path).isDirectory()) throw invalid("the space path must be an existing absolute directory");
      for (const grant of command.grants ?? []) ledger.ghost(grant.ghostId);
      const space: Space = { id: newId(), name: command.name, path: command.path, grants: command.grants ?? [], createdAt: Date.now() };
      ledger.tx(() => ledger.putSpace(space));
      refreshGrantees(core, space.grants);
      return { spaceId: space.id };
    }

    case "space.update": {
      const space = ledger.space(command.spaceId);
      for (const grant of command.grants ?? []) ledger.ghost(grant.ghostId);
      const next = { ...space, name: command.name ?? space.name, grants: command.grants ?? space.grants };
      ledger.tx(() => ledger.putSpace(next));
      refreshGrantees(core, [...space.grants, ...next.grants]);
      return {};
    }

    case "space.delete": {
      const space = ledger.space(command.spaceId);
      ledger.tx(() => ledger.deleteSpace(space.id));
      refreshGrantees(core, space.grants);
      return {};
    }

    case "document.save": {
      if (!context.documents) throw new CommandError("unavailable", "document spaces are not available");
      ledger.space(command.spaceId);
      const page = await context.documents.save({
        spaceId: command.spaceId,
        title: command.title,
        body: command.body,
        profile: command.profile ?? "pdc-markdown/1",
        pageId: command.pageId,
        expectedHash: command.expectedHash,
      });
      return { pageId: page.pageId, hash: page.hash };
    }

    case "avatar.create": {
      const [header, base64] = command.image.split(",", 2) as [string, string];
      const mediaType = header.slice("data:".length, header.indexOf(";"));
      const ref = await core.artifacts.put(Buffer.from(base64, "base64"), `${command.name}.${mediaType.split("/")[1]}`, mediaType);
      const avatar = { id: newId(), name: command.name, description: command.description, imageDigest: ref.digest, design: command.design ?? null, createdAt: Date.now() };
      ledger.tx(() => {
        ledger.addArtifact(null, ref);
        ledger.putAvatar(avatar);
      });
      return { avatarId: avatar.id };
    }

    case "avatar.delete":
      if (ledger.ghosts().some((ghost) => ghost.look.avatarId === command.avatarId)) throw conflict("a Ghost still uses this avatar");
      ledger.tx(() => ledger.deleteAvatar(command.avatarId));
      return {};

    case "settings.update":
      ledger.tx(() => {
        if (command.defaultModel !== undefined) ledger.putSetting("defaultModel", command.defaultModel);
        if (command.reviewModel !== undefined) ledger.putSetting("reviewModel", command.reviewModel);
        ledger.emit({ type: "settings", settings: settingsView(core) });
      });
      for (const ghost of ledger.ghosts()) if (ghost.model === null) core.refreshGhost(ghost.id);
      return {};

    case "provider.upsert":
      if (command.apiKey !== undefined) core.secrets.put(command.id, command.apiKey);
      ledger.tx(() => {
        ledger.putProvider({ id: command.id, kind: command.kind, name: command.name, baseUrl: command.baseUrl ?? null, models: command.models });
        ledger.emit({ type: "settings", settings: settingsView(core) });
      });
      return {};

    case "provider.delete":
      core.secrets.put(command.providerId, null);
      ledger.tx(() => {
        ledger.deleteProvider(command.providerId);
        ledger.emit({ type: "settings", settings: settingsView(core) });
      });
      return {};

    case "device.pairing_start": {
      for (const grant of command.grants) ledger.ghost(grant.ghostId);
      const code = newPairingCode();
      const expiresAt = Date.now() + PAIRING_TTL_MS;
      ledger.tx(() => ledger.insertPairing(hashSecret(code), command.name, command.grants, expiresAt));
      return { code, expiresAt, origin: context.publicOrigin };
    }

    case "device.update": {
      const device = ledger.device(command.deviceId);
      for (const grant of command.grants ?? []) ledger.ghost(grant.ghostId);
      ledger.tx(() => ledger.updateDevice({ ...device, name: command.name ?? device.name, grants: command.grants ?? device.grants }));
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
  }
  const exhaustive: never = command;
  throw new CommandError("invalid", `unknown command ${(exhaustive as Command).type}`);
}

function refreshGrantees(core: Core, grants: { ghostId: string }[]) {
  for (const ghostId of new Set(grants.map((grant) => grant.ghostId))) core.refreshGhost(ghostId);
}

/** One editable aspect of a Ghost; `undefined` leaves it unchanged. Never isDefault, grants or credentials. */
export interface GhostPatch {
  name?: string;
  persona?: string;
  model?: ModelRef | null;
  look?: Look;
  state?: GhostState;
  tools?: GhostTool[];
  fallbacks?: ModelRef[];
  skills?: string[];
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
 * conversations and effects keep their assignee; its schedules and every grant naming it go away.
 */
export function deleteGhost(core: Core, ghostId: string): void {
  const { ledger } = core;
  const ghost = ledger.ghost(ghostId);
  if (ghost.deletedAt !== null) return;
  if (ghost.isDefault) throw conflict("the default Ghost cannot be deleted");
  if (ghost.state !== "retired") throw conflict(`retire ${ghost.name} before deleting it`);
  if (ledger.worksInState(...LIVE_WORK_STATES).some((work) => work.ghostId === ghost.id)) throw conflict(`${ghost.name} still has live Work`);
  if (ledger.pendingDecisions().some((decision) => decision.ghostId === ghost.id)) throw conflict(`${ghost.name} still has pending decisions`);
  const now = Date.now();
  ledger.tx(() => {
    for (const schedule of ledger.schedules()) if (schedule.ghostId === ghost.id) ledger.deleteSchedule(schedule.id);
    for (const device of ledger.devices()) {
      const grants = device.grants.filter((grant) => grant.ghostId !== ghost.id);
      if (grants.length !== device.grants.length) ledger.updateDevice({ ...device, grants });
    }
    for (const space of ledger.spaces()) {
      const grants = space.grants.filter((grant) => grant.ghostId !== ghost.id);
      if (grants.length !== space.grants.length) ledger.putSpace({ ...space, grants });
    }
    ledger.putGhost({ ...ghost, deletedAt: now, updatedAt: now });
  });
}

export function settingsView(core: Core) {
  const settings = core.ledger.settings();
  return {
    ...settings,
    providers: settings.providers.map((provider) => {
      const credential = core.secrets.credential(provider.id);
      return {
        ...provider,
        hasCredential: credential !== undefined,
        // api_key or oauth while a valid credential exists; the field disappears with it.
        ...(credential === undefined ? {} : { authType: credential.type }),
      };
    }),
  };
}
