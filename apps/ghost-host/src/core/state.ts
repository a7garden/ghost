import type { State, WorkDetail } from "@ghost/contract";
import type { Access } from "./access.ts";
import { settingsView } from "./commands.ts";
import type { Core } from "./core.ts";
import { notFound } from "./errors.ts";

export const HOST_VERSION = "2.0.0";

/** The snapshot a client starts from; filtered by what the principal may see. */
export function snapshot(core: Core, access: Access): State {
  const { ledger } = core;
  const seq = ledger.seq();
  const engine = core.engine.status();
  const ghosts = ledger.ghosts().filter((ghost) => access.canSeeGhost(ghost.id));
  const works = ledger.worksForState().filter((work) => access.canSeeWork(work));
  const settings = settingsView(core);
  return {
    seq,
    principal: access.principal,
    runtime: { ready: engine.ready, detail: engine.detail, version: HOST_VERSION },
    ghosts,
    conversations: ledger.conversations().filter((conversation) => conversation.kind === "direct" || conversation.workId !== null).filter((conversation) => access.canSeeConversation(conversation)),
    works,
    decisions: ledger.decisionsForState().filter((decision) => access.canSeeDecision(decision)),
    notifications: ledger.notificationsForState().filter((notification) => access.isOwner || (notification.ghostId !== null && access.canSeeGhost(notification.ghostId))),
    schedules: access.isOwner ? ledger.schedules() : [],
    spaces: access.isOwner ? ledger.spaces() : [],
    avatars: ledger.avatars(),
    settings: access.isOwner ? settings : { defaultModel: settings.defaultModel, reviewModel: null, providers: [] },
    devices: access.isOwner ? ledger.devices() : ledger.devices().filter((device) => access.principal.kind === "device" && device.id === access.principal.deviceId),
    sandboxes: access.isOwner ? ghosts.map((ghost) => core.sandbox.status(ghost.id)) : [],
  };
}

export function workDetail(core: Core, access: Access, workId: string): WorkDetail {
  const { ledger } = core;
  const work = ledger.work(workId);
  if (!access.canSeeWork(work)) throw notFound(`work ${workId}`);
  const ancestors = [];
  let current = work;
  while (current.parentId) {
    current = ledger.work(current.parentId);
    ancestors.unshift(current);
  }
  return {
    work,
    ancestors,
    children: ledger.children(work.id),
    effects: ledger.effectsForWork(work.id),
    decisions: ledger.decisionsForWork(work.id),
    artifacts: ledger.artifactsForWork(work.id),
  };
}
