import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Ghost } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { createToolSet } from "../src/tools/index.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { harness, MemoryArtifacts, type FakeEngine } from "./support.ts";

interface Setup {
  root: string;
  ledger: Ledger;
  core: Core;
  engine: FakeEngine;
  tools: ToolSet;
  ghost: Ghost;
  direct: Conversation;
}

/** The same shape tools.test.ts uses: a real tool set over a fake engine and a temp workspace. */
function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "ghost-repeat-"));
  const h = harness(":memory:", new MemoryArtifacts());
  const tools = createToolSet({
    core: h.core,
    sandbox: {
      envFor: async () => new NodeExecutionEnv({ cwd: join(root, "workspace") }),
      workspacePath: () => { const path = join(root, "workspace"); mkdirSync(path, { recursive: true }); return path; },
      stageInputs: async () => {},
      release: async () => {},
    },
    memory: null,
    documents: null,
    skills: null,
  });
  const ghost = h.core.createGhost({ name: "Garden", persona: "Does parts." });
  return { root, ledger: h.ledger, core: h.core, engine: h.engine, tools, ghost, direct: h.ledger.conversation(ghost.directConversationId) };
}

const apiOf = (piConversationId: string, callId: string): ToolExecutionApi =>
  ({ conversationId: piConversationId, callId, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;

const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;

async function call(tool: { execute: (args: never, api: ToolExecutionApi, context: Context) => Promise<ToolExecutionResult> }, args: unknown, api: ToolExecutionApi): Promise<ToolExecutionResult> {
  return tool.execute(args as never, api, testContext());
}

function contentOf(result: ToolExecutionResult): string {
  return (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** A running Work bound to a Pi conversation id the tools will see. */
async function runningWork(s: Setup) {
  s.ledger.setPiConversationId(s.direct.id, "pi-direct");
  const created = await call(s.tools.extensionsFor(s.direct, s.ghost, null)[0]!.tools!.find((tool) => tool.name === "work_create")!, { title: "Report", brief: "Write the report" }, apiOf("pi-direct", "create-1"));
  expect(created.isError).toBeFalsy();
  await s.core.idle();
  const work = s.ledger.worksForState().find((candidate) => candidate.title === "Report")!;
  if (!work.conversationId) throw new Error("the Work never started");
  const conversation = s.ledger.conversation(work.conversationId);
  s.ledger.setPiConversationId(conversation.id, "pi-work");
  const publish = s.tools.extensionsFor(conversation, s.ghost, s.ledger.work(work.id)).flatMap((extension) => extension.tools ?? []).find((tool) => tool.name === "publish_artifact")!;
  return { work, conversation, publish };
}

describe("repeat guard (R8)", () => {
  test("the third identical refusal explains the constraint; the sixth stops the Work and tells its origin", async () => {
    const s = setup();
    try {
      const { work, conversation, publish } = await runningWork(s);
      const args = { path: "missing.txt", name: "report.txt" };

      const first = await call(publish, args, apiOf("pi-work", "call-1"));
      expect(first.isError).toBe(true);
      expect(contentOf(first)).not.toContain("[Host]");

      const second = await call(publish, args, apiOf("pi-work", "call-2"));
      expect(contentOf(second)).not.toContain("[Host]");

      const third = await call(publish, args, apiOf("pi-work", "call-3"));
      expect(third.isError).toBe(true);
      expect(contentOf(third)).toContain("[Host] publish_artifact refused exactly this way 3 times");
      expect(contentOf(third)).toContain("constraint is real");
      expect(s.ledger.work(work.id).state).toBe("running");

      for (let index = 4; index <= 6; index++) await call(publish, args, apiOf("pi-work", `call-${index}`));
      await s.core.idle();

      const blocked = s.ledger.work(work.id);
      expect(blocked.state).toBe("blocked");
      expect(blocked.hold).toBe("repeat");
      expect(blocked.reason).toContain("publish_artifact");
      const told = s.engine.to(s.direct.id).filter((submission) => submission.requestId.startsWith(`work:${work.id}:repeat:`));
      expect(told).toHaveLength(1);
      expect(told[0]!.text).toContain("work_decide");

      // The origin lets it continue once; the counters start over.
      const next = s.core.works.decide(work.id, "continue");
      expect(next.state).toBe("running");
      const fresh = await call(publish, args, apiOf("pi-work", "call-7"));
      expect(contentOf(fresh)).not.toContain("[Host]");
    } finally {
      s.ledger.close();
    }
  });

  test("a different error from the same tool starts counting again", async () => {
    const s = setup();
    try {
      const { publish } = await runningWork(s);
      for (let index = 1; index <= 2; index++) await call(publish, { path: "missing.txt" }, apiOf("pi-work", `a-${index}`));
      const other = await call(publish, { path: "also-missing.txt" }, apiOf("pi-work", "a-3"));
      expect(contentOf(other)).not.toContain("[Host]");
      const same = await call(publish, { path: "missing.txt" }, apiOf("pi-work", "a-4"));
      expect(contentOf(same)).not.toContain("[Host]");
    } finally {
      s.ledger.close();
    }
  });
});
