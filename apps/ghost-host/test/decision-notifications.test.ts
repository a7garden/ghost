import { expect, test } from "bun:test";
import type { Decision } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

// 답을 기다리는 동안 화면은 질문 알림을 카드로 대신 보인다. 처리한 뒤 그 알림이 「새 소식」으로 되살아나면 안 된다.
test("resolving a decision marks its notifications read and leaves other notifications alone", () => {
  const ledger = new Ledger(":memory:");
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets: new MemorySecrets(), log: () => {} });
  core.attach(new FakeEngine());
  try {
    const ghost = core.createGhost({ name: "Main", persona: "Lead", model: { provider: "test", model: "test-model" }, isDefault: true });
    const decision = {
      id: "d1", kind: "question", ghostId: ghost.id, conversationId: ghost.directConversationId, workId: null, effectId: null,
      title: "Which one?", detail: "", options: [], proposal: null, state: "pending", answer: null,
      createdAt: 1, resolvedAt: null,
    } as unknown as Decision;
    const notification = (id: string, decisionId: string | null) => ({
      id, kind: "decision", ghostId: ghost.id, conversationId: null, workId: null, decisionId,
      title: "t", body: "b", createdAt: 1, readAt: null,
    }) as Parameters<Ledger["putNotification"]>[0];
    ledger.tx(() => {
      ledger.putDecision(decision);
      ledger.putNotification(notification("n1", "d1"));
      ledger.putNotification(notification("n2", null));
    });
    expect(ledger.notification("n1").readAt).toBeNull();

    ledger.tx(() => ledger.putDecision({ ...decision, state: "answered", answer: "A", resolvedAt: 5 } as Decision));
    expect(ledger.notification("n1").readAt).toBe(5);
    expect(ledger.notification("n2").readAt).toBeNull();
  } finally { core.stop(); ledger.close(); }
});
