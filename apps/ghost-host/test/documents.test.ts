import { describe, expect, test } from "bun:test";
import type { Decision } from "@ghost/contract";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/core/ids.ts";
import { createDocuments } from "../src/integrations/documents.ts";
import { harness, tempDir } from "./support.ts";

const CANONICAL_NOTE = `---
format: pdc-document/2
body: pdc-markdown/1
id: 0190f3a0-1234-7abc-8def-0123456789ab
created: 2026-01-02T03:04:05.678Z
updated: 2026-01-02T03:04:05.678Z
title: "Garden notes"
---
The tomatoes need water.
`;

const LEGACY_DJOT = `---
format: pdc-document/1
body: pdc-djot/1
id: 0190f3a0-1111-7abc-8def-0123456789ab
created: 2026-01-02T03:04:05.678Z
updated: 2026-01-02T03:04:05.678Z
title: Old note
---
Old _djot_ body.
`;

const PLAIN_MARKDOWN = "# Just a note\n\nNo PDC envelope here.\n";

function vault() {
  const root = tempDir();
  const path = join(root, "vault");
  mkdirSync(path);
  writeFileSync(join(path, "note.md"), CANONICAL_NOTE);
  writeFileSync(join(path, "legacy.djot"), LEGACY_DJOT);
  writeFileSync(join(path, "plain.md"), PLAIN_MARKDOWN);
  return path;
}

function setup() {
  const path = vault();
  const { ledger, core, engine } = harness();
  const ghost = core.createGhost({ name: "Tester", persona: "A tester." });
  ledger.tx(() =>
    ledger.putSpace({ id: "space-1", name: "Garden", path, createdAt: Date.now() }),
  );
  const documents = createDocuments(core);
  return { path, ledger, core, engine, documents, ghost };
}

function documentDecision(ghostId: string, conversationId: string, proposal: Record<string, unknown>): Decision {
  return {
    id: "decision-1",
    kind: "document_review",
    ghostId,
    conversationId,
    workId: null,
    effectId: null,
    title: "Save the document?",
    detail: "A document proposal.",
    options: [],
    proposal,
    state: "approved",
    answer: null,
    createdAt: Date.now(),
    resolvedAt: Date.now(),
  };
}

describe("documents", () => {
  test("lists and reads a markdown page", async () => {
    const { documents, ghost, core } = setup();
    const another = core.createGhost({ name: "Another", persona: "" });
    expect(documents.spacesFor(ghost.id).map(space => space.id)).toEqual(["space-1"]);
    expect(documents.spacesFor(another.id).map(space => space.id)).toEqual(["space-1"]);
    core.ledger.tx(() => core.ledger.putGhost({ ...another, state: "paused" }));
    expect(documents.spacesFor(another.id).map(space => space.id)).toEqual(["space-1"]);
    core.ledger.tx(() => core.ledger.putGhost({ ...another, state: "retired" }));
    expect(documents.spacesFor(another.id).map(space => space.id)).toEqual(["space-1"]);

    const pages = await documents.listPages("space-1", null);

    expect(pages.map((page) => page.locator)).toEqual(["legacy.djot", "note.md", "plain.md"]);
    const note = pages.find((page) => page.locator === "note.md");
    expect(note?.title).toBe("Garden notes");
    expect(note?.profile).toBe("pdc-markdown/1");

    const page = await documents.readPage("space-1", { locator: "note.md" });
    expect(page.body).toBe("The tomatoes need water.\n");
    expect(page.hash).toBe(sha256(CANONICAL_NOTE));
    expect(page.profile).toBe("pdc-markdown/1");
  });

  test("a legacy page stays readable and is never a PDC 2 document", async () => {
    const { documents } = setup();

    const djot = await documents.readPage("space-1", { locator: "legacy.djot" });
    expect(djot.profile).toBe("pdc-djot/1");
    expect(djot.body).toContain("Old _djot_ body.");

    const plain = await documents.readPage("space-1", { locator: "plain.md" });
    expect(plain.profile).toBe("unclassified");
  });

  test("an approved decision writes a new page", async () => {
    const { path, core, engine, ghost } = setup();

    const decision = core.ledger.tx(() =>
      core.decisions.open({
        kind: "document_review",
        ghostId: ghost.id,
        conversationId: ghost.directConversationId,
        workId: null,
        effectId: null,
        title: "Save the document?",
        detail: "A document proposal.",
        options: [],
        proposal: {
          spaceId: "space-1",
          title: "Watering plan",
          body: "Water the tomatoes on Monday.",
          profile: "pdc-markdown/1",
          pageId: null,
          expectedHash: null,
        },
      }),
    );

    await core.decisions.resolve(decision.id, { outcome: "approve" });

    const written = readdirSync(path).filter((name) => name.endsWith(".md") && name !== "note.md" && name !== "plain.md");
    expect(written).toHaveLength(1);
    const source = readFileSync(join(path, written[0]!), "utf8");
    expect(source).toContain("format: pdc-document/2");
    expect(source).toContain("body: pdc-markdown/1");
    expect(source).toContain('title: "Watering plan"');
    expect(source).toContain("Water the tomatoes on Monday.\n");
    expect(JSON.parse(readFileSync(join(path, ".pdc/vault.json"), "utf8"))["format"]).toBe("pdc-vault/1");

    const submission = engine.to(ghost.directConversationId)[0];
    expect(submission?.text).toContain("Watering plan");
  });

  test("a new page is written as PDC 2 and listed afterwards", async () => {
    const { documents, ghost } = setup();

    const line = await documents.apply(
      documentDecision(ghost.id, ghost.directConversationId, {
        spaceId: "space-1",
        title: "Compost notes",
        body: "Turn the compost on Sunday.",
        profile: "pdc-markdown/1",
        pageId: null,
        expectedHash: null,
      }),
    );

    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("Compost notes");
    const pages = await documents.listPages("space-1", "Compost");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.profile).toBe("pdc-markdown/1");
  });

  test("updates a canonical page in place, keeping its profile", async () => {
    const { documents, path, ghost } = setup();
    const page = await documents.readPage("space-1", { locator: "note.md" });

    const line = await documents.apply(
      documentDecision(ghost.id, ghost.directConversationId, {
        spaceId: "space-1",
        title: "Garden notes",
        body: "The tomatoes need more water.",
        profile: "pdc-markdown/1",
        pageId: page.pageId,
        expectedHash: page.hash,
      }),
    );

    expect(line).toContain("note.md");
    const source = readFileSync(join(path, "note.md"), "utf8");
    expect(source).toContain("body: pdc-markdown/1");
    expect(source).toContain("title: Garden notes");
    expect(source).toContain("The tomatoes need more water.\n");
    expect(source).not.toContain("The tomatoes need water.\n");
    const updated = await documents.readPage("space-1", { locator: "note.md" });
    expect(updated.hash).not.toBe(page.hash);
    expect(updated.body).toBe("The tomatoes need more water.\n");
  });

  test("refuses an edit whose hash is stale", async () => {
    const { documents, path, ghost } = setup();
    const page = await documents.readPage("space-1", { locator: "note.md" });
    writeFileSync(join(path, "note.md"), `${CANONICAL_NOTE}An outside editor changed this file.\n`);

    await expect(
      documents.check({
        spaceId: "space-1",
        title: "Garden notes",
        body: "The tomatoes need more water.",
        profile: "pdc-markdown/1",
        pageId: page.pageId,
        expectedHash: page.hash,
      }),
    ).rejects.toThrow(/external_change_conflict/);

    await expect(
      documents.apply(
        documentDecision(ghost.id, ghost.directConversationId, {
          spaceId: "space-1",
          title: "Garden notes",
          body: "The tomatoes need more water.",
          profile: "pdc-markdown/1",
          pageId: page.pageId,
          expectedHash: page.hash,
        }),
      ),
    ).rejects.toThrow(/external_change_conflict/);

    expect(readFileSync(join(path, "note.md"), "utf8")).toContain("An outside editor changed this file.");
  });

  test("refuses to edit a legacy Djot page", async () => {
    const { documents, path, ghost } = setup();
    const page = await documents.readPage("space-1", { locator: "legacy.djot" });

    await expect(
      documents.apply(
        documentDecision(ghost.id, ghost.directConversationId, {
          spaceId: "space-1",
          title: "Old note",
          body: "New body.",
          profile: "pdc-markdown/1",
          pageId: page.pageId,
          expectedHash: page.hash,
        }),
      ),
    ).rejects.toThrow(/legacy_document_read_only/);

    expect(readFileSync(join(path, "legacy.djot"), "utf8")).toBe(LEGACY_DJOT);
  });

  test("refuses a proposal that is not a PDC 2 profile", async () => {
    const { documents } = setup();

    await expect(
      documents.check({
        spaceId: "space-1",
        title: "Old note",
        body: "New body.",
        profile: "pdc-djot/1",
        pageId: null,
        expectedHash: null,
      }),
    ).rejects.toThrow(/PDC 2/);
  });

  test("refuses an edit that would change the page's body profile", async () => {
    const { documents } = setup();
    const page = await documents.readPage("space-1", { locator: "note.md" });

    await expect(
      documents.check({
        spaceId: "space-1",
        title: "Garden notes",
        body: "<p>The tomatoes need more water.</p>",
        profile: "pdc-html/1",
        pageId: page.pageId,
        expectedHash: page.hash,
      }),
    ).rejects.toThrow(/body profile/);
  });

  test("save writes a new page and returns it", async () => {
    const { documents, path } = setup();

    const page = await documents.save({
      spaceId: "space-1",
      title: "Pruning notes",
      body: "Prune the roses in March.",
      profile: "pdc-markdown/1",
      pageId: null,
      expectedHash: null,
    });

    expect(page.pageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(page.locator).toBe(`${page.pageId}.md`);
    expect(page.title).toBe("Pruning notes");
    expect(page.profile).toBe("pdc-markdown/1");
    expect(page.body).toBe("Prune the roses in March.\n");
    expect(page.hash).toBe(sha256(readFileSync(join(path, page.locator))));
    const source = readFileSync(join(path, page.locator), "utf8");
    expect(source).toContain("format: pdc-document/2");
    expect(source).toContain(`id: ${page.pageId}`);
  });

  test("save edits a page in place and returns it", async () => {
    const { documents, path } = setup();
    const before = await documents.readPage("space-1", { locator: "note.md" });

    const page = await documents.save({
      spaceId: "space-1",
      title: "Garden notes",
      body: "The tomatoes need shade cloth.",
      profile: "pdc-markdown/1",
      pageId: before.pageId,
      expectedHash: before.hash,
    });

    expect(page.pageId).toBe(before.pageId);
    expect(page.locator).toBe("note.md");
    expect(page.body).toBe("The tomatoes need shade cloth.\n");
    expect(page.hash).not.toBe(before.hash);
    expect(page.hash).toBe(sha256(readFileSync(join(path, "note.md"))));
    expect(readFileSync(join(path, "note.md"), "utf8")).toContain("body: pdc-markdown/1");
  });

  test("save refuses a stale hash", async () => {
    const { documents, path } = setup();
    const before = await documents.readPage("space-1", { locator: "note.md" });
    writeFileSync(join(path, "note.md"), `${CANONICAL_NOTE}An outside editor changed this file.\n`);

    await expect(
      documents.save({
        spaceId: "space-1",
        title: "Garden notes",
        body: "The tomatoes need shade cloth.",
        profile: "pdc-markdown/1",
        pageId: before.pageId,
        expectedHash: before.hash,
      }),
    ).rejects.toThrow(/external_change_conflict/);

    expect(readFileSync(join(path, "note.md"), "utf8")).toContain("An outside editor changed this file.");
  });

  test("every Ghost can apply an owner-approved proposal but pending proposals cannot write", async () => {
    const { documents, core, path } = setup();
    const ghost = core.createGhost({ name: "New Ghost", persona: "" });
    const decision = documentDecision(ghost.id, ghost.directConversationId, {
      spaceId: "space-1", title: "Watering plan", body: "Water the tomatoes.",
      profile: "pdc-markdown/1", pageId: null, expectedHash: null,
    });
    const before = readdirSync(path);
    await expect(documents.apply({ ...decision, state: "pending" })).rejects.toThrow(/only an approved/);
    expect(readdirSync(path)).toEqual(before);
    await expect(documents.apply(decision)).resolves.toContain("Watering plan");
  });
});
