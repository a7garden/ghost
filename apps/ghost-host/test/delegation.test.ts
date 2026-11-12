import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Conversation, Ghost, Work } from "@ghost/contract";
import { Core } from "../src/core/core.ts";
import { deleteGhost, updateGhost } from "../src/core/commands.ts";
import type { Engine } from "../src/core/ports.ts";
import type { ArtifactStore } from "../src/core/ports.ts";
import { createEngine } from "../src/engine/index.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { createToolSet } from "../src/tools/index.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { MemoryArtifacts, MemorySecrets, harness, noSandbox, type FakeEngine } from "./support.ts";

/** Stub sandbox; these tests never execute a tool that needs a workspace. */
const stubSandbox: SandboxEnvFactory = {
  envFor: async () => {
    throw new Error("the delegation tests never run tools in a sandbox");
  },
  workspacePath: () => "",
  stageInputs: async () => {},
  release: async () => {},
};

interface Setup {
  ledger: Ledger;
  core: Core;
  engine: FakeEngine;
  artifacts: ArtifactStore;
  tools: ToolSet;
  ghost: Ghost;
  helper: Ghost;
}

/** Resolved when the n-th model request fires; the awaited signal, never a timer. */
interface Gate {
  promise: Promise<void>;
  resolve: () => void;
}

function setup(): Setup {
  const h = harness();
  const tools = createToolSet({ core: h.core, sandbox: stubSandbox, memory: null, documents: null, skills: null });
  const ghost = h.core.createGhost({ name: "Primary", persona: "Helpful.\nSecond line" });
  const helper = h.core.createGhost({ name: "Helper", persona: "Does parts." });
  return { ...h, tools, ghost, helper };
}

/** A live root Work of `ghost.ghost` with its work conversation started. */
async function runningParent(s: Setup) {
  const parent = s.core.works.createRoot({ ghostId: s.ghost.id, title: "Parent", brief: "Split it", originConversationId: s.ghost.directConversationId });
  await s.core.idle();
  return parent;
}

const acceptance = (reviewer: { kind: "ghost"; ghostId: string } | null = null) => ({ criteria: "", checks: [], reviewer });

describe("delegate rules", () => {
  test("a Work cannot delegate to its own Ghost", async () => {
    const s = setup();
    const parent = await runningParent(s);
    expect(() => s.core.works.delegate(parent.id, { ghostId: s.ghost.id, title: "Loop", brief: "B" })).toThrow(
      "a Work cannot delegate to its own Ghost",
    );
    expect(s.ledger.children(parent.id)).toHaveLength(0);
  });

  test("a named reviewer Ghost is stored and hosts the review conversation", async () => {
    const s = setup();
    const reviewer = s.core.createGhost({ name: "Critic", persona: "Judges results." });
    const parent = await runningParent(s);
    const child = s.core.works.delegate(parent.id, {
      ghostId: s.helper.id,
      title: "Child",
      brief: "B",
      acceptance: acceptance({ kind: "ghost", ghostId: reviewer.id }),
    });
    await s.core.idle();
    expect(s.ledger.work(child.id).acceptance.reviewer).toEqual({ kind: "ghost", ghostId: reviewer.id });

    s.core.works.complete(child.id, { summary: "half done", artifacts: [] });
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === child.id);
    expect(review?.ghostId).toBe(reviewer.id);
    expect(s.engine.to(review!.id)).toHaveLength(1);
  });

  test("without a named reviewer the delegator Ghost still reviews the child", async () => {
    const s = setup();
    const parent = await runningParent(s);
    const child = s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "Child", brief: "B" });
    await s.core.idle();
    expect(s.ledger.work(child.id).acceptance.reviewer).toBeNull();
    s.core.works.complete(child.id, { summary: "half done", artifacts: [] });
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === child.id);
    expect(review?.ghostId).toBe(s.ghost.id);
  });

  test("the reviewer must be an active, non-deleted Ghost other than the assignee", async () => {
    const s = setup();
    const parent = await runningParent(s);
    const gone = s.core.createGhost({ name: "Gone", persona: "Leaving." });
    updateGhost(s.core, gone.id, { state: "retired" });
    deleteGhost(s.core, gone.id);

    expect(() =>
      s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B", acceptance: acceptance({ kind: "ghost", ghostId: s.helper.id }) }),
    ).toThrow("other than the assignee");
    expect(() =>
      s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B", acceptance: acceptance({ kind: "ghost", ghostId: gone.id }) }),
    ).toThrow("was deleted");
    expect(() =>
      s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B", acceptance: acceptance({ kind: "ghost", ghostId: "no-such-ghost" }) }),
    ).toThrow();

    const paused = s.core.createGhost({ name: "Paused", persona: "Resting." });
    updateGhost(s.core, paused.id, { state: "paused" });
    expect(() =>
      s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B", acceptance: acceptance({ kind: "ghost", ghostId: paused.id }) }),
    ).toThrow("is paused");
    expect(s.ledger.children(parent.id)).toHaveLength(0);
  });

  test("a delegate target must be active and not deleted", async () => {
    const s = setup();
    const parent = await runningParent(s);
    updateGhost(s.core, s.helper.id, { state: "retired" });
    expect(() => s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B" })).toThrow("is retired");
    deleteGhost(s.core, s.helper.id);
    expect(() => s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B" })).toThrow("was deleted");
  });
});

// Stub of the harness's per-call API, as in tools.test.ts.
const apiOf = (piConversationId: string, callId: string): ToolExecutionApi =>
  ({ conversationId: piConversationId, callId, env: undefined, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;
const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as unknown as Context;
const contentOf = (result: ToolExecutionResult): string => (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
const asPi = (s: Setup, conversation: Conversation, piId: string) => {
  s.ledger.setPiConversationId(conversation.id, piId);
  return piId;
};
function toolOf(s: Setup, conversation: Conversation, ghost: Ghost, name: string) {
  for (const extension of s.tools.extensionsFor(conversation, ghost, null)) {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found) return found;
  }
  throw new Error(`${name} is not visible to a ${conversation.kind} conversation`);
}
async function call(tool: ToolRegistration, args: unknown, api: ToolExecutionApi): Promise<ToolExecutionResult> {
  return tool.execute(args as never, api, testContext());
}
/** A root Work created through the tool, with its work conversation running. */
async function runningToolWork(s: Setup) {
  const pi = asPi(s, s.ledger.conversation(s.ghost.directConversationId), "pi-direct");
  const created = await call(
    toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "work_create"),
    { title: "Parent", brief: "Split it" },
    apiOf(pi, "create-1"),
  );
  expect(created.isError).toBeFalsy();
  await s.core.idle();
  const work = s.ledger.worksForState().find((candidate) => candidate.title === "Parent");
  if (!work?.conversationId) throw new Error("the Work never started");
  const conversation = s.ledger.conversation(work.conversationId);
  return { work, conversation, pi: asPi(s, conversation, "pi-work") };
}

describe("delegate tool", () => {
  test("reviewer_ghost_id reaches the child's acceptance; without it the reviewer stays null", async () => {
    const s = setup();
    const reviewer = s.core.createGhost({ name: "Critic", persona: "Judges results." });
    const { work, conversation, pi } = await runningToolWork(s);
    const delegate = toolOf(s, conversation, s.ghost, "delegate");

    const named = await call(
      delegate,
      { ghost_id: s.helper.id, title: "Part", brief: "Do the part", reviewer_ghost_id: reviewer.id },
      apiOf(pi, "del-1"),
    );
    expect(named.isError).toBeFalsy();
    await s.core.idle();
    const child = s.ledger.children(work.id)[0]!;
    expect(child.acceptance.reviewer).toEqual({ kind: "ghost", ghostId: reviewer.id });

    const plain = await call(delegate, { ghost_id: s.helper.id, title: "Other", brief: "B" }, apiOf(pi, "del-2"));
    expect(plain.isError).toBeFalsy();
    await s.core.idle();
    expect(s.ledger.children(work.id)[1]!.acceptance.reviewer).toBeNull();
  });

  test("delegating to its own Ghost or to a deleted Ghost is refused at the tool", async () => {
    const s = setup();
    const { conversation, pi } = await runningToolWork(s);
    const delegate = toolOf(s, conversation, s.ghost, "delegate");

    const self = await call(delegate, { ghost_id: s.ghost.id, title: "Loop", brief: "B" }, apiOf(pi, "del-3"));
    expect(self.isError).toBe(true);
    expect(contentOf(self)).toContain("a Work cannot delegate to its own Ghost");

    updateGhost(s.core, s.helper.id, { state: "retired" });
    deleteGhost(s.core, s.helper.id);
    const gone = await call(delegate, { ghost_id: s.helper.id, title: "Gone", brief: "B" }, apiOf(pi, "del-4"));
    expect(gone.isError).toBe(true);
    expect(contentOf(gone)).toContain("was deleted");
  });
});

describe("delegation roster", () => {
  test("rows carry the resolved model, image, web and host tags", async () => {
    const s = setup();
    s.ledger.tx(() => {
      s.ledger.putProvider({
        id: "faux",
        kind: "openai_compatible",
        name: "Faux",
        baseUrl: null,
        models: [
          { id: "gpt-4.1", name: "Vision" },
          { id: "custom-text", name: "Custom" },
        ],
      });
      s.ledger.putSetting("defaultModel", { provider: "faux", model: "gpt-4.1" });
    });
    s.core.secrets.put("faux", "key");

    const operator = s.core.createGhost({ name: "Operator", persona: "Runs the Mac." });
    const withHost = s.ledger.ghost(operator.id).tools;
    updateGhost(s.core, operator.id, { tools: [...withHost, "host_status"] });
    const custom = s.core.createGhost({ name: "Custom", persona: "Custom model.", model: { provider: "faux", model: "custom-text" } });
    const remote = s.core.createGhost({ name: "Remote", persona: "Unconfigured provider.", model: { provider: "nowhere", model: "m-1" } });

    const parent = await runningParent(s);
    const conversation = s.ledger.conversation(s.ledger.work(parent.id).conversationId!);
    // Tags name only capabilities this host has installed: without Reach or Mac ports there is no web or host tag.
    const bare = s.tools.instructionsFor(conversation, s.ghost, s.ledger.work(parent.id));
    expect(bare).toContain(`Operator (ghost_id ${operator.id}) — Runs the Mac. [faux/gpt-4.1 image]`);
    const equipped = createToolSet({ core: s.core, sandbox: stubSandbox, memory: null, documents: null, skills: null, reach: {} as never, host: {} as never });
    const instructions = equipped.instructionsFor(conversation, s.ghost, s.ledger.work(parent.id));

    expect(instructions).toContain(`Helper (ghost_id ${s.helper.id}) — Does parts. [faux/gpt-4.1 image web]`);
    expect(instructions).toContain(`Operator (ghost_id ${operator.id}) — Runs the Mac. [faux/gpt-4.1 image web host]`);
    expect(instructions).toContain(`Custom (ghost_id ${custom.id}) — Custom model. [faux/custom-text web]`);
    expect(instructions).toContain(`Remote (ghost_id ${remote.id}) — Unconfigured provider. [nowhere/m-1 web]`);
    expect(instructions).toContain("model vendor differs from the assignee's");
    expect(instructions).not.toContain(`ghost_id ${s.ghost.id}`);
  });

  test("without a resolvable model the row keeps persona and tags only", async () => {
    const s = setup();
    const parent = await runningParent(s);
    const instructions = s.tools.instructionsFor(
      s.ledger.conversation(s.ledger.work(parent.id).conversationId!),
      s.ghost,
      s.ledger.work(parent.id),
    );
    expect(instructions).toContain(`Helper (ghost_id ${s.helper.id}) — Does parts.`);
    expect(instructions).not.toContain("image");
    expect(instructions).toContain("Ghosts you can delegate to:");
  });
});

describe("roster freshness", () => {
  const opensOf = (s: Setup, conversationId: string) => s.engine.opened.filter((entry) => entry.conversation.id === conversationId).length;

  test("creating, updating, retiring and deleting a Ghost re-opens live delegate-holders' work conversations", async () => {
    const s = setup();
    const parent = await runningParent(s);
    const conversationId = s.ledger.work(parent.id).conversationId!;
    expect(opensOf(s, conversationId)).toBe(1);

    const peer = s.core.createGhost({ name: "Newcomer", persona: "New." });
    await s.core.idle();
    expect(opensOf(s, conversationId)).toBe(2);

    updateGhost(s.core, peer.id, { name: "Renamed" });
    await s.core.idle();
    expect(opensOf(s, conversationId)).toBe(3);

    updateGhost(s.core, peer.id, { state: "retired" });
    await s.core.idle();
    expect(opensOf(s, conversationId)).toBe(4);

    deleteGhost(s.core, peer.id);
    await s.core.idle();
    expect(opensOf(s, conversationId)).toBe(5);
    expect(s.ledger.ghost(peer.id).deletedAt).not.toBeNull();

    // The stale peer is gone from the roster the conversation is next configured with.
    const instructions = s.tools.instructionsFor(s.ledger.conversation(conversationId), s.ghost, s.ledger.work(parent.id));
    expect(instructions).not.toContain(peer.id);
    expect(instructions).not.toContain("Renamed");
  });

  test("only Ghosts holding delegate with live Work are re-opened", async () => {
    const s = setup();
    const bare = s.core.createGhost({ name: "Bare", persona: "No delegate.", tools: ["read", "write", "edit"] });
    const bareWork = s.core.works.createRoot({ ghostId: bare.id, title: "Bare", brief: "B", originConversationId: bare.directConversationId });
    await s.core.idle();
    const parent = await runningParent(s);
    const liveId = s.ledger.work(parent.id).conversationId!;
    const bareId = s.ledger.work(bareWork.id).conversationId!;
    expect(opensOf(s, liveId)).toBe(1);
    expect(opensOf(s, bareId)).toBe(1);

    s.core.createGhost({ name: "Another", persona: "X." });
    await s.core.idle();
    expect(opensOf(s, liveId)).toBe(2);
    expect(opensOf(s, bareId)).toBe(1);

    const finished = await runningParent(s);
    s.core.works.cancel(finished.id);
    await s.core.idle();
    const finishedId = s.ledger.work(finished.id).conversationId!;
    const before = opensOf(s, finishedId);
    s.core.createGhost({ name: "Third", persona: "Y." });
    await s.core.idle();
    expect(opensOf(s, finishedId)).toBe(before);
  });
});

interface EngineFixture {
  core: Core;
  engine: Engine;
  ledger: Ledger;
  root: string;
  /** Model ids the faux provider served, in request order. */
  requested: string[];
  /** `gates[n]` resolves when the (n+1)-th model request fires. */
  gates: Gate[];
  parent: Ghost;
  worker: Ghost;
  reviewer: Ghost;
}

/** A real engine over one faux provider, so the model a review conversation actually uses is observable. */
async function engineFixture(): Promise<EngineFixture> {
  const root = mkdtempSync(join(tmpdir(), "ghost-delegation-"));
  const ledger = new Ledger(join(root, "ledger.db"));
  const secrets = new MemorySecrets();
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: noSandbox, secrets, log: () => {} });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  ledger.tx(() => {
    ledger.putProvider({
      id: "faux",
      kind: "openai_compatible",
      name: "Faux",
      baseUrl: null,
      models: [
        { id: "faux-1", name: "F1" },
        { id: "faux-2", name: "F2" },
        { id: "faux-3", name: "F3" },
      ],
    });
    ledger.putSetting("defaultModel", { provider: "faux", model: "faux-1" });
    ledger.putSetting("reviewModel", { provider: "faux", model: "faux-3" });
  });
  secrets.put("faux", "faux-key");
  const requested: string[] = [];
  const gates: Gate[] = Array.from({ length: 8 }, () => Promise.withResolvers<void>());
  const step = (): FauxResponseFactory => (_context, _options, _state, model) => {
    gates[requested.length]?.resolve();
    requested.push(model.id);
    return fauxAssistantMessage(fauxText("ok"));
  };
  faux.setResponses([step(), step(), step(), step(), step(), step(), step(), step()]);
  const engine = await createEngine({
    core,
    storagePath: join(root, "pi.db"),
    tools: createToolSet({ core, sandbox: stubSandbox, memory: null, documents: null, skills: null }),
    sandbox: stubSandbox,
    models,
    log: () => {},
  });
  core.attach(engine);
  const parent = core.createGhost({ name: "Parent", persona: "P.", model: { provider: "faux", model: "faux-1" } });
  const worker = core.createGhost({ name: "Worker", persona: "W.", model: { provider: "faux", model: "faux-1" } });
  const reviewer = core.createGhost({ name: "Reviewer", persona: "R.", model: { provider: "faux", model: "faux-2" } });
  await core.idle();
  return { core, engine, ledger, root, requested, gates, parent, worker, reviewer };
}

async function stopFixture(f: EngineFixture) {
  f.core.stop();
  await f.core.idle();
  await f.engine.close();
  f.ledger.close();
  rmSync(f.root, { recursive: true, force: true });
}

describe("review models", () => {
  test("a named reviewer Ghost is judged with its own model, not the review model", async () => {
    const f = await engineFixture();
    try {
      const parentWork = f.core.works.createRoot({ ghostId: f.parent.id, title: "Parent", brief: "Split", originConversationId: f.parent.directConversationId });
      await f.core.idle();
      const child = f.core.works.delegate(parentWork.id, {
        ghostId: f.worker.id,
        title: "Child",
        brief: "B",
        acceptance: acceptance({ kind: "ghost", ghostId: f.reviewer.id }),
      });
      await f.core.idle();
      f.core.works.complete(child.id, { summary: "done", artifacts: [] });
      // parent start, child start, review
      await f.gates[2]!.promise;
      expect(f.requested).toEqual(["faux-1", "faux-1", "faux-2"]);

      f.core.works.applyVerdict(child.id, { outcome: "pass", source: "review", reasons: "fine", at: Date.now() });
      await f.gates[3]!.promise;
      expect(f.requested[3]).toBe("faux-1");
      expect(f.requested).not.toContain("faux-3");
    } finally {
      await stopFixture(f);
    }
  });

  test("an unnamed review still takes the configured review model", async () => {
    const f = await engineFixture();
    try {
      const parentWork = f.core.works.createRoot({ ghostId: f.parent.id, title: "Parent", brief: "Split", originConversationId: f.parent.directConversationId });
      await f.core.idle();
      const child = f.core.works.delegate(parentWork.id, { ghostId: f.worker.id, title: "Child", brief: "B" });
      await f.core.idle();
      f.core.works.complete(child.id, { summary: "done", artifacts: [] });
      await f.gates[2]!.promise;
      // The review conversation runs under the delegator Ghost but the review model wins.
      expect(f.requested[2]).toBe("faux-3");
      f.core.works.applyVerdict(child.id, { outcome: "pass", source: "review", reasons: "fine", at: Date.now() });
      await f.gates[3]!.promise;
    } finally {
      await stopFixture(f);
    }
  });
});

describe("ghost.delete", () => {
  const retireAndDelete = (s: Setup, ghostId: string) => {
    updateGhost(s.core, ghostId, { state: "retired" });
    deleteGhost(s.core, ghostId);
  };

  test("refuses the default Ghost, an unretired Ghost, live Work and pending decisions", async () => {
    const s = setup();
    expect(() => deleteGhost(s.core, s.ghost.id)).toThrow("cannot be deleted");
    expect(() => deleteGhost(s.core, s.helper.id)).toThrow("retire");

    const work = s.core.works.createRoot({ ghostId: s.helper.id, title: "Live", brief: "B", originConversationId: s.helper.directConversationId });
    await s.core.idle();
    updateGhost(s.core, s.helper.id, { state: "retired" });
    expect(() => deleteGhost(s.core, s.helper.id)).toThrow("still has live Work");
    s.core.works.cancel(work.id);
    await s.core.idle();

    s.ledger.tx(() =>
      s.core.decisions.open({
        kind: "question",
        ghostId: s.helper.id,
        conversationId: s.helper.directConversationId,
        workId: null,
        effectId: null,
        title: "A question",
        detail: "Only the owner knows.",
        options: [],
        proposal: null,
      }),
    );
    expect(() => deleteGhost(s.core, s.helper.id)).toThrow("still has pending decisions");
    s.ledger.tx(() => {
      for (const decision of s.ledger.pendingDecisions().filter((candidate) => candidate.ghostId === s.helper.id)) {
        s.ledger.putDecision({ ...decision, state: "denied", answer: null, resolvedAt: Date.now() });
      }
    });
    deleteGhost(s.core, s.helper.id);
    expect(s.ledger.ghost(s.helper.id).deletedAt).not.toBeNull();
  });

  test("deleting scrubs schedules and leaves projects intact; a repeat delete is a no-op", () => {
    const s = setup();
    const other = s.core.createGhost({ name: "Keeper", persona: "Stays." });
    s.ledger.tx(() => {
      s.ledger.putSchedule({
        id: "sch-gone",
        ghostId: s.helper.id,
        conversationId: s.helper.directConversationId,
        prompt: "wake",
        spec: { kind: "at", at: Date.now() + 60_000 },
        nextAt: Date.now() + 60_000,
        state: "active",
        createdAt: Date.now(),
      });
      s.ledger.putSchedule({
        id: "sch-kept",
        ghostId: other.id,
        conversationId: other.directConversationId,
        prompt: "wake",
        spec: { kind: "at", at: Date.now() + 60_000 },
        nextAt: Date.now() + 60_000,
        state: "active",
        createdAt: Date.now(),
      });
      s.ledger.putScope({ id: "space-1", name: "Vault", paths: ["/tmp/vault"], vaultPath: "/tmp/vault", createdAt: Date.now() , ghostId: null, state: "active", attachments: [], limits: {}, updatedAt: 1 });
    });
    retireAndDelete(s, s.helper.id);
    // A repeat delete is a no-op, not an update of a deleted row.
    deleteGhost(s.core, s.helper.id);

    expect(s.ledger.schedules().map((schedule) => schedule.id)).toEqual(["sch-kept"]);
    expect(s.ledger.scope("space-1").name).toBe("Vault");
    expect(s.ledger.ghost(s.helper.id)).toMatchObject({ deletedAt: expect.any(Number), state: "retired" });
  });

  test("a deleted Ghost is absent from ghost_list, the roster, and delegate and work_create targets", async () => {
    const s = setup();
    const pi = asPi(s, s.ledger.conversation(s.ghost.directConversationId), "pi-direct");
    retireAndDelete(s, s.helper.id);

    const listed = await call(toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "ghost_list"), {}, apiOf(pi, "list-1"));
    expect(contentOf(listed)).not.toContain(s.helper.id);
    expect(contentOf(listed)).toContain(s.ghost.name);

    const parent = s.core.works.createRoot({ ghostId: s.ghost.id, title: "Parent", brief: "B", originConversationId: s.ghost.directConversationId });
    await s.core.idle();
    const instructions = s.tools.instructionsFor(s.ledger.conversation(s.ledger.work(parent.id).conversationId!), s.ghost, s.ledger.work(parent.id));
    expect(instructions).not.toContain(s.helper.id);
    expect(instructions).not.toContain("Does parts.");

    expect(() => s.core.works.delegate(parent.id, { ghostId: s.helper.id, title: "C", brief: "B" })).toThrow("was deleted");
    const workCreate = toolOf(s, s.ledger.conversation(s.ghost.directConversationId), s.ghost, "work_create");
    const assigned = await call(workCreate, { title: "To a deleted Ghost", brief: "B", ghost_id: s.helper.id }, apiOf(pi, "create-2"));
    expect(assigned.isError).toBe(true);
    expect(contentOf(assigned)).toContain("is retired");
  });

  test("ghost.update on a deleted Ghost conflicts and revives nothing", () => {
    const s = setup();
    retireAndDelete(s, s.helper.id);
    expect(() => updateGhost(s.core, s.helper.id, { name: "Zombie" })).toThrow("was deleted");
    expect(s.ledger.ghost(s.helper.id).name).toBe("Helper");
  });

  test("a deleted Ghost takes no owner message and runs no tool from its retained conversations", async () => {
    const s = setup();
    const pi = asPi(s, s.ledger.conversation(s.helper.directConversationId), "pi-helper");
    retireAndDelete(s, s.helper.id);
    expect(() => s.core.sendMessage(s.helper.directConversationId, "still there?", crypto.randomUUID())).toThrow("was deleted");
    const listed = await call(toolOf(s, s.ledger.conversation(s.helper.directConversationId), s.ledger.ghost(s.helper.id), "ghost_list"), {}, apiOf(pi, "list-deleted"));
    expect(listed.isError).toBe(true);
    expect(contentOf(listed)).toContain("was deleted");
  });
});
