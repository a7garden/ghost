import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { DeviceGrant, Notification } from "@ghost/contract";
import { notificationReceivers } from "../src/api/push.ts";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { Access } from "../src/core/access.ts";
import { execute, hashSecret } from "../src/core/commands.ts";
import { snapshot } from "../src/core/state.ts";
import { harness, tempDir } from "./support.ts";

async function fixture() {
  const h = harness();
  const ghost = h.core.createGhost({ name: "Mail", persona: "" });
  const helper = h.core.createGhost({ name: "Research", persona: "" });
  const first = h.ledger.conversation(ghost.directConversationId);
  const second = h.core.createDirectConversation(ghost.id, "Other mail conversation");
  const firstRoot = h.core.works.createRoot({ ghostId: ghost.id, title: "First mail result", brief: "Review mail", originConversationId: first.id });
  const secondRoot = h.core.works.createRoot({ ghostId: ghost.id, title: "Other mail result", brief: "Review other mail", originConversationId: second.id });
  await h.core.idle();
  const firstChild = h.core.works.delegate(firstRoot.id, { ghostId: helper.id, title: "First research", brief: "Research first mail" });
  const secondChild = h.core.works.delegate(secondRoot.id, { ghostId: helper.id, title: "Other research", brief: "Research other mail" });
  await h.core.idle();

  const notice = (scope: Pick<Notification, "ghostId" | "conversationId" | "workId">) => {
    const id = crypto.randomUUID();
    h.ledger.tx(() => h.core.notify({ id, kind: scope.workId ? "work_done" : "message", ...scope, decisionId: null, title: "Private result", body: "Sensitive mail or research content" }));
    return h.ledger.notification(id);
  };
  const noticesFor = (directId: string, rootId: string, childId: string) => {
    const root = h.ledger.work(rootId);
    const child = h.ledger.work(childId);
    const directDecision = h.core.decisions.ask(directId, "Mail question", "Private mail question", []);
    const rootDecision = h.core.decisions.ask(root.conversationId!, "Root question", "Private root question", []);
    const childDecision = h.core.decisions.ask(child.conversationId!, "Research question", "Private research question", []);
    return [
      notice({ ghostId: ghost.id, conversationId: directId, workId: null }),
      notice({ ghostId: ghost.id, conversationId: directId, workId: rootId }),
      notice({ ghostId: helper.id, conversationId: child.conversationId, workId: childId }),
      // Conversation-only notifications from Work/review conversations still inherit the root.
      notice({ ghostId: ghost.id, conversationId: root.conversationId, workId: null }),
      notice({ ghostId: helper.id, conversationId: child.conversationId, workId: null }),
      h.ledger.notification(`decision:${directDecision.id}`),
      h.ledger.notification(`decision:${rootDecision.id}`),
      h.ledger.notification(`decision:${childDecision.id}`),
    ];
  };
  const firstNotices = noticesFor(first.id, firstRoot.id, firstChild.id);
  const secondNotices = noticesFor(second.id, secondRoot.id, secondChild.id);
  const workTakesPrecedence = notice({ ghostId: ghost.id, conversationId: first.id, workId: secondRoot.id });
  const ghostOnly = notice({ ghostId: ghost.id, conversationId: null, workId: null });
  const helperOnly = notice({ ghostId: helper.id, conversationId: null, workId: null });
  const unscoped = notice({ ghostId: null, conversationId: null, workId: null });
  const missingWork = notice({ ghostId: ghost.id, conversationId: first.id, workId: crypto.randomUUID() });
  const missingConversation = notice({ ghostId: ghost.id, conversationId: crypto.randomUUID(), workId: null });
  const device = (id: string, grants: DeviceGrant[]) => {
    h.ledger.tx(() => {
      h.ledger.insertDevice({ id, name: id, grants, pushEnabled: true, createdAt: Date.now(), lastSeenAt: null }, hashSecret(id));
      h.ledger.setPushToken(id, id.charCodeAt(0).toString(16).repeat(32), "sandbox");
    });
    return new Access(h.ledger, { kind: "device", deviceId: id, name: id, grants });
  };
  const firstDevice = device("first", [{ ghostId: ghost.id, conversationId: first.id }]);
  const secondDevice = device("second", [{ ghostId: ghost.id, conversationId: second.id }]);
  const allDevice = device("all", [{ ghostId: ghost.id, conversationId: null }]);
  const helperDevice = device("helper", [{ ghostId: helper.id, conversationId: null }]);
  const emptyDevice = device("empty", []);
  const owner = new Access(h.ledger, { kind: "owner" });
  return {
    ...h, firstDevice, secondDevice, allDevice, helperDevice, emptyDevice, owner,
    firstNotices, secondNotices, workTakesPrecedence, ghostOnly, helperOnly, unscoped, missingWork, missingConversation,
    async close() {
      await h.core.idle();
      h.core.stop();
      h.ledger.close();
    },
  };
}

const ids = (notifications: Notification[]) => notifications.map((item) => item.id).sort();

describe("notification conversation grants", () => {
  test("visibility and snapshot use the source conversation, root Work and delegated child scope", async () => {
    const f = await fixture();
    try {
      const all = f.ledger.notificationsForState();
      const firstVisible = [...f.firstNotices, f.ghostOnly];
      const secondVisible = [...f.secondNotices, f.workTakesPrecedence, f.ghostOnly];
      const allVisible = [...f.firstNotices, ...secondVisible];
      for (const [access, expected] of [
        [f.firstDevice, firstVisible], [f.secondDevice, secondVisible], [f.allDevice, allVisible],
        [f.helperDevice, [f.helperOnly]], [f.emptyDevice, []], [f.owner, all],
      ] as const) {
        expect(ids(all.filter((notification) => access.canSeeNotification(notification)))).toEqual(ids([...expected]));
        expect(ids(snapshot(f.core, access).notifications)).toEqual(ids([...expected]));
      }
    } finally {
      await f.close();
    }
  });

  test("notification.read rejects hidden messages, root/child Work and decisions without partially reading", async () => {
    const f = await fixture();
    const read = (access: Access, notificationIds: string[]) => execute(f.core, access, {
      requestId: crypto.randomUUID(), command: { type: "notification.read", notificationIds },
    }, { publicOrigin: "http://localhost", documents: null });
    try {
      for (const notification of [
        ...f.secondNotices, f.workTakesPrecedence, f.helperOnly, f.unscoped, f.missingWork, f.missingConversation,
      ]) {
        await expect(read(f.firstDevice, [f.firstNotices[0]!.id, notification.id])).rejects.toThrow("grants");
        expect(f.ledger.notification(notification.id).readAt).toBeNull();
        expect(f.ledger.notification(f.firstNotices[0]!.id).readAt).toBeNull();
      }
      await read(f.firstDevice, ids([...f.firstNotices, f.ghostOnly]));
      for (const notification of [...f.firstNotices, f.ghostOnly]) expect(f.ledger.notification(notification.id).readAt).not.toBeNull();
      await read(f.secondDevice, ids(f.secondNotices));
      await read(f.allDevice, [f.workTakesPrecedence.id]);
      await read(f.owner, [f.unscoped.id, f.missingWork.id, f.missingConversation.id]);
      expect(f.ledger.notification(f.unscoped.id).readAt).not.toBeNull();
    } finally {
      await f.close();
    }
  });

  test("APNs receiver selection matches notification access, including Work and decision notifications", async () => {
    const f = await fixture();
    try {
      const targets = f.ledger.pushTargets();
      const receivers = (notification: Notification) => notificationReceivers(f.ledger, notification, targets).map((target) => target.deviceId).sort();
      for (const notification of f.firstNotices) expect(receivers(notification)).toEqual(["all", "first"]);
      for (const notification of [...f.secondNotices, f.workTakesPrecedence]) expect(receivers(notification)).toEqual(["all", "second"]);
      expect(receivers(f.ghostOnly)).toEqual(["all", "first", "second"]);
      expect(receivers(f.helperOnly)).toEqual(["helper"]);
      for (const notification of [f.unscoped, f.missingWork, f.missingConversation]) expect(receivers(notification)).toEqual([]);
      // Receiver selection does not consume attempts or mutate delivery bookkeeping.
      expect(ids(f.ledger.unpushedNotifications())).toEqual(ids(f.ledger.notificationsForState()));
    } finally {
      await f.close();
    }
  });

  test("SSE replay and live delivery omit another conversation's messages, Work and decisions", async () => {
    const f = await fixture();
    const root = tempDir();
    const config: Config = {
      root, host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1", uiDir: null,
      sandbox: { kind: "local" }, memory: null, voice: null, apns: null, skills: null, reach: null,
    };
    const server = startServer({ core: f.core, config, ownerToken: "owner", documents: null, skills: null });
    try {
      for (const mode of ["replay", "live"]) {
        const after = f.ledger.seq();
        const visible = [...f.firstNotices, f.ghostOnly].map((notification) => ({ ...notification, id: crypto.randomUUID() }));
        const hidden = [...f.secondNotices, f.workTakesPrecedence, f.helperOnly, f.unscoped].map((notification) => ({ ...notification, id: crypto.randomUUID() }));
        const marker = { ...f.firstNotices[0]!, id: crypto.randomUUID() };
        const emit = () => f.ledger.tx(() => {
          for (const notification of [...visible, ...hidden, marker]) f.ledger.putNotification(notification);
        });
        if (mode === "replay") emit();
        const response = await fetch(`http://127.0.0.1:${server.port}/api/events?after=${after}`, {
          headers: { authorization: "Bearer first", accept: "text/event-stream" },
          signal: AbortSignal.timeout(5_000),
        });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        try {
          if (mode === "live") emit();
          let text = "";
          const decoder = new TextDecoder();
          while (!text.includes(marker.id)) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error("SSE closed before the visible notification");
            text += decoder.decode(chunk.value, { stream: true });
          }
          for (const notification of [...visible, marker]) expect(text).toContain(notification.id);
          for (const notification of hidden) expect(text).not.toContain(notification.id);
        } finally {
          await reader.cancel();
        }
      }
    } finally {
      await server.stop();
      await f.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
