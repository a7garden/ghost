import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { APP_GHOST_TOOLS, type Command, type Ghost, type Scope } from "@ghost/contract";
import type { ToolExecutionApi, ToolExecutionResult, ToolPark } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { execute } from "../src/core/commands.ts";
import { deleteGhost, updateGhost } from "../src/core/commands.ts";
import { Access } from "../src/core/access.ts";
import type { Core } from "../src/core/core.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { suggestedScopeIds } from "../src/packages/index.ts";
import { BUILTIN_PACKAGES } from "../src/packages/builtin.ts";
import { createToolSet } from "../src/tools/index.ts";
import type { ToolSet } from "../src/tools/types.ts";
import type { SandboxEnvFactory } from "../src/integrations/ports.ts";
import { harness, tempDir, type FakeEngine } from "./support.ts";

const context = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as unknown as Context;
const owner = () => new Access({ kind: "owner" });
const commandContext = { publicOrigin: "http://localhost", documents: null };
const run = async (core: Core, requestId: string, command: Command) =>
  execute(core, owner(), { requestId, command }, commandContext);

const sandbox: SandboxEnvFactory = {
  envFor: async () => {
    throw new Error("package tests never execute sandbox commands");
  },
  workspacePath: () => "/packages-test",
  stageInputs: async () => {},
  release: async () => {},
};

/** A GHOST.md with YAML front matter and a persona body. */
function writePackage(root: string, name: string, matter: Record<string, unknown>, persona: string): string {
  const dir = join(root, "ghost-packages", name);
  mkdirSync(dir, { recursive: true });
  const front = Object.entries(matter).map(([key, value]) => (Array.isArray(value) ? `${key}: [${value.map((item) => `"${item}"`).join(", ")}]` : `${key}: ${value}`)).join("\n");
  const path = join(dir, "GHOST.md");
  writeFileSync(path, `---\n${front}\n---\n${persona}\n`);
  return path;
}

interface PackagesSetup {
  root: string;
  packagesRoot: string;
  ledger: Ledger;
  core: Core;
  engine: FakeEngine;
}

const opened: PackagesSetup[] = [];
afterEach(() => {
  for (const item of opened.splice(0)) rmSync(item.root, { recursive: true, force: true });
});

/** A harness whose owner packages live under a fresh temp root. */
function packagesFixture(): PackagesSetup {
  const root = tempDir();
  const packagesRoot = join(root, "ghost-packages");
  const h = harness(":memory:", undefined, packagesRoot);
  opened.push({ root, packagesRoot, ledger: h.ledger, core: h.core, engine: h.engine });
  return { root, packagesRoot, ledger: h.ledger, core: h.core, engine: h.engine };
}

describe("installing a package", () => {
  test("the dev package sets source, tools and PC execution", async () => {
    const h = packagesFixture();
    const main = h.core.createGhost({ name: "Main", persona: "You manage." });
    expect(main.isDefault).toBe(true);
    const ghostId = (await run(h.core, "install-dev", { type: "ghost.create", package: "dev" })).ghostId as string;
    await h.core.idle();
    const ghost = h.ledger.ghost(ghostId);
    const pkg = BUILTIN_PACKAGES.find((candidate) => candidate.name === "dev")!;
    expect(ghost.name).toBe(pkg.title);
    expect(ghost.persona).toBe(pkg.persona);
    expect(ghost.source).toEqual({ package: "dev", version: pkg.version });
    expect(ghost.tools).toEqual([...pkg.tools]);
    expect(ghost.tools).toContain("code_run");
    expect(ghost.hostExecution).toBe(true);
    expect(ghost.isDefault).toBe(false);
  });

  test("a second install of the same package conflicts", async () => {
    const h = packagesFixture();
    h.core.createGhost({ name: "Main", persona: "You manage." });
    await run(h.core, "install-dev", { type: "ghost.create", package: "dev" });
    await h.core.idle();
    await expect(run(h.core, "install-dev-again", { type: "ghost.create", package: "dev" })).rejects.toThrow("already installed");
  });

  test("a hand-made Ghost needs a name and a persona, and starts from the installed-Ghost tools", async () => {
    const h = packagesFixture();
    const main = h.ledger.ghosts().find((ghost) => ghost.isDefault) ?? h.core.createGhost({ name: "Main", persona: "You manage." });
    await expect(run(h.core, "no-name", { type: "ghost.create" })).rejects.toThrow("needs a name");
    await expect(run(h.core, "no-persona", { type: "ghost.create", name: "Nameless" })).rejects.toThrow("needs a persona");
    const ghostId = (await run(h.core, "hand-made", { type: "ghost.create", name: "Hand", persona: "Made by hand." })).ghostId as string;
    const ghost = h.ledger.ghost(ghostId);
    expect(ghost.tools).toEqual([...APP_GHOST_TOOLS]);
    expect(ghost.source).toBeNull();
    expect(ghost.isDefault).toBe(false);
    expect(main.isDefault).toBe(true);
  });
});

describe("owner GHOST.md packages", () => {
  test("a valid file is listed, an invalid one and a built-in name clash become errors", async () => {
    const h = packagesFixture();
    const valid = writePackage(h.root, "notes", { name: "notes", title: "메모", version: 2, tools: ["read", "write"], skills: [], hostExecution: false, modelHint: "", projects: "documents" }, "One line at a time.\nEverything the owner jots down.");
    const broken = writePackage(h.root, "broken", { name: "broken", title: "깨진 패키지", version: 0 }, "Version zero is invalid.");
    const clash = writePackage(h.root, "dev", { name: "dev", title: "가짜 개발", version: 1 }, "Tries to shadow the built-in dev package.");

    const catalog = h.core.packages.list();
    const names = catalog.packages.map((pkg) => pkg.name);
    expect(names).toContain("notes");
    expect(names).toContain("dev");
    expect(names).not.toContain("broken");
    const notes = catalog.packages.find((pkg) => pkg.name === "notes")!;
    expect(notes.origin).toBe("owner");
    expect(notes.version).toBe(2);
    expect(notes.tools).toEqual(["read", "write"]);
    expect(notes.persona).toBe("One line at a time.\nEverything the owner jots down.");
    expect(notes.projects).toBe("documents");

    expect(catalog.errors).toHaveLength(2);
    expect(catalog.errors.map((error) => error.path)).toEqual([broken, clash].sort());
    expect(catalog.errors.find((error) => error.path === broken)!.message).toContain("valid Ghost package");
    expect(catalog.errors.find((error) => error.path === clash)!.message).toContain("built-in");
    // The built-in dev wins over the clashing owner file.
    expect(h.core.packages.get("dev").origin).toBe("builtin");
    expect(h.core.packages.get("notes").title).toBe("메모");
    expect(() => h.core.packages.get("missing")).toThrow("no Ghost package");
    expect(valid).toBeTruthy();
  });

  test("a missing packages root means built-ins only, without errors", () => {
    const root = tempDir();
    const h = harness(":memory:", undefined, join(root, "ghost-packages"));
    opened.push({ root, packagesRoot: join(root, "ghost-packages"), ledger: h.ledger, core: h.core, engine: h.engine });
    const catalog = h.core.packages.list();
    expect(catalog.errors).toEqual([]);
    expect(catalog.packages.every((pkg) => pkg.origin === "builtin")).toBe(true);
    expect(catalog.packages.length).toBe(BUILTIN_PACKAGES.length);
  });
});

describe("ghost.apply_package", () => {
  test("restores an edited persona and records the package's new version", async () => {
    const root = tempDir();
    writePackage(root, "notes", { name: "notes", title: "메모", version: 1 }, "First persona.");
    const ledgerPath = join(root, "ledger.db");
    const first = harness(ledgerPath, undefined, join(root, "ghost-packages"));
    const main = first.core.createGhost({ name: "Main", persona: "You manage." });
    const ghostId = (await run(first.core, "install-notes", { type: "ghost.create", package: "notes" })).ghostId as string;
    await first.core.idle();
    updateGhost(first.core, ghostId, { persona: "Locally edited.", hostExecution: true, model: { provider: "p", model: "m" } });
    await expect(run(first.core, "apply-main", { type: "ghost.apply_package", ghostId: main.id })).rejects.toThrow("main Ghost");
    await first.core.idle();
    first.core.stop();
    first.ledger.close();

    writePackage(root, "notes", { name: "notes", title: "메모", version: 2 }, "Second persona.");
    const second = harness(ledgerPath, undefined, join(root, "ghost-packages"));
    await run(second.core, "apply-notes", { type: "ghost.apply_package", ghostId });
    await second.core.idle();
    const applied = second.ledger.ghost(ghostId);
    expect(applied.persona).toBe("Second persona.");
    expect(applied.source).toEqual({ package: "notes", version: 2 });
    // The owner's own settings survive a re-apply.
    expect(applied.hostExecution).toBe(true);
    expect(applied.model).toEqual({ provider: "p", model: "m" });
    second.core.stop();
    second.ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("ghost.delete in 3.0", () => {
  test("deletes an active Ghost, and refuses one a scope still references", async () => {
    const h = packagesFixture();
    const main = h.core.createGhost({ name: "Main", persona: "You manage." });
    const ghostId = (await run(h.core, "install-dev", { type: "ghost.create", package: "dev" })).ghostId as string;
    await h.core.idle();
    expect(h.ledger.ghost(ghostId).state).toBe("active");
    expect(() => deleteGhost(h.core, main.id)).toThrow("main Ghost");

    h.ledger.tx(() => h.ledger.putScope({ id: "scope-dev", name: "Repo", ghostId, paths: ["/tmp/repo"], vaultPath: null, state: "active", attachments: [], limits: {}, createdAt: Date.now(), updatedAt: Date.now() } satisfies Scope));
    expect(() => deleteGhost(h.core, ghostId)).toThrow("referenced by configuration");

    h.ledger.tx(() => h.ledger.putScope({ id: "scope-dev", name: "Repo", ghostId: null, paths: ["/tmp/repo"], vaultPath: null, state: "active", attachments: [], limits: {}, createdAt: Date.now(), updatedAt: Date.now() } satisfies Scope));
    await run(h.core, "delete-dev", { type: "ghost.delete", ghostId });
    const deleted = h.ledger.ghost(ghostId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.state).toBe("retired");
    expect(() => h.ledger.ghost(main.id)).not.toThrow();
  });
});

describe("the installed hierarchy", () => {
  interface Team {
    core: Core;
    ledger: Ledger;
    engine: FakeEngine;
    main: Ghost;
    dev: Ghost;
    other: Ghost;
    use: (conversationId: string, name: string) => (args: unknown, callId: string) => Promise<ToolExecutionResult | ToolPark>;
    tools: ToolSet;
  }

  const team = (): Team => {
    const h = packagesFixture();
    const tools = createToolSet({ core: h.core, sandbox, memory: null, documents: null, skills: null });
    const main = h.core.createGhost({ name: "Main", persona: "You manage the team." });
    const devGhost = h.core.createGhost({ name: "Developer", persona: "Ships code." });
    const other = h.core.createGhost({ name: "Writer", persona: "Writes fiction." });
    const use = (conversationId: string, name: string) => {
      const conversation = h.ledger.conversation(conversationId);
      const ghost = h.ledger.ghost(conversation.ghostId);
      const tool = tools
        .extensionsFor(conversation, ghost, null)
        .flatMap((extension) => extension.tools ?? [])
        .find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`${name} is not offered to ${ghost.name}`);
      return (args: unknown, callId: string) =>
        tool.execute(args as never, { conversationId: `pi-${ghost.name}`, taskId: `task:${callId}`, callId, output: () => {}, diagnostic: () => {} } as unknown as ToolExecutionApi, context());
    };
    return { core: h.core, ledger: h.ledger, engine: h.engine, main, dev: devGhost, other, use, tools };
  };

  const rootWork = async (t: Team, ghost: Ghost) => {
    const work = t.core.works.createRoot({ ghostId: ghost.id, title: `Root of ${ghost.name}`, brief: "Do it", originConversationId: ghost.directConversationId });
    await t.core.idle();
    return work;
  };

  test("an installed Ghost delegates to itself and the main, not to another installed Ghost", async () => {
    const t = team();
    const parent = await rootWork(t, t.dev);
    expect(() => t.core.works.delegate(parent.id, { ghostId: t.other.id, title: "Cross", brief: "No" })).toThrow("Installed Ghosts delegate only to themselves");
    const self = t.core.works.delegate(parent.id, { ghostId: t.dev.id, title: "Own slice", brief: "Yes" });
    expect(self.ghostId).toBe(t.dev.id);
    await t.core.idle();
    const viaMain = t.core.works.delegate(parent.id, { ghostId: t.main.id, title: "Escalate", brief: "Yes" });
    expect(viaMain.ghostId).toBe(t.main.id);
    await t.core.idle();
  });

  test("the main Ghost still delegates to an installed Ghost", async () => {
    const t = team();
    const parent = await rootWork(t, t.main);
    const child = t.core.works.delegate(parent.id, { ghostId: t.dev.id, title: "Hand off", brief: "Yes" });
    expect(child.ghostId).toBe(t.dev.id);
    await t.core.idle();
  });

  test("an installed Ghost cannot start root Work for another Ghost, itself and the main are fine", async () => {
    const t = team();
    t.ledger.setPiConversationId(t.dev.directConversationId, "pi-Developer");
    const create = t.use(t.dev.directConversationId, "work_create");
    expect((await create({ title: "Own", brief: "Mine" }, "own-1")).isError).toBeFalsy();
    expect((await create({ title: "To main", brief: "Yours", ghost_id: t.main.id }, "main-1")).isError).toBeFalsy();
    const refused = await create({ title: "To writer", brief: "Theirs", ghost_id: t.other.id }, "other-1");
    expect(refused.isError).toBe(true);
    expect((refused.output ?? []).map((part) => ("text" in part ? part.text : "")).join("")).toContain("Installed Ghosts delegate only");
    await t.core.idle();
    expect(t.ledger.worksForState().filter((work) => work.title === "To writer")).toHaveLength(0);
  });
});

describe("suggestedScopeIds", () => {
  test("code takes git work trees, documents takes vault scopes outside them, and only the main's scopes count", async () => {
    const h = packagesFixture();
    const main = h.core.createGhost({ name: "Main", persona: "You manage." });
    const root = tempDir();
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    const scope = (id: string, ghostId: string | null, paths: string[], vaultPath: string | null): Scope =>
      ({ id, name: id, ghostId, paths, vaultPath, state: "active", attachments: [], limits: {}, createdAt: Date.now(), updatedAt: Date.now() });
    const scopes = [
      scope("code-main", null, [nested], null),
      scope("code-explicit", main.id, [repo], null),
      scope("code-peer", "someone-else", [repo], null),
      scope("docs-main", null, [plain], plain),
      scope("docs-in-git", null, [repo], repo),
      scope("plain-main", null, [plain], null),
    ];
    const find = (name: string) => ({ ...BUILTIN_PACKAGES.find((pkg) => pkg.name === name)!, origin: "builtin" as const });
    expect(suggestedScopeIds(find("dev"), scopes, main.id)).toEqual(["code-main", "code-explicit", "docs-in-git"]);
    expect(suggestedScopeIds(find("writer"), scopes, main.id)).toEqual(["docs-main"]);
    expect(suggestedScopeIds(find("research"), scopes, main.id)).toEqual([]);
    expect(suggestedScopeIds(find("mac"), scopes, main.id)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    await h.core.idle();
  });
});
