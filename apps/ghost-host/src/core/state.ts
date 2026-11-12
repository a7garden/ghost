import type { State, WorkDetail } from "@ghost/contract";
import type { Access } from "./access.ts";
import { settingsView } from "./commands.ts";
import type { Core } from "./core.ts";

export { HOST_VERSION } from "../update/identity.ts";
import { HOST_VERSION } from "../update/identity.ts";

/** The snapshot every authenticated principal starts from; a device sees exactly what the owner sees. */
export function snapshot(core: Core, access: Access): State {
  const { ledger } = core;
  const seq = ledger.seq();
  const engine = core.engine.status();
  const ghosts = ledger.ghosts();
  return {
    seq,
    principal: access.principal,
    runtime: { ready: engine.ready, detail: engine.detail, version: HOST_VERSION },
    ghosts,
    conversations: ledger.conversations(),
    works: ledger.worksForState(),
    decisions: ledger.decisionsForState(),
    notifications: ledger.notificationsForState(),
    schedules: ledger.schedules(),
    scopes: ledger.scopes(),
    policyRules: ledger.policyRules(),
    mcpServers: ledger.mcpServers(),
    configRevisions: ledger.configRevisions(),
    avatars: ledger.avatars(),
    settings: settingsView(core),
    devices: ledger.devices(),
    sandboxes: ghosts.map((ghost) => core.sandbox.status(ghost.id)),
    activities: ledger.activities(),
    activityRuns: ledger.activityRuns(),
    connections: ledger.connections().map((connection) => ({ ...connection, hasCredential: core.activitySources?.credentialPresent(connection.id) ?? false })),
    autonomy: core.autonomy.view(),
    adaptations: core.adaptations.view(),
    duty: core.duty.view(),
    goals: core.goals.goals(),
    milestones: core.goals.milestones(),
  };
}

export function workDetail(core: Core, workId: string): WorkDetail {
  const { ledger } = core;
  const work = ledger.work(workId);
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
