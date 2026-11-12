import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ModelRef } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { createEngine } from "../src/engine/index.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { createToolSet } from "../src/tools/index.ts";
import { MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

const primary: ModelRef = { provider: "primary", model: "primary-1" };

/** A Core that keeps the real activity handling while letting a test await each run's end. */
class WatchingCore extends Core {
  private readonly ended = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  count(id: string) {
    return this.ended.get(id) ?? 0;
  }
  settled(id: string, after = this.count(id)): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => {
      if (this.count(id) <= after) return;
      this.listeners.delete(check);
      resolve();
    };
    this.listeners.add(check);
    check();
    return promise;
  }
  override activity(id: string, busy: boolean, at: number, ended?: { quota: boolean }) {
    super.activity(id, busy, at, ended);
    if (!busy) {
      this.ended.set(id, this.count(id) + 1);
      for (const listener of this.listeners) listener();
    }
  }
}

/** One provider, no fallbacks and the real Work tools: a single 429 exhausts the whole chain. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ghost-quota-"));
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new WatchingCore({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: () => {} });
  const models = createModels();
  const faux = fauxProvider({ provider: primary.provider, models: [{ id: primary.model, name: primary.model }] });
  models.setProvider(faux.provider);
  ledger.tx(() => {
    ledger.putProvider({ id: primary.provider, kind: "openai_compatible", name: primary.provider, baseUrl: null, models: [{ id: primary.model, name: primary.model }] });
    ledger.putSetting("defaultModel", primary);
  });
  secrets.put(primary.provider, "test-key");
  const sandbox = {
    envFor: async () => new NodeExecutionEnv({ cwd: join(root, "workspace") }),
    workspacePath: () => join(root, "workspace"),
    stageInputs: async () => {},
    release: async () => {},
  };
  const tools = createToolSet({ core, sandbox, memory: null, documents: null, skills: null });
  const engine = await createEngine({
    core,
    storagePath: join(root, "pi.db"),
    models,
    sandbox,
    tools,
    harnessSettings: { retry: { maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } },
    log: () => {},
  });
  core.attach(engine);
  const ghost = core.createGhost({ name: "Quota Ghost", persona: "Be brief.", fallbacks: [] });
  await core.idle();
  return {
    core, engine, ledger, faux, ghost,
    async close() {
      core.stop();
      await core.idle();
      await engine.close();
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The provider-shaped reset line: an absolute time in the provider's UTC+8. */
function resetLine(at: number): string {
  const shifted = new Date(at + 8 * 3600_000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${two(shifted.getUTCMonth() + 1)}-${two(shifted.getUTCDate())}T${two(shifted.getUTCHours())}:${two(shifted.getUTCMinutes())}:${two(shifted.getUTCSeconds())}+08:00`;
}

interface QuotaSetting {
  entries?: Record<string, { reason: string; resumeAt: number; failures: number }>;
  records?: { conversationId: string; attempts: number; queue: { requestId: string }[]; releasing: string | null }[];
}

describe("provider quota (R1)", () => {
  test("a Work turn that dies on a 429 is held, not nudged or failed, and resumes after the reset time", async () => {
    const f = await fixture();
    try {
      // The reset line carries whole seconds, so the expected resume time is second-aligned too.
      const resumeAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
      const quotaError = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: `429 Token Plan usage limit reached. Your plan resets at ${resetLine(resumeAt)}.` });
      f.faux.setResponses([
        quotaError(),
        quotaError(),
        fauxAssistantMessage(fauxToolCall("complete", { summary: "Finished after the quota recovered.", artifacts: [] }), { stopReason: "toolUse" }),
      ]);
      const work = f.core.works.createRoot({ ghostId: f.ghost.id, title: "T", brief: "Do it.", originConversationId: f.ghost.directConversationId });
      await f.core.idle();
      const conversationId = f.ledger.work(work.id).conversationId!;
      await f.core.settled(conversationId);

      const held = f.ledger.work(work.id);
      expect(held.state).toBe("running");
      expect(held.hold).toBe("quota");
      expect(f.ledger.idleNudges(work.id)).toBe(0);
      const stored = f.ledger.setting<QuotaSetting>("quota", {});
      expect(stored.entries![primary.provider]!.resumeAt).toBe(resumeAt);
      expect(stored.records![0]!.queue[0]!.requestId).toBe(`quota-resume:${conversationId}:1`);

      // A new input while the chain is exhausted is held, not admitted.
      await f.engine.submit(conversationId, { text: "status?", origin: "work", requestId: "held:1" });
      expect((await f.engine.page(conversationId, null, 50)).messages.filter((message) => message.role === "user")).toHaveLength(1);

      // The owner's status line: which provider, and when it resumes.
      expect(f.core.quota.waiting()).toEqual([{ provider: primary.provider, reason: expect.stringContaining("usage limit"), resumeAt, conversations: 1 }]);

      // Before the reset time nothing is released.
      f.core.quota.tick(resumeAt - 1);
      await f.core.idle();
      expect((await f.engine.page(conversationId, null, 50)).messages.filter((message) => message.role === "user")).toHaveLength(1);

      f.core.quota.tick(resumeAt + 1);
      await f.core.settled(conversationId, 1);
      await f.core.idle();

      const page = await f.engine.page(conversationId, null, 50);
      const users = page.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(2);
      expect(users.at(-1)!.text).toContain("continue exactly where you stopped");
      const after = f.ledger.work(work.id);
      expect(after.state).toBe("verifying");
      expect(after.hold).toBeNull();
      expect(f.core.quota.waiting()).toEqual([]);
      expect(f.ledger.setting<QuotaSetting>("quota", {}).records ?? []).toEqual([]);
    } finally {
      await f.close();
    }
  });

  test("a rate limit without a reset time probes on a growing backoff and still resumes", async () => {
    const f = await fixture();
    try {
      f.faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Rate limit reached: Limit 400, Used 400" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Rate limit reached: Limit 400, Used 400" }),
        fauxAssistantMessage(fauxToolCall("complete", { summary: "Done on the probe.", artifacts: [] }), { stopReason: "toolUse" }),
      ]);
      const work = f.core.works.createRoot({ ghostId: f.ghost.id, title: "T", brief: "B", originConversationId: f.ghost.directConversationId });
      await f.core.idle();
      const conversationId = f.ledger.work(work.id).conversationId!;
      await f.core.settled(conversationId);

      const entry = f.ledger.setting<QuotaSetting>("quota", {}).entries![primary.provider]!;
      expect(entry.failures).toBe(1);
      expect(entry.resumeAt).toBeGreaterThan(Date.now());
      expect(f.ledger.work(work.id).hold).toBe("quota");

      f.core.quota.tick(entry.resumeAt - 1);
      await f.core.idle();
      expect((await f.engine.page(conversationId, null, 50)).messages.filter((message) => message.role === "user")).toHaveLength(1);

      f.core.quota.tick(entry.resumeAt + 1);
      await f.core.settled(conversationId, 1);
      await f.core.idle();
      expect(f.ledger.work(work.id).state).toBe("verifying");
      expect(f.core.quota.waiting()).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
