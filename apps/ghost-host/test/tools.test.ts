import { describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactRef, Conversation, Ghost, UiBlock, Work } from "@ghost/contract";
import { parseInteractiveUi, readInteractiveUi } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ArtifactStore } from "../src/core/ports.ts";
import type { Core } from "../src/core/core.ts";
import { sha256 } from "../src/core/ids.ts";
import { parseShellResult } from "../src/core/verify.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { createToolSet } from "../src/tools/index.ts";
import { splitQuestion } from "../src/tools/shared.ts";
import { MAX_ARTIFACT_BYTES } from "../src/tools/work.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { harness, tempDir, type FakeEngine } from "./support.ts";
import { createDocuments } from "../src/integrations/documents.ts";

/** Artifact bytes in a temp directory. */
class TempArtifacts implements ArtifactStore {
  constructor(readonly root: string) {}
  async put(bytes: Uint8Array, name: string, mediaType: string): Promise<ArtifactRef> {
    const digest = sha256(bytes);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, digest), bytes);
    return { digest, name, mediaType, size: bytes.length };
  }
  async size(digest: string): Promise<number> {
    return statSync(join(this.root, digest)).size;
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
  const tools = createToolSet({ core: h.core, sandbox, memory: null, documents: null, skills: null });
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
  test("Work conversations can list and read every Space while preserving scope and direct-only proposals", async () => {
    const s = setup();
    try {
      const documents = createDocuments(s.core);
      s.tools = createToolSet({ core: s.core, sandbox: s.sandbox, memory: null, documents, skills: null });
      const path = join(s.root, "project");
      mkdirSync(path);
      s.ledger.tx(() => s.ledger.putSpace({ id: "project", name: "비행 기록", path, createdAt: Date.now() }));
      const page = await documents.save({ spaceId: "project", title: "비행 계획", body: "이륙 전에 바람을 확인한다.", profile: "pdc-markdown/1", pageId: null, expectedHash: null });
      const { work, conversation, pi } = await runningWork(s);
      const spaces = await call(toolOf(s, conversation, s.ghost, "document_spaces"), {}, apiOf(pi, "spaces"));
      expect(spaces.isError).toBeFalsy();
      expect(contentOf(spaces)).toContain("비행 기록 (project)");
      const listTool = toolOf(s, conversation, s.ghost, "document_list");
      const listed = await call(listTool, { space_id: "project" }, apiOf(pi, "list"));
      expect(listed.isError).toBeFalsy();
      expect(contentOf(listed)).toContain("비행 계획");
      const readTool = toolOf(s, conversation, s.ghost, "document_read");
      const read = await call(readTool, { space_id: "project", page_id: page.pageId }, apiOf(pi, "read"));
      expect(read.isError).toBeFalsy();
      expect(contentOf(read)).toContain("이륙 전에 바람을 확인한다.");
      const proposed = await call(toolOf(s, conversation, s.ghost, "document_propose"), { space_id: "project", title: "No", body: "No" }, apiOf(pi, "propose"));
      expect(proposed.isError).toBe(true);
      expect(contentOf(proposed)).toContain("does not run in a work conversation");
      expect(s.ledger.pendingDecisions()).toHaveLength(0);
      s.ledger.tx(() => s.ledger.putWork({ ...s.ledger.work(work.id), toolScope: ["document_list"] }));
      const scopedRead = await call(readTool, { space_id: "project", page_id: page.pageId }, apiOf(pi, "scoped-read"));
      expect(scopedRead.isError).toBe(true);
      expect((await call(listTool, { space_id: "project" }, apiOf(pi, "scoped-list"))).isError).toBeFalsy();
      await s.core.idle();
    } finally { s.core.stop(); s.ledger.close(); }
  });
  test("present_ui is deterministic presentation even with every optional tool disabled", async () => {
    const s = setup();
    const ghost = { ...s.ghost, tools: [] };
    s.ledger.tx(() => s.ledger.putGhost(ghost));
    const pi = asPi(s, s.direct, "pi-direct");
    const present = toolOf(s, s.direct, ghost, "present_ui");
    const ui = parseInteractiveUi({
      version: "ghost-ui/1",
      title: "검토 방식",
      blocks: [{ type: "choices", id: "mode", title: "어떻게 검토할까요?", options: [{ id: "summary", label: "핵심 요약" }] }],
    });
    const before = { ghost: s.ledger.ghost(ghost.id), conversations: s.ledger.conversations(), works: s.ledger.worksForState(), schedules: s.ledger.schedules() };
    const first = await call(present, ui, apiOf(pi, "ui-1"));
    const replayed = await call(present, ui, apiOf(pi, "ui-1"));
    expect(first.isError).toBeFalsy();
    expect(contentOf(first)).toBe(JSON.stringify(ui));
    expect(readInteractiveUi(contentOf(first))).toEqual(ui);
    expect(replayed).toEqual(first);
    expect({ ghost: s.ledger.ghost(ghost.id), conversations: s.ledger.conversations(), works: s.ledger.worksForState(), schedules: s.ledger.schedules() }).toEqual(before);
  });

  test("present_ui returns recoverable errors for invalid cross-field invariants and hidden actions", async () => {
    const s = setup();
    const pi = asPi(s, s.direct, "pi-direct");
    const present = toolOf(s, s.direct, s.ghost, "present_ui");
    const invalidBlocks = [
      [{ type: "text", id: "same", text: "첫째" }, { type: "text", id: "same", text: "둘째" }],
      [{ type: "chart", id: "chart", title: "불일치", kind: "bar", series: [{ name: "첫째", points: [{ label: "A", value: 1 }] }, { name: "둘째", points: [{ label: "B", value: 2 }] }] }],
      [{ type: "chart", id: "chart", title: "무한 수치", kind: "line", series: [{ name: "값", points: [{ label: "A", value: Infinity }] }] }],
      [{ type: "comparison", id: "table", title: "누락 열", columns: ["A", "B"], rows: [{ label: "항목", values: ["하나"] }] }],
      [{ type: "form", id: "form", title: "범위", submitLabel: "보내기", fields: [{ type: "number", id: "count", label: "개수", min: 1, max: 5, value: 8 }] }],
      [{ type: "form", id: "form", title: "선택", submitLabel: "보내기", fields: [{ type: "select", id: "pick", label: "항목", options: [{ value: "a", label: "A" }], value: "b" }] }],
      [{ type: "choices", id: "choices", title: "숨은 실행", options: [{ id: "run", label: "계속", action: { command: "bash" } }] }],
      Array.from({ length: 12 }, (_, index) => ({ type: "text", id: `text-${index}`, text: "a".repeat(12000) })),
    ];
    for (const [index, blocks] of invalidBlocks.entries()) {
      const refused = await call(present, { version: "ghost-ui/1", title: "잘못된 UI", blocks }, apiOf(pi, `invalid-${index}`));
      expect(refused.isError).toBe(true);
      expect(readInteractiveUi(contentOf(refused))).toBeNull();
    }
    const recovered = await call(present, { version: "ghost-ui/1", title: "수정 완료", blocks: [{ type: "text", id: "ok", text: "정상 표시" }] }, apiOf(pi, "valid-after-errors"));
    expect(recovered.isError).toBeFalsy();
    expect(readInteractiveUi(contentOf(recovered))?.title).toBe("수정 완료");
    expect(s.ledger.worksForState()).toHaveLength(0);
  });

  test("present_ui rejects duplicate top-level chart points and accepts nested data", async () => {
    const s = setup();
    const pi = asPi(s, s.direct, "pi-direct");
    const present = toolOf(s, s.direct, s.ghost, "present_ui");
    const points = [{ label: "사과", value: 2 }, { label: "배", value: 3 }];
    const chart = { type: "chart", id: "fruit-count", title: "과일 개수", kind: "bar", series: [{ name: "개수", points }] } satisfies UiBlock;
    const ui = { version: "ghost-ui/1", title: "운영 UI 확인", blocks: [{ ...chart, points }] };

    const refused = await call(present, ui, apiOf(pi, "duplicate-points"));
    expect(refused.isError).toBe(true);
    const corrected = await call(present, { ...ui, blocks: [chart] }, apiOf(pi, "nested-points"));
    expect(corrected.isError).toBeFalsy();
    expect(readInteractiveUi(contentOf(corrected))?.blocks[0]).toEqual(chart);
  });

  test("present_ui rejects comparison rows with mismatched value columns", async () => {
    const s = setup();
    const pi = asPi(s, s.direct, "pi-direct");
    const present = toolOf(s, s.direct, s.ghost, "present_ui");
    const comparison = { type: "comparison", id: "types", title: "블록 유형", columns: ["블록", "용도", "상호작용"], rows: [{ label: "차트", values: ["추이·비교 시각화", "표시 전용"] }] } satisfies UiBlock;
    const ui = { version: "ghost-ui/1", title: "UI 데모", blocks: [comparison] };

    const refused = await call(present, ui, apiOf(pi, "extra-label-column"));
    expect(refused.isError).toBe(true);
    const corrected = await call(present, { ...ui, blocks: [{ ...comparison, columns: ["용도", "상호작용"] }] }, apiOf(pi, "value-columns-only"));
    expect(corrected.isError).toBeFalsy();
    expect(readInteractiveUi(contentOf(corrected))?.blocks[0]).toEqual({ ...comparison, columns: ["용도", "상호작용"] });
  });

  test("a stale present_ui registration resolves the caller and rejects work and review execution", async () => {
    const s = setup();
    const present = toolOf(s, s.direct, s.ghost, "present_ui");
    const ui = { version: "ghost-ui/1", title: "직접 대화 전용", blocks: [{ type: "text", id: "text", text: "표시" }] };
    const { work, conversation, pi } = await runningWork(s);
    const fromWork = await call(present, ui, apiOf(pi, "ui-work"));
    expect(fromWork.isError).toBe(true);
    const reviewer = s.core.createGhost({ name: "Critic", persona: "Review the result." });
    s.core.works.update(work.id, { acceptance: { criteria: "Review the result", checks: [], reviewer: { kind: "ghost", ghostId: reviewer.id } } });
    const completed = await call(toolOf(s, conversation, s.ghost, "complete"), { summary: "검토 요청", artifacts: [] }, apiOf(pi, "complete-for-review"));
    expect(completed.isError).toBeFalsy();
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((candidate) => candidate.workId === work.id);
    if (!review) throw new Error("no review conversation was opened");
    const reviewPi = asPi(s, review, "pi-review");
    const fromReview = await call(present, ui, apiOf(reviewPi, "ui-review"));
    expect(fromReview.isError).toBe(true);
    const unbound = await call(present, ui, apiOf("not-in-ledger", "ui-unbound"));
    expect(unbound.isError).toBe(true);
    expect(s.ledger.effectsForWork(work.id)).toHaveLength(0);
  });

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

  test("self-started Work is judged by a Ghost instead of waiting on the owner", async () => {
    const s = setup();
    const main = s.core.createGhost({ name: "Main", persona: "Lead", isDefault: true });
    const helper = s.core.createGhost({ name: "Helper", persona: "You help." });
    const pi = asPi(s, s.direct, "pi-direct");
    const tool = toolOf(s, s.direct, s.ghost, "work_create");
    await call(tool, { title: "Handed", brief: "Do it", ghost_id: helper.id, initiative: true }, apiOf(pi, "call-1"));
    await call(tool, { title: "Own", brief: "Do it", initiative: true }, apiOf(pi, "call-2"));
    const reviewer = (title: string) => s.ledger.worksForState().find((work) => work.title === title)!.acceptance.reviewer;
    expect(reviewer("Handed")).toEqual({ kind: "ghost", ghostId: s.ghost.id });
    expect(reviewer("Own")).toEqual({ kind: "ghost", ghostId: main.id });
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

  test("output completion recovers from malformed attachments and accepts only attached, reopened published bytes", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    const body = "Measured result: 42\n";
    const digest = sha256(body);
    s.core.works.update(work.id, {
      acceptance: {
        criteria: "Deliver the measured report",
        checks: [
          { kind: "artifact_contains", name: "report.txt", text: "Measured result: 42" },
          { kind: "artifact_sha256", name: "report.txt", sha256: digest },
        ],
        reviewer: null,
      },
    });
    const workspace = s.sandbox.workspacePath(work);
    const publish = toolOf(s, conversation, s.ghost, "publish_artifact");
    const complete = toolOf(s, conversation, s.ghost, "complete");
    writeFileSync(join(workspace, "report.txt"), body);
    writeFileSync(join(workspace, "scratch.txt"), "not a deliverable");
    for (const name of ["report.txt", "scratch.txt"]) {
      expect((await call(publish, { path: name }, apiOf(pi, `publish-${name}`))).isError).toBeFalsy();
    }
    const published = s.ledger.artifactsForWork(work.id);
    const report = published.find((artifact) => artifact.name === "report.txt")!;
    const summary = "Delivered report.txt containing Measured result: 42";
    const malformed = [{ summary }, { summary, artifacts: null }, { summary, artifacts: "report.txt" }, { summary, artifacts: [null] }];
    for (const [index, args] of malformed.entries()) {
      const refused = await call(complete, args, apiOf(pi, `malformed-${index}`));
      expect(refused.isError).toBe(true);
      expect(refused.control?.terminate).toBeFalsy();
      const running = s.ledger.work(work.id);
      expect(running.state).toBe("running");
      expect(running.result).toBeNull();
      expect(running.verdict).toBeNull();
      expect(running.revisionsUsed).toBe(0);
      expect(s.ledger.pendingDecisions({ workId: work.id })).toHaveLength(0);
    }

    // A valid empty array cannot substitute a summary for the required output attachment.
    expect((await call(complete, { summary, artifacts: [] }, apiOf(pi, "unattached"))).isError).toBeFalsy();
    await s.core.idle();
    const unattached = s.ledger.work(work.id);
    expect(unattached.state).toBe("running");
    expect(unattached.verdict?.outcome).toBe("revise");
    expect(unattached.result?.artifacts).toEqual([]);
    expect(s.ledger.artifactsForWork(work.id)).toEqual(published);

    // Acceptance must reopen the stored bytes, not trust the attached digest or summary.
    const stored = join(s.root, "artifacts", report.digest);
    writeFileSync(stored, "tampered result");
    expect((await call(complete, { summary, artifacts: ["report.txt"] }, apiOf(pi, "tampered"))).isError).toBeFalsy();
    await s.core.idle();
    expect(s.ledger.work(work.id).state).toBe("running");
    expect(s.ledger.work(work.id).verdict?.outcome).toBe("revise");

    writeFileSync(stored, body);
    writeFileSync(join(workspace, "report.txt"), "workspace changed after publication");
    const corrected = await call(complete, { summary, artifacts: ["report.txt"] }, apiOf(pi, "corrected"));
    expect(corrected.isError).toBeFalsy();
    expect(corrected.control?.terminate).toBe(true);
    await s.core.idle();
    const done = s.ledger.work(work.id);
    expect(done.state).toBe("done");
    expect(done.verdict?.outcome).toBe("pass");
    expect(done.verdict?.source).toBe("checks");
    expect(done.result?.artifacts).toEqual([report]);
    expect(new TextDecoder().decode(await s.core.artifacts.read(done.result!.artifacts[0]!.digest))).toBe(body);
    expect(s.ledger.pendingDecisions({ workId: work.id })).toHaveLength(0);
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

  test("artifact_read lists the attached names when the requested artifact is not part of the result", async () => {
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
    const wrong = await call(toolOf(s, review, reviewer, "artifact_read"), { name: "summary.txt" }, apiOf(reviewPi, "read-wrong"));
    expect(wrong.isError).toBe(true);
    const message = contentOf(wrong);
    expect(message).toContain("not part of this Work's result");
    expect(message).toMatch(/report\.txt \([0-9a-f]{12}\)/);

    const right = await call(toolOf(s, review, reviewer, "artifact_read"), { name: "report.txt" }, apiOf(reviewPi, "read-right"));
    expect(right.isError).toBeFalsy();
    expect(contentOf(right)).toContain("hello world");
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

  test("publish_artifact lists the workspace files when the path is missing or absolute", async () => {
    const s = setup();
    const { work, conversation, pi } = await runningWork(s);
    const workspace = s.sandbox.workspacePath(work);
    writeFileSync(join(workspace, "report.txt"), "hello world");
    mkdirSync(join(workspace, "inputs", "child-1"), { recursive: true });
    writeFileSync(join(workspace, "inputs", "child-1", "summary.md"), "child result");

    const absolute = await call(toolOf(s, conversation, s.ghost, "publish_artifact"), { path: "/Users/garden/report.md" }, apiOf(pi, "pub-abs"));
    expect(absolute.isError).toBe(true);
    const message = contentOf(absolute);
    expect(message).toContain("path must be relative to the workspace");
    expect(message).toContain("inputs/child-1/summary.md");
    expect(message).toContain("report.txt");
    expect(message).toContain("host_read");
    expect(message).not.toContain(workspace);

    const missing = await call(toolOf(s, conversation, s.ghost, "publish_artifact"), { path: "inputs/report.md" }, apiOf(pi, "pub-missing"));
    expect(missing.isError).toBe(true);
    const missingMessage = contentOf(missing);
    expect(missingMessage).toContain("no file at inputs/report.md");
    expect(missingMessage).toContain("report.txt");
    expect(s.ledger.artifactsForWork(work.id)).toHaveLength(0);
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

  test("only the owner can extend an existing Work deadline", async () => {
    const s = setup();
    const pi = asPi(s, s.direct, "pi-direct");
    const workCreate = toolOf(s, s.direct, s.ghost, "work_create");
    const workUpdate = toolOf(s, s.direct, s.ghost, "work_update");
    await call(workCreate, { title: "Timed", brief: "Finish the report" }, apiOf(pi, "timed"));
    const work = s.ledger.worksForState().find((item) => item.title === "Timed")!;
    expect(work.deadlineAt).toBeGreaterThan(Date.now() + 89 * 60_000);
    const extended = await call(workUpdate, { work_id: work.id, deadline_minutes: 180 }, apiOf(pi, "extend"));
    expect(extended.isError).toBe(true);
    expect(s.ledger.work(work.id).deadlineAt).toBe(work.deadlineAt);
    const shortened = await call(workUpdate, { work_id: work.id, deadline_minutes: 10 }, apiOf(pi, "shorten"));
    expect(shortened.isError).toBeFalsy();
    expect(s.ledger.work(work.id).deadlineAt).toBeLessThan(work.deadlineAt!);
    const ownerDeadline = Date.now() + 180 * 60_000;
    expect(s.core.works.update(work.id, { deadlineAt: ownerDeadline }).deadlineAt).toBe(ownerDeadline);
    await s.core.idle();
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

  for (const revoked of ["scope", "PC", "deadline", "Ghost state"] as const) {
    test(`live ${revoked} authority is checked before a stale Work tool can act`, async () => {
      const s = setup();
      const { work, conversation, pi } = await runningWork(s);
      const bash = toolOf(s, conversation, s.ghost, "bash");
      const env = await s.sandbox.envFor(work);
      const path = join(s.sandbox.workspacePath(work), "authority-leak");
      s.ledger.tx(() => {
        if (revoked === "scope") s.ledger.putWork({ ...s.ledger.work(work.id), toolScope: ["read"] });
        if (revoked === "PC") s.ledger.putWork({ ...s.ledger.work(work.id), execution: { kind: "host", cwd: s.sandbox.workspacePath(work) } });
        if (revoked === "deadline") s.ledger.putWork({ ...s.ledger.work(work.id), deadlineAt: Date.now() - 1 });
        if (revoked === "Ghost state") s.ledger.putGhost({ ...s.ledger.ghost(s.ghost.id), state: "retired" });
      });
      const refused = await call(bash, { command: "printf leaked > authority-leak" }, apiOf(pi, "stale-authority", env));
      expect(refused.isError).toBe(true);
      expect(existsSync(path)).toBe(false);
      expect(s.ledger.effectsForWork(work.id)).toHaveLength(0);
    });
  }

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

  test("the main Ghost can open the Mac to a teammate, and the owner is told every time", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "You help." });
    const pi = asPi(s, s.direct, "pi-direct");
    const update = toolOf(s, s.direct, s.ghost, "ghost_update");
    const spoken = () => s.ledger.notificationsForState().filter((item) => item.kind === "message");

    const renamed = await call(update, { ghost_id: helper.id, name: "Helper 2" }, apiOf(pi, "rename"));
    expect(renamed.isError).toBeFalsy();
    expect(spoken()).toEqual([]);

    const granted = await call(update, { ghost_id: helper.id, host_execution: true, tools: [...helper.tools, "host_read"] }, apiOf(pi, "grant"));
    expect(granted.isError).toBeFalsy();
    const after = s.ledger.ghost(helper.id);
    expect(after.hostExecution).toBe(true);
    expect(after.tools).toContain("host_read");
    expect(spoken()).toHaveLength(1);
    expect(spoken()[0]!.title).toContain("PC 직접 실행");
    expect(spoken()[0]!.title).toContain("host_read");

    const again = await call(update, { ghost_id: helper.id, host_execution: true }, apiOf(pi, "again"));
    expect(again.isError).toBeFalsy();
    expect(spoken()).toHaveLength(1);
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

describe("ask_owner card text", () => {
  test("the first line is the heading and only the rest is context, so the card never repeats it", () => {
    expect(splitQuestion("어느 쪽으로 할까요?\n\n- A는 빠릅니다")).toEqual({ title: "어느 쪽으로 할까요?", detail: "- A는 빠릅니다" });
    expect(splitQuestion("한 줄 질문")).toEqual({ title: "한 줄 질문", detail: "" });
    const long = "가".repeat(250);
    expect(splitQuestion(long)).toEqual({ title: "가".repeat(200), detail: long });
  });
});
