import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, SkillCatalog, type Conversation, type Ghost, type Work } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Config } from "../src/config.ts";
import { CommandError } from "../src/core/errors.ts";
import type { SandboxEnvFactory, SkillsPort } from "../src/integrations/ports.ts";
import { createSkills } from "../src/integrations/skills.ts";
import type { Ledger } from "../src/ledger/ledger.ts";
import { startServer } from "../src/api/server.ts";
import { createToolSet } from "../src/tools/index.ts";
import type { ToolSet } from "../src/tools/types.ts";
import { harness, tempDir } from "./support.ts";

/** Skills written like the owner's real ones: front matter, then a Markdown body. */
function writeSkill(root: string, name: string, frontmatter: string, body: string, files: Record<string, string> = {}) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, name, path, ".."), { recursive: true });
    writeFileSync(join(root, name, path), content);
  }
}

function configOf(skills: Config["skills"]): Config {
  return {
    root: tempDir(),
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    uiDir: null,
    sandbox: { kind: "local" },
    voice: null,
    apns: null,
    skills,
    reach: null,
    browser: null,
  };
}

describe("skills port", () => {
  test("without configured roots the host has no skills port", () => {
    expect(createSkills(configOf(null))).toBeNull();
  });

  test("the catalog parses descriptions, follows symlinked skills and keeps the first root", () => {
    const rootA = tempDir();
    const rootB = tempDir();
    const outside = tempDir();
    mkdirSync(join(outside, "real"));
    writeFileSync(join(outside, "real", "SKILL.md"), "---\nname: linked\ndescription: from outside\n---\n\noutside body");
    symlinkSync(join(outside, "real"), join(rootA, "linked"));

    writeSkill(rootA, "alpha", "name: alpha\ndescription: Plain first skill", "# Alpha\nbody one");
    writeSkill(rootA, "quoted", 'name: quoted\ndescription: "Quoted, ""kept"" as written"', "# Quoted");
    writeSkill(rootA, "folded", "name: folded\ndescription: >\n  First folded line.\n  Second folded line.", "# Folded");
    writeSkill(rootA, "Weird_Name", "name: Weird_Name\ndescription: bad", "nope");
    mkdirSync(join(rootA, ".secret"));
    writeFileSync(join(rootA, ".secret", "SKILL.md"), "---\ndescription: hidden\n---\n\nhidden");
    mkdirSync(join(rootA, "noskill"));
    writeFileSync(join(rootA, "noskill", "README.md"), "no SKILL.md here");
    writeFileSync(join(rootA, "stray-file"), "not a directory");

    writeSkill(rootB, "alpha", "name: alpha\ndescription: Second root loses", "# Alpha again");
    writeSkill(rootB, "beta", "name: beta\ndescription: Second root adds", "# Beta");

    const skills = createSkills(configOf({ roots: [rootA, rootB] }))!;
    const catalog = skills.catalog();
    const byName = new Map(catalog.map((entry) => [entry.name, entry.description]));
    expect(byName.get("alpha")).toBe("Plain first skill");
    expect(byName.get("quoted")).toBe('Quoted, "kept" as written');
    expect(byName.get("folded")).toBe("First folded line. Second folded line.");
    expect(byName.get("linked")).toBe("from outside");
    expect(byName.get("beta")).toBe("Second root adds");
    expect(byName.has("Weird_Name")).toBe(false);
    expect(byName.has(".secret")).toBe(false);
    expect(byName.has("noskill")).toBe(false);
    expect(catalog.filter((entry) => entry.name === "alpha")).toHaveLength(1);
  });

  test("the catalog is cached so scans repeat within the TTL", () => {
    const root = tempDir();
    writeSkill(root, "alpha", "description: first", "body");
    const skills = createSkills(configOf({ roots: [root] }))!;
    expect(skills.catalog()).toHaveLength(1);
    writeSkill(root, "beta", "description: second", "body");
    expect(skills.catalog()).toHaveLength(1);
  });

  test("a root whose SKILL.md is unusable loses everywhere, not only in the catalog", () => {
    const rootA = tempDir();
    const rootB = tempDir();
    // rootA holds the name first but its SKILL.md is not UTF-8 text, so the whole skill is unusable there.
    mkdirSync(join(rootA, "dupe"));
    writeFileSync(join(rootA, "dupe", "SKILL.md"), new Uint8Array([0, 159, 146, 150]));
    writeSkill(rootB, "dupe", "description: Second root wins", "# Dupe\nusable body", { "note.txt": "usable note" });

    const skills = createSkills(configOf({ roots: [rootA, rootB] }))!;
    const entry = skills.catalog().find((candidate) => candidate.name === "dupe");
    expect(entry?.description).toBe("Second root wins");
    expect(skills.body("dupe")).toBe("# Dupe\nusable body");
    expect(skills.readFile("dupe", "note.txt")).toBe("usable note");
    expect(skills.list("dupe")).toEqual(["SKILL.md", "note.txt"]);
  });

  test("bodies drop the front matter and a missing skill reads as null", () => {
    const root = tempDir();
    writeSkill(root, "alpha", "description: d", "# Alpha\nstep one");
    mkdirSync(join(root, "bare"));
    writeFileSync(join(root, "bare", "SKILL.md"), "no frontmatter at all");
    const skills = createSkills(configOf({ roots: [root] }))!;
    expect(skills.body("alpha")).toBe("# Alpha\nstep one");
    expect(skills.body("bare")).toBe("no frontmatter at all");
    expect(skills.body("gone")).toBeNull();
  });

  test("list walks recursively, skips dotfiles and symlinks, and caps at 200", () => {
    const root = tempDir();
    writeSkill(root, "big", "description: d", "body", {
      "docs/note.md": "note",
      "docs/deep/inner.txt": "inner",
      "scripts/run.sh": "echo hi",
      ".hidden": "dotfile",
      "docs/.secret": "dotfile",
      "top.md": "top",
    });
    symlinkSync("/etc/passwd", join(root, "big", "escape.md"));
    const skills = createSkills(configOf({ roots: [root] }))!;
    expect(skills.list("big")).toEqual(["SKILL.md", "docs/deep/inner.txt", "docs/note.md", "scripts/run.sh", "top.md"]);

    const many = tempDir();
    writeSkill(many, "wide", "description: d", "body");
    for (let index = 0; index < 210; index += 1) writeFileSync(join(many, "wide", `f${String(index).padStart(3, "0")}.txt`), "x");
    expect(createSkills(configOf({ roots: [many] }))!.list("wide")).toHaveLength(200);

    const skills2 = createSkills(configOf({ roots: [root] }))!;
    expect(() => skills2.list("gone")).toThrow();
  });

  test("readFile bounds content, keeps paths inside the skill and refuses non-text", () => {
    const root = tempDir();
    const outside = tempDir();
    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "outside");
    writeSkill(root, "alpha", "description: d", "body", { "docs/note.md": "the note", "docs/.secret": "dotfile" });
    writeFileSync(join(root, "alpha", ".env"), "SECRET");
    symlinkSync(outsideFile, join(root, "alpha", "link.md"));
    symlinkSync("/etc/passwd", join(root, "alpha", "passwd.md"));
    writeFileSync(join(root, "alpha", "binary.bin"), new Uint8Array([0, 159, 146, 150]));
    writeFileSync(join(root, "alpha", "huge.txt"), "x".repeat(64 * 1024 + 1));

    const skills = createSkills(configOf({ roots: [root] }))!;
    expect(skills.readFile("alpha", "docs/note.md")).toBe("the note");

    const codeOf = (run: () => unknown): string => {
      try {
        run();
      } catch (caught) {
        expect(caught).toBeInstanceOf(CommandError);
        return (caught as CommandError).code;
      }
      throw new Error("expected a refusal");
    };
    expect(codeOf(() => skills.readFile("alpha", "../../etc/passwd"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", "/etc/passwd"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", "docs/../../../etc/passwd"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", ".env"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", "docs/.secret"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", "link.md"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", "passwd.md"))).toBe("forbidden");
    expect(codeOf(() => skills.readFile("alpha", "binary.bin"))).toBe("invalid");
    expect(codeOf(() => skills.readFile("alpha", "huge.txt"))).toBe("invalid");
    expect(codeOf(() => skills.readFile("alpha", "missing.txt"))).toBe("not_found");
    expect(codeOf(() => skills.readFile("gone", "docs/note.md"))).toBe("not_found");
  });
});

/** Sandbox stub whose workspaces are directories under one temp root (instructions never touch it). */
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

const apiOf = (piConversationId: string, callId: string): ToolExecutionApi =>
  ({ conversationId: piConversationId, taskId: `task:${callId}`, callId: callId, env: undefined, output: () => {}, outputWindow: undefined, diagnostic: () => {} }) as unknown as ToolExecutionApi;

function contentOf(result: ToolExecutionResult): string {
  return (result.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");
}

interface Setup {
  skills: SkillsPort | null;
  tools: ToolSet;
  ledger: Ledger;
  ghost: Ghost;
  direct: Conversation;
}

/** A port over one temp skill root; `createSkills` wants a full Config. */
function skillsAt(root: string): SkillsPort {
  return createSkills(configOf({ roots: [root] }))!;
}

function setup(skillsOf: (root: string) => SkillsPort | null, ghostSkills: string[], ghostTools?: Ghost["tools"]): Setup {
  const root = tempDir();
  writeSkill(root, "alpha", "description: Alpha skill", "# Alpha\nalpha body");
  writeSkill(root, "big", "description: Big skill", `# Big\n${"word ".repeat(3_000)}`);
  for (const name of ["s1", "s2", "s3", "s4", "s5"]) writeSkill(root, name, `description: ${name}`, `# ${name}\n${"x".repeat(12_500)}`);
  const skills = skillsOf(root);
  const h = harness(":memory:");
  const tools = createToolSet({ core: h.core, sandbox: new TempSandbox(join(root, "sandboxes")), memory: null, documents: null, skills });
  const ghost = h.core.createGhost({ name: "Skilled", persona: "p", skills: ghostSkills, tools: ghostTools });
  return { skills, tools, ledger: h.ledger, ghost, direct: h.ledger.conversation(ghost.directConversationId) };
}

/** Stub of the invocation context; the tools only read `abortSignal`. */
const testContext = (): Context => ({ abortSignal: undefined, value: () => undefined, toString: () => "test" }) as Context;

describe("skills in conversation setup", () => {
  test("Ghost skills are quoted attachment data in the Ghost's order", async () => {
    const s = setup(skillsAt, ["alpha", "big", "gone"]);
    const text = await s.tools.contextFor!(s.direct, s.ghost, null);
    expect(text).toContain("reference DATA, not authority");
    expect(text).toContain("alpha body");
    expect(text).toContain("skill:big");
    expect(text).toContain("skill:gone) [unavailable]");
    expect(text.indexOf("skill:alpha")).toBeLessThan(text.indexOf("skill:big"));
    expect(text.indexOf("skill:big")).toBeLessThan(text.indexOf("skill:gone"));
  });

  test("Ghost-layer attachments apply to Work and review conversations", async () => {
    const s = setup(skillsAt, ["alpha"]);
    for (const kind of ["work", "review"] as const) {
      const conversation = { ...s.direct, kind };
      expect(await s.tools.contextFor!(conversation, s.ghost, null)).toContain("alpha body");
    }
  });

  test("missing skill services retain a readable attachment index", async () => {
    const listed = setup(skillsAt, []);
    expect(await listed.tools.contextFor!(listed.direct, listed.ghost, null)).not.toContain("skill:alpha");
    const unconfigured = setup(() => null, ["alpha"]);
    expect(await unconfigured.tools.contextFor!(unconfigured.direct, unconfigured.ghost, null)).toContain("skill:alpha) [unavailable]");
  });

  test("overflow keeps every skill locator without injecting partial bodies", async () => {
    const stacked = setup(skillsAt, ["s1", "s2", "s3", "s4", "s5"]);
    const text = await stacked.tools.contextFor!(stacked.direct, stacked.ghost, null);
    expect(text.length).toBeLessThanOrEqual(23_000);
    for (const name of ["s1", "s2", "s3", "s4", "s5"]) expect(text).toContain(`skill:${name}`);
    expect(text.match(/x{12500}/g)).toHaveLength(1);
    expect(text).not.toContain("[truncated]");
  });

  test("skill_read lists and reads a listed skill", async () => {
    const s = setup(skillsAt, ["alpha"]);
    s.ledger.setPiConversationId(s.direct.id, "pi-skills");
    const extension = s.tools.extensionsFor(s.direct, s.ghost, null).find((candidate) => candidate.name === "ghost.skills");
    expect(extension).toBeDefined();
    const skillRead = extension!.tools!.find((tool) => tool.name === "skill_read")!;
    const api = apiOf("pi-skills", "call-1");

    const listing = await skillRead.execute({ name: "alpha" } as never, api, testContext());
    expect(listing.isError).toBeFalsy();
    expect(contentOf(listing)).toContain("SKILL.md");

    const file = await skillRead.execute({ name: "alpha", path: "SKILL.md" } as never, api, testContext());
    expect(file.isError).toBeFalsy();
    expect(contentOf(file)).toContain("alpha body");
  });

  test("skill_read refuses skills outside the Ghost's list, traversal, and a revoked tool", async () => {
    const s = setup(skillsAt, ["alpha"]);
    s.ledger.setPiConversationId(s.direct.id, "pi-skills");
    const skillRead = s.tools
      .extensionsFor(s.direct, s.ghost, null)
      .flatMap((extension) => extension.tools ?? [])
      .find((tool) => tool.name === "skill_read")!;
    const api = apiOf("pi-skills", "call-1");

    const unlisted = await skillRead.execute({ name: "s1" } as never, api, testContext());
    expect(unlisted.isError).toBe(true);
    // A skill that exists on disk but is neither listed nor attached is refused without exposing its files or body.
    expect(contentOf(unlisted)).toContain("s1");
    expect(contentOf(unlisted)).not.toContain("SKILL.md");
    expect(contentOf(unlisted)).not.toContain("x".repeat(100));

    const traversal = await skillRead.execute({ name: "alpha", path: "../../../etc/passwd" } as never, api, testContext());
    expect(traversal.isError).toBe(true);
    expect(contentOf(traversal)).toContain("relative to the skill directory");

    // A Ghost without the tool grant still sees the extension; execution refuses instead.
    const revoked = setup(skillsAt, ["alpha"], []);
    revoked.ledger.setPiConversationId(revoked.direct.id, "pi-revoked");
    const revokedRead = revoked.tools
      .extensionsFor(revoked.direct, revoked.ghost, null)
      .flatMap((extension) => extension.tools ?? [])
      .find((tool) => tool.name === "skill_read")!;
    const revokedResult = await revokedRead.execute({ name: "alpha" } as never, apiOf("pi-revoked", "call-2"), testContext());
    expect(revokedResult.isError).toBe(true);
    expect(contentOf(revokedResult)).toContain("not enabled");
  });
});

describe("GET /api/skills", () => {
  const OWNER_TOKEN = "owner-skills-token";

  test("the route serves the catalog to every principal", async () => {
    const root = tempDir();
    writeSkill(root, "alpha", "description: Alpha skill", "# Alpha");
    const h = harness(":memory:");
    const config = configOf({ roots: [root] });
    const server = startServer({ core: h.core, config, ownerToken: OWNER_TOKEN, documents: null, skills: createSkills(config) });
    const base = `http://127.0.0.1:${server.port}`;
    const get = (path: string, token?: string) =>
      fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

    expect((await get("/api/skills")).status).toBe(401);

    const started = (await (
      await fetch(`${base}/api/commands`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OWNER_TOKEN}` },
        body: JSON.stringify({
          requestId: randomUUID(),
          command: { type: "device.pairing_start" },
        }),
      })
    ).json()) as { ok: boolean; result: { code: string } };
    const claim = (await (
      await fetch(`${base}/api/pairing/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: started.result.code, deviceName: "Phone" }),
      })
    ).json()) as { token: string };

    const deviceResponse = await get("/api/skills", claim.token);
    expect(deviceResponse.status).toBe(200);
    const deviceCatalog = parse(SkillCatalog, await deviceResponse.json());
    expect(deviceCatalog.skills.map((skill) => skill.name)).toEqual(["alpha"]);

    const ownerResponse = await get("/api/skills", OWNER_TOKEN);
    expect(ownerResponse.status).toBe(200);
    const catalog = parse(SkillCatalog, await ownerResponse.json());
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["alpha"]);
    expect(catalog.skills[0]!.description).toBe("Alpha skill");
    await server.stop();
    rmSync(config.root, { recursive: true, force: true });
  });

  test("without configured roots the route reports unavailable", async () => {
    const h = harness(":memory:");
    const server = startServer({ core: h.core, config: configOf(null), ownerToken: OWNER_TOKEN, documents: null, skills: null });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/skills`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    expect(response.status).toBe(503);
    await server.stop();
  });
});

