import { describe, expect, test } from "bun:test";
import type { Decision } from "@ghost/contract";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { startServer } from "../src/api/server.ts";
import type { Config } from "../src/config.ts";
import { createDocumentsTools } from "../src/tools/documents.ts";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
    ledger.putScope({ id: "space-1", name: "Garden", paths: [path], vaultPath: path, createdAt: Date.now() , ghostId: null, state: "active", attachments: [], limits: {}, updatedAt: 1 }),
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
  for (const spelling of ["camel", "snake"] as const) test(`applies a durable legacy ${spelling} space proposal without rewriting its approval`, async () => {
    const { documents, ledger, core, ghost } = setup();
    try {
      const page = await documents.readPage("space-1", { locator: "note.md" });
      const proposal = Object.freeze({
        ...(spelling === "camel"
          ? { spaceId: "space-1", pageId: page.pageId, expectedHash: page.hash }
          : { space_id: "space-1", page_id: page.pageId, expected_hash: page.hash }),
        title: "Garden notes", body: "Approved before the scope migration.", profile: "pdc-markdown/1",
      });
      const decision = { ...documentDecision(ghost.id, ghost.directConversationId, proposal), effectId: "legacy-document-effect" };
      const original = JSON.stringify(proposal);
      const digest = sha256(original);
      ledger.tx(() => {
        ledger.putEffect({
          id: decision.effectId, conversationId: ghost.directConversationId, workId: null, callId: `legacy-${spelling}`,
          tool: "document_propose", summary: "Legacy document approval", inputDigest: digest,
          state: "pending", result: null, createdAt: 1, endedAt: null,
        });
        ledger.putDecision(decision);
      });
      const apply: (decision: Decision, authorize: () => void) => Promise<string> = documents.apply.bind(documents);
      await expect(apply(decision, () => {})).resolves.toContain("note.md");
      expect((await documents.readPage("space-1", { locator: "note.md" })).body).toBe("Approved before the scope migration.\n");
      expect(JSON.stringify(decision.proposal)).toBe(original);
      expect(ledger.decision(decision.id).proposal).toEqual(proposal);
      expect(ledger.effect(decision.effectId).inputDigest).toBe(digest);
    } finally { core.stop(); await core.idle(); ledger.close(); }
  });

  test("lists and reads a markdown page", async () => {
    const { documents, ghost, core } = setup();
    const another = core.createGhost({ name: "Another", persona: "" });
    expect(documents.scopesFor(ghost.id).map(space => space.id)).toEqual(["space-1"]);
    expect(documents.scopesFor(another.id).map(space => space.id)).toEqual(["space-1"]);
    core.ledger.tx(() => core.ledger.putGhost({ ...another, state: "paused" }));
    expect(documents.scopesFor(another.id).map(space => space.id)).toEqual(["space-1"]);
    core.ledger.tx(() => core.ledger.putGhost({ ...another, state: "retired" }));
    expect(documents.scopesFor(another.id).map(space => space.id)).toEqual(["space-1"]);

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
    // A plain Markdown file without an envelope stays readable: document_read returns its text, not just a title line.
    expect(plain.body).toBe(PLAIN_MARKDOWN);
  });

  test("the owner API and document_read expose plain and PDC 1 bodies without rewriting sources", async () => {
    const { path, ledger, core, documents, ghost } = setup();
    const htmlBody = "<h1>Legacy HTML</h1>\n<p>Existing project details.</p>\n";
    const legacyHtml = `<!--
---
format: pdc-document/1
body: pdc-html/1
id: 0190f3a0-2222-7abc-8def-0123456789ab
created: 2026-01-02T03:04:05.678Z
updated: 2026-01-02T03:04:05.678Z
title: Old HTML
---
-->
${htmlBody}`;
    writeFileSync(join(path, "legacy.html"), legacyHtml);
    writeFileSync(join(path, "plain.html"), htmlBody);
    const cases = [
      { locator: "plain.md", source: PLAIN_MARKDOWN, body: PLAIN_MARKDOWN },
      { locator: "legacy.djot", source: LEGACY_DJOT, body: "Old _djot_ body.\n" },
      { locator: "legacy.html", source: legacyHtml, body: htmlBody },
      { locator: "plain.html", source: htmlBody, body: htmlBody },
    ];
    const config: Config = {
      root: dirname(path), host: "127.0.0.1", port: 0, publicOrigin: "http://127.0.0.1",
      uiDir: null, sandbox: { kind: "local" }, voice: null, apns: null,
      skills: null, reach: null, browser: null,
    };
    const server = startServer({ core, config, ownerToken: "document-test", documents, skills: null });
    try {
      ledger.setPiConversationId(ghost.directConversationId, "pi-document-read");
      const read = createDocumentsTools(core, documents).tools!.find(tool => tool.name === "document_read")!;
      const base = `http://127.0.0.1:${server.port}/api/scopes/space-1/pages`;
      const headers = { authorization: "Bearer document-test" };
      const listing = await fetch(base, { headers });
      expect(listing.status).toBe(200);
      const pages = await listing.json() as { locator: string; pageId: string }[];
      for (const { locator, source, body } of cases) {
        const page = pages.find(page => page.locator === locator)!;
        expect(page).toBeDefined();
        const response = await fetch(`${base}/${encodeURIComponent(page.pageId)}`, { headers });
        expect(response.status).toBe(200);
        expect((await response.json() as { body: string }).body).toBe(body);
        const result = await read.execute(
          { scope_id: "space-1", page_id: page.pageId } as never,
          { conversationId: "pi-document-read", callId: locator } as unknown as ToolExecutionApi,
          {} as never,
        );
        expect(result.isError).toBeFalsy();
        const text = result.content?.map(block => block.type === "text" ? block.text : "").join("");
        expect(text).toEndWith(`\n\n${body}`);
        expect(readFileSync(join(path, locator), "utf8")).toBe(source);
      }
      expect(readdirSync(path)).not.toContain(".pdc");
    } finally {
      await server.stop();
      core.stop();
      ledger.close();
    }
  });

  test("references the models actually send resolve inside the Scope", async () => {
    const { path, ledger, documents } = setup();
    // A Scope whose root already is the docs folder, like the reported "Talking Stage" Scope,
    // plus a nested docs/ copy of the roadmap so exact locators beat basename matches.
    const docs = join(dirname(path), "talking-stage", "docs");
    mkdirSync(join(docs, "docs"), { recursive: true });
    for (const name of ["wms-ux.md", "DESIGN.md", "RENDERING_UI_BASELINE.md", "TASK_UX_RESEARCH.md", "ROADMAP.md"]) {
      writeFileSync(join(docs, name), PLAIN_MARKDOWN);
    }
    writeFileSync(join(docs, "docs", "ROADMAP.md"), PLAIN_MARKDOWN);
    ledger.tx(() => ledger.putScope({ id: "space-2", name: "Talking Stage", paths: [docs], vaultPath: docs, createdAt: Date.now() , ghostId: null, state: "active", attachments: [], limits: {}, updatedAt: 1 }));

    // A Scope name (case-insensitive) is accepted for scope_id.
    expect((await documents.readPage("talking stage", { locator: "docs/wms-ux.md" })).locator).toBe("wms-ux.md");
    expect((await documents.readPage("TALKING STAGE", { locator: "docs/DESIGN.md?rev=latest" })).locator).toBe("DESIGN.md");
    // An absolute path inside the Scope resolves to its locator.
    expect((await documents.readPage("space-2", { locator: `${docs}/DESIGN.md` })).locator).toBe("DESIGN.md");
    expect((await documents.readPage("space-2", { locator: "docs/DESIGN" })).locator).toBe("DESIGN.md");
    // An extensionless basename finds the file anywhere in the Scope.
    expect((await documents.readPage("space-2", { locator: "RENDERING_UI_BASELINE" })).locator).toBe("RENDERING_UI_BASELINE.md");
    // A filename passed as page_id and a path quoted inside a page_id both resolve.
    expect((await documents.readPage("space-2", { pageId: "TASK_UX_RESEARCH.md" })).locator).toBe("TASK_UX_RESEARCH.md");
    expect((await documents.readPage("space-2", { pageId: "ROADMAP (docs/ROADMAP.md)" })).locator).toBe("docs/ROADMAP.md");
    // Nothing outside the Scope resolves, even by absolute path.
    await expect(documents.readPage("space-2", { locator: `${dirname(docs)}/vault/note.md` })).rejects.toThrow(/closest documents/);
  });

  test("an unresolvable reference names the Scope and its documents without leaking host paths", async () => {
    const { path, documents } = setup();
    const failure = await documents.readPage("space-1", { locator: "docs/DESIGN.md" }).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toContain('Scope "Garden"');
    expect(failure?.message).toContain("legacy.djot, note.md, plain.md");
    expect(failure?.message).not.toContain(path);
    await expect(documents.readPage("space-1", { pageId: "zzz-does-not-exist" })).rejects.toThrow(/Retry with an exact page id/);
    await expect(documents.listPages("Missing Scope", null)).rejects.toThrow(/unknown document space "Missing Scope"; registered Scopes: "Garden" \(space-1\)/);
  });

  test("duplicated ids, escape paths and vault-wide failures cannot silently reroute a read", async () => {
    const { path, ledger, documents } = setup();
    const envelope = (id: string) => `---
format: pdc-document/2
body: pdc-markdown/1
id: ${id}
created: 2026-01-02T03:04:05.678Z
updated: 2026-01-02T03:04:05.678Z
title: Duplicate
---
Body text.
`;
    const uuid = "0190f3a0-1234-7abc-8def-0123456789ab";
    // One Scope holding a duplicated document id, an unrelated oversized file and an ordinary document.
    const dupDocs = join(dirname(path), "dup", "docs");
    mkdirSync(dupDocs, { recursive: true });
    writeFileSync(join(dupDocs, `${uuid}.md`), envelope(uuid));
    writeFileSync(join(dupDocs, "copy.md"), envelope(uuid));
    writeFileSync(join(dupDocs, "DESIGN.md"), PLAIN_MARKDOWN);
    writeFileSync(join(dupDocs, "huge.md"), Buffer.alloc(4 * 1024 * 1024 + 1, 120));
    ledger.tx(() => ledger.putScope({ id: "space-3", name: "Dup", paths: [dupDocs], vaultPath: dupDocs, createdAt: Date.now() , ghostId: null, state: "active", attachments: [], limits: {}, updatedAt: 1 }));

    // The duplicated id is still refused although the oversized file aborts a whole-vault projection.
    await expect(documents.readPage("space-3", { pageId: uuid })).rejects.toThrow(new RegExp(`is used by several files \\(${uuid}\\.md, copy\\.md\\)`));
    await expect(documents.readPage("space-3", { locator: uuid })).rejects.toThrow(/is used by several files/);
    // An absolute path outside the Scope and a `..` segment refuse instead of matching an in-Scope namesake.
    await expect(documents.readPage("space-3", { locator: "/outside/DESIGN.md" })).rejects.toThrow(/no document in Scope "Dup" matches/);
    await expect(documents.readPage("space-3", { locator: "../DESIGN.md" })).rejects.toThrow(/no document in Scope "Dup" matches/);
    // The unreadable file elsewhere does not abort a read of an unrelated document...
    expect((await documents.readPage("space-3", { locator: "DESIGN.md" })).locator).toBe("DESIGN.md");
    // ...and the oversized file itself fails with its own honest error.
    await expect(documents.readPage("space-3", { locator: "huge.md" })).rejects.toThrow(/document_too_large/);
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
          scopeId: "space-1",
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
        scopeId: "space-1",
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
        scopeId: "space-1",
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
        scopeId: "space-1",
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
          scopeId: "space-1",
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
          scopeId: "space-1",
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
        scopeId: "space-1",
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
        scopeId: "space-1",
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
      scopeId: "space-1",
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
      scopeId: "space-1",
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
        scopeId: "space-1",
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
      scopeId: "space-1", title: "Watering plan", body: "Water the tomatoes.",
      profile: "pdc-markdown/1", pageId: null, expectedHash: null,
    });
    const before = readdirSync(path);
    await expect(documents.apply({ ...decision, state: "pending" })).rejects.toThrow(/only an approved/);
    expect(readdirSync(path)).toEqual(before);
    await expect(documents.apply(decision)).resolves.toContain("Watering plan");
  });
});
