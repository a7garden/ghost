import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GHOST_PERMISSIONS, HOST_TOOLS, type Conversation, type Ghost, type GhostPermissions, type Principal, type Work } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { Core } from "../src/core/core.ts";
import type { Config } from "../src/config.ts";
import type { DocumentsPort, HostCommand, HostCommandPolicy, HostPort, SandboxEnvFactory } from "../src/integrations/ports.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { createSandbox } from "../src/sandbox/index.ts";
import { runFlags } from "../src/sandbox/container.ts";
import { createToolSet } from "../src/tools/index.ts";
import { FakeEngine, MemoryArtifacts, MemorySecrets, noSandbox } from "./support.ts";

/** 2026-11-09: what the owner grants a Ghost beyond its tool list, and that a grant replaces asking. */

const owner = { kind: "owner" } as const satisfies Principal;
const context = { publicOrigin: "http://x", documents: null };
const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;
const apiOf = (piConversationId: string, callId: string, env: unknown = undefined): ToolExecutionApi =>
  ({ conversationId: piConversationId, callId, env, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;
const textOf = (result: ToolExecutionResult) => (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

class FakeHost {
  readonly runs: { command: HostCommand; policy?: HostCommandPolicy }[] = [];
  readonly validated: (HostCommandPolicy | undefined)[] = [];
  validateCommand(input: HostCommand, policy?: HostCommandPolicy): HostCommand {
    this.validated.push(policy);
    if (!policy?.interpreters && input.program.endsWith("/python3")) throw new Error("privileged, remote, shell or interpreter program refused");
    return input;
  }
  async executeCommand(command: HostCommand, policy?: HostCommandPolicy) {
    this.runs.push({ command, policy });
    return { exitCode: 0, output: "done", timedOut: false, truncated: false };
  }
}

class FakeDocuments {
  readonly applied: string[] = [];
  spacesFor() {
    return [{ space: { id: "space-1", name: "Notes", path: "/notes", grants: [], createdAt: 1 }, mode: "propose" as const }];
  }
  async listPages() { return []; }
  async readPage(): Promise<never> { throw new Error("unused"); }
  async check() {}
  async apply(decision: { id: string }) { this.applied.push(decision.id); return "Saved the page."; }
  async save(): Promise<never> { throw new Error("unused"); }
}

const noEnvSandbox: SandboxEnvFactory = {
  envFor: async () => { throw new Error("no env in these tests"); },
  workspacePath: () => mkdtempSync(join(tmpdir(), "ghost-perm-ws-")),
  stageInputs: async () => {},
  release: async () => {},
};

function setup(mountRefusal?: (path: string) => string | null) {
  const ledger = new Ledger(":memory:");
  const core = new Core({ ledger, artifacts: new MemoryArtifacts(), sandbox: { ...noSandbox, ...(mountRefusal ? { mountRefusal } : {}) }, secrets: new MemorySecrets(), log: () => {} });
  const engine = new FakeEngine();
  core.attach(engine);
  const host = new FakeHost();
  const documents = new FakeDocuments();
  core.decisions.onDocumentApproved((decision) => documents.apply(decision));
  const tools = createToolSet({ core, sandbox: noEnvSandbox, memory: null, documents: documents as unknown as DocumentsPort, skills: null, host: host as unknown as HostPort });
  const created = core.createGhost({ name: "Ops", persona: "", tools: [...HOST_TOOLS, "document_propose", "document_spaces"] });
  const ghost = ledger.ghost(created.id);
  const direct = ledger.conversation(ghost.directConversationId);
  ledger.setPiConversationId(direct.id, "pi-direct");
  return { ledger, core, engine, host, documents, tools, ghost, direct };
}

type Setup = ReturnType<typeof setup>;

function toolOf(s: Setup, conversation: Conversation, ghost: Ghost, name: string, work: Work | null = null) {
  for (const extension of s.tools.extensionsFor(conversation, ghost, work)) {
    const found = extension.tools?.find((candidate) => candidate.name === name);
    if (found) return found;
  }
  throw new Error(`${name} is not visible to a ${conversation.kind} conversation`);
}

async function grant(s: Setup, permissions: GhostPermissions) {
  await execute(s.core, new Access(owner), { requestId: crypto.randomUUID(), command: { type: "ghost.permissions_update", ghostId: s.ghost.id, permissions } }, context);
  return s.ledger.ghost(s.ghost.id);
}

const command = { title: "List", reason: "Look", program: "/bin/ls", args: ["-la"], cwd: "/tmp", risk: "none" };

describe("permission profile", () => {
  test("a Ghost reads as the conservative defaults until the owner widens it", async () => {
    const s = setup();
    expect(s.ghost.permissions).toEqual(DEFAULT_GHOST_PERMISSIONS);
    const events: string[] = [];
    s.ledger.subscribe((event) => { if (event.data.type === "ghost") events.push(event.data.ghost.permissions?.sandbox.network ? "on" : "off"); });
    const granted = await grant(s, { ...DEFAULT_GHOST_PERMISSIONS, sandbox: { ...DEFAULT_GHOST_PERMISSIONS.sandbox, network: true } });
    expect(granted.permissions?.sandbox.network).toBe(true);
    expect(s.ledger.ghosts().find((ghost) => ghost.id === s.ghost.id)?.permissions?.sandbox.network).toBe(true);
    expect(events).toEqual(["on"]);
  });

  test("only the owner changes permissions; a paired device cannot", async () => {
    const s = setup();
    const device = new Access({ kind: "device", deviceId: "phone", name: "Phone" });
    await expect(execute(s.core, device, { requestId: crypto.randomUUID(), command: { type: "ghost.permissions_update", ghostId: s.ghost.id, permissions: DEFAULT_GHOST_PERMISSIONS } }, context)).rejects.toThrow("needs the owner");
  });

  test("mounts must be existing absolute folders outside the state root", async () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-perm-root-"));
    const project = mkdtempSync(join(tmpdir(), "ghost-perm-project-"));
    const s = setup((path) => (path.startsWith(root) ? "overlaps the Ghost state root" : null));
    const withMount = (path: string) => ({ ...DEFAULT_GHOST_PERMISSIONS, sandbox: { ...DEFAULT_GHOST_PERMISSIONS.sandbox, mounts: [{ path, writable: true }] } });
    await expect(grant(s, withMount("relative/path"))).rejects.toThrow("absolute");
    await expect(grant(s, withMount(join(project, "missing")))).rejects.toThrow("not a folder");
    mkdirSync(join(root, "secrets"));
    await expect(grant(s, withMount(join(root, "secrets")))).rejects.toThrow("state root");
    const ok = await grant(s, withMount(project));
    expect(ok.permissions?.sandbox.mounts).toEqual([{ path: project, writable: true }]);
  });

  test("the real sandbox refuses a mount that contains or sits inside the state root", () => {
    const root = mkdtempSync(join(tmpdir(), "ghost-perm-sb-"));
    const sandbox = createSandbox({ root, sandbox: { kind: "local" } } as Config, new MemoryArtifacts());
    expect(sandbox.mountRefusal!(join(root, "artifacts"))).toContain("state root");
    expect(sandbox.mountRefusal!(join(root, ".."))).toContain("state root");
    expect(sandbox.mountRefusal!(mkdtempSync(join(tmpdir(), "ghost-perm-other-")))).toBeNull();
  });
});

describe("container flags follow the grants", () => {
  const base = { cli: "container", image: "img", name: "ghost-x", workspace: "/ws", logicalRoot: "/workspace" };
  test("by default: no network, no DNS, two CPUs, 2 GiB, only the workspace", () => {
    const flags = runFlags(base);
    expect(flags.join(" ")).toContain("--network none --no-dns");
    expect(flags.join(" ")).toContain("--cpus 2 --memory 2G");
    expect(flags.filter((flag) => flag === "--mount")).toHaveLength(1);
    expect(flags).toContain("source=/ws,target=/workspace");
  });
  test("granted: network, owner folders at the same path, chosen resources", () => {
    const flags = runFlags({ ...base, network: true, cpus: 6, memoryGiB: 12, mounts: [{ path: "/p/app", writable: true }, { path: "/p/ref", writable: false }] });
    expect(flags).not.toContain("--network");
    expect(flags.join(" ")).toContain("--cpus 6 --memory 12G");
    expect(flags).toContain("source=/p/app,target=/p/app");
    expect(flags).toContain("source=/p/ref,target=/p/ref,readonly");
  });
  test("a review container sees the same files read-only", () => {
    const flags = runFlags({ ...base, readOnly: true, mounts: [{ path: "/p/app", writable: true }] });
    expect(flags).toContain("source=/ws,target=/workspace,readonly");
    expect(flags).toContain("source=/p/app,target=/p/app,readonly");
  });
});

describe("Mac commands", () => {
  test("by default a command waits for the owner's approval", async () => {
    const s = setup();
    const result = await toolOf(s, s.direct, s.ghost, "host_command_propose").execute(command as never, apiOf("pi-direct", "c1"), testContext());
    expect(textOf(result)).toContain("approval required");
    expect(s.host.runs).toHaveLength(0);
    expect(s.ledger.pendingDecisions().map((decision) => decision.kind)).toEqual(["approve_effect"]);
  });

  test("granted without approval, it runs at once, is journaled and never runs twice", async () => {
    const s = setup();
    const ghost = await grant(s, { ...DEFAULT_GHOST_PERMISSIONS, host: { approval: "never", interpreters: true, privileged: false } });
    const tool = toolOf(s, s.direct, ghost, "host_command_propose");
    const python = { ...command, program: "/usr/bin/python3", args: ["-c", "print(1); print(2)"] };
    const first = await tool.execute(python as never, apiOf("pi-direct", "c2"), testContext());
    expect(textOf(first)).toContain("Ran without approval");
    expect(textOf(first)).toContain("done");
    const replay = await tool.execute(python as never, apiOf("pi-direct", "c2"), testContext());
    expect(textOf(replay)).toContain("done");
    expect(s.host.runs).toHaveLength(1);
    expect(s.host.runs[0]!.policy).toEqual({ interpreters: true, privileged: false });
    expect(s.ledger.pendingDecisions()).toHaveLength(0);
    expect(s.ledger.notificationsForState()).toHaveLength(0);
    const [effect] = s.ledger.effectsInState("done");
    expect(effect?.tool).toBe("host_command_propose");
  });

  test("an interpreter stays refused until the owner grants interpreters", async () => {
    const s = setup();
    const ghost = await grant(s, { ...DEFAULT_GHOST_PERMISSIONS, host: { approval: "never", interpreters: false, privileged: false } });
    // A validation refusal surfaces as the harness's tool error, as it always has.
    await expect(toolOf(s, s.direct, ghost, "host_command_propose").execute({ ...command, program: "/usr/bin/python3" } as never, apiOf("pi-direct", "c3"), testContext())).rejects.toThrow("interpreter program refused");
    expect(s.host.validated.at(-1)).toEqual({ interpreters: false, privileged: false });
    expect(s.host.runs).toHaveLength(0);
  });
});

describe("documents", () => {
  test("granted document writes save at once, on record, without asking", async () => {
    const s = setup();
    const ghost = await grant(s, { ...DEFAULT_GHOST_PERMISSIONS, documents: { autoWrite: true } });
    const result = await toolOf(s, s.direct, ghost, "document_propose").execute({ space_id: "space-1", title: "Plan", body: "# Plan" } as never, apiOf("pi-direct", "d1"), testContext());
    expect(textOf(result)).toContain("Saved without review");
    expect(s.documents.applied).toHaveLength(1);
    const [decision] = s.ledger.decisionsForState();
    expect(decision?.kind).toBe("document_review");
    expect(decision?.state).toBe("approved");
    expect(s.ledger.notificationsForState()).toHaveLength(0);
    expect(s.ledger.effectsInState("done").map((effect) => effect.tool)).toEqual(["document_write"]);
  });

  test("without the grant a proposal still waits for review", async () => {
    const s = setup();
    await toolOf(s, s.direct, s.ghost, "document_propose").execute({ space_id: "space-1", title: "Plan", body: "# Plan" } as never, apiOf("pi-direct", "d2"), testContext());
    expect(s.documents.applied).toHaveLength(0);
    expect(s.ledger.pendingDecisions().map((decision) => decision.kind)).toEqual(["document_review"]);
  });
});

describe("unknown effects", () => {
  async function runningWork(s: Setup) {
    const work = s.core.works.createRoot({ ghostId: s.ghost.id, title: "T", brief: "B", originConversationId: s.direct.id });
    await s.core.idle();
    return s.ledger.work(work.id);
  }

  test("by default an unknown outcome blocks the Work until the owner reconciles it", async () => {
    const s = setup();
    const work = await runningWork(s);
    const start = s.core.effects.begin({ conversationId: work.conversationId!, callId: "x1", tool: "bash", input: { command: "make" }, summary: "make" });
    if (start.kind !== "run") throw new Error("expected a run");
    s.core.effects.unknown(start.effect.id, "the host stopped");
    expect(s.ledger.work(work.id).state).toBe("blocked");
    expect(s.ledger.pendingDecisions().map((decision) => decision.kind)).toEqual(["reconcile_effect"]);
  });

  test("granted to continue, the Ghost is told, the Work keeps running and later effects are not held", async () => {
    const s = setup();
    await grant(s, { ...DEFAULT_GHOST_PERMISSIONS, effects: { unknown: "continue" } });
    const work = await runningWork(s);
    const conversationId = work.conversationId!;
    const start = s.core.effects.begin({ conversationId, callId: "x1", tool: "bash", input: { command: "make" }, summary: "make" });
    if (start.kind !== "run") throw new Error("expected a run");
    s.core.effects.unknown(start.effect.id, "the host stopped");
    await s.core.idle();
    expect(s.ledger.work(work.id).state).toBe("running");
    expect(s.ledger.pendingDecisions()).toHaveLength(0);
    expect(s.ledger.effect(start.effect.id).state).toBe("unknown");
    expect(s.engine.to(conversationId).find((submission) => submission.requestId === `effect:${start.effect.id}:unknown`)?.text).toContain("will not run again");
    expect(s.core.effects.begin({ conversationId, callId: "x2", tool: "bash", input: { command: "make test" }, summary: "make test" }).kind).toBe("run");
    // The unknown call itself is still never repeated.
    expect(() => s.core.effects.begin({ conversationId, callId: "x1", tool: "bash", input: { command: "make" }, summary: "make" })).toThrow("will not run again");
  });
});

describe("review checks", () => {
  test("the reviewer runs a check over the Work's files and reads the result", async () => {
    const s = setup();
    const helper = s.core.createGhost({ name: "Helper", persona: "" });
    const work = s.core.works.createRoot({ ghostId: helper.id, title: "Build", brief: "B", acceptance: { criteria: "", checks: [], reviewer: null, owner: false }, originConversationId: s.direct.id });
    await s.core.idle();
    s.core.works.complete(work.id, { summary: "Built.", artifacts: [] });
    await s.core.idle();
    const review = s.ledger.conversations({ kind: "review" }).find((conversation) => conversation.workId === work.id)!;
    s.ledger.setPiConversationId(review.id, "pi-review");
    const commands: string[] = [];
    const env = {
      exec: async (command: string, options: { onOutput?: (chunk: string, context: unknown, info: { stream: string }) => void }) => {
        commands.push(command);
        options.onOutput?.("12 passed\n", undefined, { stream: "stdout" });
        return { ok: true, value: { exitCode: 0 } };
      },
    };
    const reviewer = s.ledger.ghost(review.ghostId);
    const result = await toolOf(s, review, reviewer, "run_check", s.ledger.work(work.id)).execute({ command: "bun test" } as never, apiOf("pi-review", "r1", env), testContext());
    expect(textOf(result)).toContain("exit 0");
    expect(textOf(result)).toContain("12 passed");
    expect(commands).toEqual(["bun test"]);
    // Checks change nothing, so they are not journaled.
    expect(s.ledger.effectsForWork(work.id)).toHaveLength(0);
  });

  test("run_check is only for review conversations", async () => {
    const s = setup();
    expect(() => toolOf(s, s.direct, s.ghost, "run_check")).toThrow("not visible");
  });
});
