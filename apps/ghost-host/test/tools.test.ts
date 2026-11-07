import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRef, Conversation, Ghost, Work } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ArtifactStore } from "../src/core/ports.ts";
import type { Core } from "../src/core/core.ts";
import { sha256 } from "../src/core/ids.ts";
import { parseShellResult } from "../src/core/verify.ts";
import type { SandboxEnvFactory, MemoryPort } from "../src/integrations/ports.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { createToolSet } from "../src/tools/index.ts";
import { MAX_ARTIFACT_BYTES } from "../src/tools/work.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { harness, tempDir, type FakeEngine } from "./support.ts";

/** Artifact bytes in a temp directory. */
class TempArtifacts implements ArtifactStore {
  constructor(readonly root: string) {}
  async put(bytes: Uint8Array, name: string, mediaType: string): Promise<ArtifactRef> {
    const digest = sha256(bytes);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, digest), bytes);
    return { digest, name, mediaType, size: bytes.length };
  }
  async read(digest: string): Promise<Uint8Array> {
    return readFileSync(join(this.root, digest));
  }
  has(digest: string): boolean {
    return existsSync(join(this.root, digest));
  }
  path(digest: string): string {
    return join(this.root, digest);
  }
}

/** Sandbox stub whose workspaces are directories under one temp root. */
class TempSandbox implements SandboxEnvFactory {
  constructor(readonly root: string) {}
  async envFor(work: Work) {
    return new NodeExecutionEnv({ cwd: this.workspacePath(work) });
  }
  workspacePath(work: Work): string {
    const path = join(this.root, work.id);
    mkdirSync(path, { recursive: true });
    return path;
  }
  async stageInputs() {}
  async release() {}
}

/** MemoryPort stub that records retains and answers search/recall deterministically. */
class FakeMemory implements MemoryPort {
  readonly retained: { ghostId: string; text: string }[] = [];
  available(): boolean {
    return true;
  }
  async search(_ghostId: string, query: string, _limit: number) {
    return [{ text: `hit for ${query}`, source: "stub", score: null }];
  }
  async recall(_ghostId: string, _query: string, _tokenBudget: number) {
    return { text: "recalled text", sources: ["stub"] };
  }
  async retain(ghostId: string, text: string, _origin: { conversationId: string; workId: string | null }) {
    this.retained.push({ ghostId, text });
    return { id: `stub-${this.retained.length}` };
  }
}

interface Setup {
  root: string;
  ledger: Ledger;
  core: Core;
  engine: FakeEngine;
  tools: ToolSet;
  ghost: Ghost;
  direct: Conversation;
  sandbox: TempSandbox;
}

function setup(): Setup {
  const root = mkdtempSync(join(tmpdir(), "ghost-tools-"));
  const artifacts = new TempArtifacts(join(root, "artifacts"));
  const sandbox = new TempSandbox(join(root, "sandboxes"));
  const h = harness(":memory:", artifacts);
  const tools = createToolSet({ core: h.core, sandbox, memory: null, documents: null });
  const ghost = h.core.createGhost({ name: "Garden", persona: "You are Garden.\nSecond line" });
  return { root, ledger: h.ledger, core: h.core, engine: h.engine, tools, ghost, direct: h.ledger.conversation(ghost.directConversationId), sandbox };
}

/** The single tool `name` a conversation of this kind can see. */
function toolOf(setup: Setup, conversation: Conversation, ghost: Ghost, name: string) {
  for (const extension of setup.tools.extensionsFor(conversation, ghost, null)) {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found) return found;
  }
  throw new Error(`${name} is not visible to a ${conversation.kind} conversation`);
}

function namesOf(setup: Setup, conversation: Conversation, ghost: Ghost): string[] {
  return setup.tools.extensionsFor(conversation, ghost, null).flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name));
}

// Stub of the harness's per-call API: only the fields these tools read.
const apiOf = (piConversationId: string, callId: string, env: unknown = undefined): ToolExecutionApi =>
  ({ conversationId: piConversationId, callId, env, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;

// Stub of the invocation context; the tools only read `abortSignal`.
const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;

async function call(tool: Awaited<ReturnType<typeof toolOf>>, args: unknown, api: ToolExecutionApi): Promise<ToolExecutionResult> {
  return tool.execute(args as never, api, testContext());
}

function contentOf(result: ToolExecutionResult): string {
  return (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** Bind a conversation to the Pi id the tools will see. */
function asPi(setup: Setup, conversation: Conversation, piId: string): string {
  setup.ledger.setPiConversationId(conversation.id, piId);
  return piId;
}

/** A root Work created through the tool, with its work conversation running. */
async function runningWork(setup: Setup) {
  const pi = asPi(setup, setup.direct, "pi-direct");
  const created = await call(toolOf(setup, setup.direct, setup.ghost, "work_create"), { title: "Report", brief: "Write the report", criteria: "A report exists" }, apiOf(pi, "create-1"));
  expect(created.isError).toBeFalsy();
  await setup.core.idle();
  const work = setup.ledger.worksForState().find((candidate) => candidate.title === "Report");
  if (!work?.conversationId) throw new Error("the Work never started");
  const conversation = setup.ledger.conversation(work.conversationId);
  return { work, conversation, pi: asPi(setup, conversation, "pi-work") };
}

describe("tools", () => {
  test("work_create from a direct conversation creates a root Work reporting to it", async () => {
    const s = setup();
    const pi = asPi(s, s.direct, "pi-direct");
    const result = await call(toolOf(s, s.direct, s.ghost, "work_create"), { title: "Report", brief: "Write the annual report", criteria: "A report exists" }, apiOf(pi, "call-1"));
    expect(result.isError).toBeFalsy();
    const work = s.ledger.worksForState().find((candidate) => candidate.title === "Report");
    expect(work).toBeDefined();
    expect(work!.parentId).toBeNull();
    expect(work!.ghostId).toBe(s.ghost.id);
    expect(work!.originConversationId).toBe(s.direct.id);
    expect(work!.acceptance).toEqual({ criteria: "A report exists", checks: [], reviewer: null });
    await s.core.idle();
    const running = s.ledger.work(work!.id);
    expect(running.state).toBe("running");
    expect(running.conversationId).not.toBeNull();
  });

  test("work_create with ghost_id assigns another Ghost but still reports here", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "You help." });
    const pi = asPi(s, s.direct, "pi-direct");
    const result = await call(toolOf(s, s.direct, s.ghost, "work_create"), { title: "Handed over", brief: "Do it", ghost_id: helper.id }, apiOf(pi, "call-1"));
    expect(result.isError).toBeFalsy();
    const work = s.ledger.worksForState().find((candidate) => candidate.title === "Handed over");
    expect(work!.ghostId).toBe(helper.id);
    expect(work!.originConversationId).toBe(s.direct.id);
  });

  test("a work conversation cannot see work_create; a direct one cannot see bash", async () => {
    const s = setup();
    const { conversation } = await runningWork(s);
    const directNames = namesOf(s, s.direct, s.ghost);
    expect(directNames).toContain("work_create");
    expect(directNames).not.toContain("bash");
    const workNames = namesOf(s, conversation, s.ghost);
    expect(workNames).toContain("bash");
    expect(workNames).not.toContain("work_create");
  });

  test("bash records a ShellResult effect and replays the same call id without running twice", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    const bash = toolOf(s, conversation, s.ghost, "bash");
    const env = await s.sandbox.envFor(work);
    const command = "printf x >> counter.txt; wc -c < counter.txt";
    const api = apiOf(pi, "call-9", env);

    const first = await call(bash, { command }, api);
    expect(first.isError).toBeFalsy();
    expect(contentOf(first)).toContain("exit 0");
    const effects = s.ledger.effectsForWork(work.id).filter((effect) => effect.tool === "bash");
    expect(effects).toHaveLength(1);
    expect(effects[0]!.summary).toBe(command);
    expect(effects[0]!.state).toBe("done");
    const shell = parseShellResult(effects[0]!.result);
    expect(shell?.exitCode).toBe(0);
    expect(shell?.stdout.trim()).toBe("1");

    const second = await call(bash, { command }, api);
    expect(second.isError).toBeFalsy();
    expect(contentOf(second)).toBe(contentOf(first));
    expect(s.ledger.effectsForWork(work.id).filter((effect) => effect.tool === "bash")).toHaveLength(1);
    expect(readFileSync(join(s.sandbox.root, work.id, "counter.txt")).toString()).toBe("x");
  });

  test("publish then complete moves the Work to verifying; an unpublished name is refused", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    writeFileSync(join(s.sandbox.workspacePath(work), "report.txt"), "hello world");
    const publish = toolOf(s, conversation, s.ghost, "publish_artifact");
    const complete = toolOf(s, conversation, s.ghost, "complete");

    const escape = await call(publish, { path: "../escape.txt" }, apiOf(pi, "pub-0"));
    expect(escape.isError).toBe(true);
    expect(contentOf(escape)).toContain("..");
    expect(s.ledger.artifactsForWork(work.id)).toHaveLength(0);

    const published = await call(publish, { path: "report.txt" }, apiOf(pi, "pub-1"));
    expect(published.isError).toBeFalsy();
    const refs = s.ledger.artifactsForWork(work.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe("report.txt");
    expect(refs[0]!.digest).toBe(sha256(readFileSync(join(s.sandbox.root, work.id, "report.txt"))));

    const missing = await call(complete, { summary: "Done", artifacts: ["nope.txt"] }, apiOf(pi, "complete-1"));
    expect(missing.isError).toBe(true);
    expect(s.ledger.work(work.id).state).toBe("running");

    const claimed = await call(complete, { summary: "Report written", artifacts: ["report.txt"] }, apiOf(pi, "complete-2"));
    expect(claimed.isError).toBeFalsy();
    expect(claimed.control?.terminate).toBe(true);
    const verifying = s.ledger.work(work.id);
    expect(verifying.state).toBe("verifying");
    expect(verifying.result?.artifacts.map((artifact) => artifact.name)).toEqual(["report.txt"]);
  });

  test("verdict from a review conversation settles the Work, once per verification", async () => {
    const s = setup();
    const reviewer = s.core.createGhost({ name: "Critic", persona: "You review." });
    const { work, conversation, pi } = await runningWork(s);
    s.core.works.update(work.id, { acceptance: { criteria: "A report exists", checks: [], reviewer: { kind: "ghost", ghostId: reviewer.id } } });
    writeFileSync(join(s.sandbox.workspacePath(work), "report.txt"), "hello world");
    await call(toolOf(s, conversation, s.ghost, "publish_artifact"), { path: "report.txt" }, apiOf(pi, "pub-1"));
    const claimed = await call(toolOf(s, conversation, s.ghost, "complete"), { summary: "Report written", artifacts: ["report.txt"] }, apiOf(pi, "complete-1"));
    expect(claimed.isError).toBeFalsy();
    await s.core.idle();

    const review = s.ledger.conversations({ kind: "review" }).find((candidate) => candidate.workId === work.id);
    if (!review) throw new Error("no review conversation was opened");
    const reviewPi = asPi(s, review, "pi-review");
    const verdict = toolOf(s, review, reviewer, "verdict");

    const revise = await call(verdict, { outcome: "revise", reasons: "The report is too short." }, apiOf(reviewPi, "verdict-1"));
    expect(revise.isError).toBeFalsy();
    expect(s.ledger.work(work.id).state).toBe("running");
    await s.core.idle();

    const again = await call(verdict, { outcome: "fail", reasons: "still bad" }, apiOf(reviewPi, "verdict-2"));
    expect(again.isError).toBe(true);
    expect(s.ledger.work(work.id).state).toBe("running");

    const workConversation = s.ledger.conversation(work.conversationId!);
    const workPi = asPi(s, workConversation, "pi-work-2");
    const fixed = await call(toolOf(s, workConversation, s.ghost, "complete"), { summary: "Extended the report", artifacts: ["report.txt"] }, apiOf(workPi, "complete-2"));
    expect(fixed.isError).toBeFalsy();
    await s.core.idle();

    const pass = await call(verdict, { outcome: "pass", reasons: "Good now." }, apiOf(reviewPi, "verdict-3"));
    expect(pass.isError).toBeFalsy();
    const settled = s.ledger.work(work.id);
    expect(settled.state).toBe("done");
    expect(settled.verdict?.source).toBe("review");
    expect(settled.verdict?.outcome).toBe("pass");
  });

  test("publish_artifact refuses a file above the byte cap without storing anything", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    const workspace = s.sandbox.workspacePath(work);
    const big = openSync(join(workspace, "big.bin"), "w");
    ftruncateSync(big, MAX_ARTIFACT_BYTES + 1);
    closeSync(big);

    const refused = await call(toolOf(s, conversation, s.ghost, "publish_artifact"), { path: "big.bin" }, apiOf(pi, "pub-big"));
    expect(refused.isError).toBe(true);
    expect(contentOf(refused)).toContain("larger than");
    expect(s.ledger.artifactsForWork(work.id)).toHaveLength(0);
    const attempts = s.ledger.effectsForWork(work.id).filter((effect) => effect.tool === "publish_artifact");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("denied");

    const exact = Buffer.alloc(MAX_ARTIFACT_BYTES);
    writeFileSync(join(workspace, "exact.bin"), exact);
    const published = await call(toolOf(s, conversation, s.ghost, "publish_artifact"), { path: "exact.bin" }, apiOf(pi, "pub-exact"));
    expect(published.isError).toBeFalsy();
    const refs = s.ledger.artifactsForWork(work.id);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.digest).toBe(sha256(exact));
  });

  test("publish_artifact maps an unreadable file to a refusal, not an unknown effect", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    const path = join(s.sandbox.workspacePath(work), "secret.txt");
    writeFileSync(path, "classified");
    chmodSync(path, 0o000);

    const refused = await call(toolOf(s, conversation, s.ghost, "publish_artifact"), { path: "secret.txt" }, apiOf(pi, "pub-denied"));
    expect(refused.isError).toBe(true);
    expect(contentOf(refused)).toContain("permission denied");
    expect(s.ledger.artifactsForWork(work.id)).toHaveLength(0);
    const attempts = s.ledger.effectsForWork(work.id).filter((effect) => effect.tool === "publish_artifact");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("denied");
  });

  test("a replayed work_create call finds the Work it already created", async () => {
    const s = setup();
    const pi = asPi(s, s.direct, "pi-direct");
    const args = { title: "Replay", brief: "Write the report", criteria: "A report exists" };
    const workCreate = toolOf(s, s.direct, s.ghost, "work_create");

    const first = await call(workCreate, args, apiOf(pi, "wc-1"));
    const again = await call(workCreate, args, apiOf(pi, "wc-1"));
    expect(first.isError).toBeFalsy();
    expect(contentOf(again)).toBe(contentOf(first));
    const works = s.ledger.worksForState().filter((work) => work.title === "Replay");
    expect(works).toHaveLength(1);
    expect(contentOf(first)).toContain(works[0]!.id);
    await s.core.idle();
    expect(s.ledger.work(works[0]!.id).conversationId).not.toBeNull();
  });

  test("a replayed delegate call finds the child it already created", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "You help." });
    const { work, conversation, pi } = await runningWork(s);
    const delegate = toolOf(s, conversation, s.ghost, "delegate");
    const args = { ghost_id: helper.id, title: "Part", brief: "Do the part", criteria: "The part is done" };

    const first = await call(delegate, args, apiOf(pi, "del-1"));
    const again = await call(delegate, args, apiOf(pi, "del-1"));
    expect(first.isError).toBeFalsy();
    expect(contentOf(again)).toBe(contentOf(first));
    const children = s.ledger.children(work.id);
    expect(children).toHaveLength(1);
    expect(contentOf(first)).toContain(children[0]!.id);
    await s.core.idle();
  });

  test("revoking a tool prevents a stale configured call from acting", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    // Captured while bash was still granted, as a conversation configured before the revocation holds it.
    const bash = toolOf(s, conversation, s.ghost, "bash");
    const env = await s.sandbox.envFor(work);
    const path = join(s.sandbox.root, work.id, "counter.txt");

    s.ledger.tx(() => s.ledger.putGhost({ ...s.ghost, tools: s.ghost.tools.filter((tool) => tool !== "bash"), updatedAt: Date.now() }));

    const stale = await call(bash, { command: "printf x >> counter.txt" }, apiOf(pi, "bash-stale", env));
    expect(stale.isError).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(s.ledger.effectsForWork(work.id).filter((effect) => effect.tool === "bash")).toHaveLength(0);
  });

  test("a tool offered to another conversation kind is refused at execution", async () => {
    const s = setup();
    const { pi } = await runningWork(s);
    const workCreate = toolOf(s, s.direct, s.ghost, "work_create");
    const crossKind = await call(workCreate, { title: "Cross", brief: "From a work conversation" }, apiOf(pi, "cross-1"));
    expect(crossKind.isError).toBe(true);
    expect(s.ledger.worksForState().filter((work) => work.title === "Cross")).toHaveLength(0);
  });

  test("ghost_inspect and ghost_update belong to the current main Ghost alone", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "You help.\nPreserve sources and never publish without approval." });
    const helperDirect = s.ledger.conversation(helper.directConversationId);
    expect(namesOf(s, helperDirect, helper)).not.toContain("ghost_inspect");
    expect(namesOf(s, helperDirect, helper)).not.toContain("ghost_update");

    const pi = asPi(s, s.direct, "pi-direct");
    const inspect = toolOf(s, s.direct, s.ghost, "ghost_inspect");
    const update = toolOf(s, s.direct, s.ghost, "ghost_update");

    const shown = await call(inspect, { ghost_id: helper.id }, apiOf(pi, "inspect-1"));
    expect(shown.isError).toBeFalsy();
    const inspected = JSON.parse(contentOf(shown));
    expect(inspected.persona).toBe("You help.\nPreserve sources and never publish without approval.");

    const self = await call(inspect, { ghost_id: s.ghost.id }, apiOf(pi, "inspect-2"));
    expect(self.isError).toBe(true);

    const updated = await call(update, { ghost_id: helper.id, tools: ["work_list", "read"] }, apiOf(pi, "update-1"));
    expect(updated.isError).toBeFalsy();
    expect(s.ledger.ghost(helper.id).tools).toEqual(["work_list", "read"]);

    const unknown = await call(update, { ghost_id: helper.id, tools: ["time_travel"] }, apiOf(pi, "update-2"));
    expect(unknown.isError).toBe(true);
    const duplicated = await call(update, { ghost_id: helper.id, tools: ["read", "read"] }, apiOf(pi, "update-3"));
    expect(duplicated.isError).toBe(true);
    expect(s.ledger.ghost(helper.id).tools).toEqual(["work_list", "read"]);
  });

  test("losing the main designation revokes ghost_update at execution, and the new main takes over", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "You help." });
    const helperDirect = s.ledger.conversation(helper.directConversationId);
    const pi = asPi(s, s.direct, "pi-direct");

    // An ordinary direct Ghost is not offered the management tools at all.
    expect(namesOf(s, helperDirect, helper)).not.toContain("ghost_update");

    // Captured while Garden is main, as an in-flight conversation holds its configured tools.
    const gardenUpdate = toolOf(s, s.direct, s.ghost, "ghost_update");

    // A work conversation refuses management even while its Ghost is main.
    const { conversation } = await runningWork(s);
    const workPi = asPi(s, conversation, "pi-work");
    const fromWork = await call(gardenUpdate, { ghost_id: helper.id, tools: [] }, apiOf(workPi, "update-1"));
    expect(fromWork.isError).toBe(true);
    expect(s.ledger.ghost(helper.id).tools).not.toEqual([]);

    // Designation is rechecked on every execution: the stale main is refused, the new main proceeds.
    s.ledger.tx(() => s.ledger.putGhost({ ...helper, isDefault: true, updatedAt: Date.now() }));
    const staleMain = await call(gardenUpdate, { ghost_id: helper.id, name: "Renamed" }, apiOf(pi, "update-2"));
    expect(staleMain.isError).toBe(true);
    expect(s.ledger.ghost(helper.id).name).toBe("Helper");

    const helperNow = s.ledger.ghost(helper.id);
    const helperUpdate = toolOf(s, helperDirect, helperNow, "ghost_update");
    const helperPi = asPi(s, helperDirect, "pi-helper");
    const takeover = await call(helperUpdate, { ghost_id: s.ghost.id, state: "paused" }, apiOf(helperPi, "update-3"));
    expect(takeover.isError).toBeFalsy();
    expect(s.ledger.ghost(s.ghost.id).state).toBe("paused");
    await s.core.idle();
  });

  test("a paused main Ghost loses management tools until reactivated", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "You help." });
    s.ledger.tx(() => s.ledger.putGhost({ ...s.ghost, state: "paused", updatedAt: Date.now() }));
    expect(namesOf(s, s.direct, s.ledger.ghost(s.ghost.id))).not.toContain("ghost_update");
    // Captured from the pre-pause configuration, as an in-flight conversation would hold it.
    const inspect = toolOf(s, s.direct, s.ghost, "ghost_inspect");
    const pi = asPi(s, s.direct, "pi-direct");
    const stale = await call(inspect, { ghost_id: helper.id }, apiOf(pi, "inspect-paused"));
    expect(stale.isError).toBe(true);
    await s.core.idle();
  });
});
