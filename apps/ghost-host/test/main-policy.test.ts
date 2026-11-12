import { afterEach, expect, test } from "bun:test";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { createMainTools } from "../src/tools/main.ts";
import { harness } from "./support.ts";

const opened: { core: Core; ledger: Ledger }[] = [];
afterEach(async () => { for (const h of opened.splice(0)) { h.core.stop(); await h.core.idle(); h.ledger.close(); } });
function setup() {
  const h = harness();
  opened.push(h);
  const main = h.core.createGhost({ name: "Main", persona: "Lead" });
  const target = h.core.createGhost({ name: "Worker", persona: "Work", tools: ["web_read"] });
  h.ledger.setPiConversationId(main.directConversationId, "main-policy-pi");
  const extension = createMainTools(h.core);
  const invoke = (name: string, args: unknown, callId: string) => {
    const tool = extension.tools!.find((entry) => entry.name === name)!;
    return tool.execute(args as never, { conversationId: "main-policy-pi", taskId: `task:${callId}`, callId: callId, output: () => {}, diagnostic: () => {} } as unknown as ToolExecutionApi, {} as Context);
  };
  return { ...h, main, target, invoke };
}

test("new Ghost authority waits for the owner, never timeout, and records a revision", async () => {
  const h = setup();
  const response = await h.invoke("ghost_create", { name: "Mac worker", persona: "Maintain the Mac", reason: "Maintain owner-approved files", tools: ["host_read"], host_execution: true }, "create");
  expect(response.isError).toBeFalsy();
  expect(h.ledger.ghosts().some((ghost) => ghost.name === "Mac worker")).toBe(false);
  const decision = h.ledger.pendingDecisions()[0]!;
  expect(decision.proposal?.forceOwner).toBe(true);
  await h.core.decisions.settleExpired(decision.createdAt + 86_400_000);
  expect(h.ledger.decision(decision.id).state).toBe("pending");
  await h.core.decisions.resolve(decision.id, { outcome: "approve" });
  const created = h.ledger.ghosts().find((ghost) => ghost.name === "Mac worker")!;
  expect(created.hostExecution).toBe(true);
  expect(created.tools).toContain("host_read");
  expect(h.ledger.configRevisions("ghost", created.id).some((revision) => revision.actor.kind === "ghost" && revision.actor.id === h.main.id)).toBe(true);
});

test("main cannot grant host access through a notification-only update", async () => {
  const h = setup();
  await h.invoke("ghost_update", { ghost_id: h.target.id, host_execution: true, tools: ["web_read", "host_read"] }, "grant");
  expect(h.ledger.ghost(h.target.id).hostExecution).toBe(false);
  expect(h.ledger.ghost(h.target.id).tools).toEqual(["web_read"]);
  const decision = h.ledger.pendingDecisions()[0]!;
  await h.core.decisions.resolve(decision.id, { outcome: "approve" });
  expect(h.ledger.ghost(h.target.id).hostExecution).toBe(true);
  expect(h.ledger.ghost(h.target.id).tools).toContain("host_read");
});

test("authority changes while an owner decision waits invalidate the exact configuration proposal", async () => {
  const h = setup();
  await h.invoke("ghost_update", { ghost_id: h.target.id, host_execution: true }, "stale-grant");
  const decision = h.ledger.pendingDecisions()[0]!;
  h.ledger.tx(() => h.ledger.putGhost({ ...h.ledger.ghost(h.target.id), persona: "Owner changed the role", updatedAt: Date.now() }));
  await h.core.decisions.resolve(decision.id, { outcome: "approve" });
  expect(h.ledger.ghost(h.target.id).hostExecution).toBe(false);
  expect(h.ledger.effect(decision.effectId!).state).toBe("denied");
});

test("a tightening edit is transactional, audited and replayed without another revision", async () => {
  const h = setup();
  const args = { ghost_id: h.target.id, tools: [] };
  const first = await h.invoke("ghost_update", args, "tighten");
  expect(first.isError).toBeFalsy();
  expect(h.ledger.ghost(h.target.id).tools).toEqual([]);
  const revisions = h.ledger.configRevisions("ghost", h.target.id).length;
  const replay = await h.invoke("ghost_update", args, "tighten");
  expect(replay).toEqual(first);
  expect(h.ledger.configRevisions("ghost", h.target.id)).toHaveLength(revisions);
});
