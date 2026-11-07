import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/core/ids.ts";
import {
  classifyDocument,
  createDocuments,
  patchDocumentMetadata,
  saveGuarded,
  type PdcClassification,
} from "../src/integrations/documents.ts";
import { harness } from "./support.ts";

/**
 * The vendored PDC conformance corpora, byte-identical to the canonical
 * `portable-document-contract` repository (the same gate the Rust host ran):
 *
 * - `pdc-corpus-r3` — the frozen legacy v1 corpus
 *   (`pdc-document-conformance/1`, revision 3);
 * - `pdc-corpus-v2-r2` — the Markdown-first corpus
 *   (`pdc-document-conformance/2`, revision 2), which also carries v1
 *   readability cases and `pdc-query/1` classification cases.
 *
 * `.base` query files are not a claimed Ghost surface (docs/pdc-adoption.md);
 * their cases are skipped and pinned by name. Mutator cases on PDC 1 sources
 * are asserted as Ghost's documented `legacy_document_read_only` refusal.
 */
const V1_DIR = join(import.meta.dir, "fixtures", "pdc-corpus-r3");
const V2_DIR = join(import.meta.dir, "fixtures", "pdc-corpus-v2-r2");
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

interface CorpusCase {
  id: string;
  kind: "file" | "set" | "operation";
  path?: string;
  paths?: string[];
  expect?: string;
  operation?: string;
  input?: string;
  external?: string;
  expected?: string;
  patch?: Record<string, string>;
  prefixHex?: string;
  totalBytes?: number;
  depth?: number;
  containerDepth?: number;
}

interface Corpus {
  format: string;
  revision: number;
  queryContract?: string;
  cases: CorpusCase[];
}

function corpusOf(dir: string): Corpus {
  return JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8")) as Corpus;
}

function readBytes(dir: string, rel: string): Uint8Array {
  return readFileSync(join(dir, rel));
}

function readText(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), "utf8");
}

function decodeHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** v2 corpus extension mapping; `.base` files are query-plane cases. */
function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1).toLowerCase();
}

function expectOutcome(id: string, classified: PdcClassification, expectation: string, validAllowsLegacy: boolean): void {
  switch (expectation) {
    case "valid":
      expect(classified.outcome).toBe("valid");
      if (!validAllowsLegacy && classified.outcome === "valid") expect(classified.legacy).toBe(false);
      return;
    case "legacy_valid":
      expect(classified.outcome).toBe("valid");
      if (classified.outcome === "valid") expect(classified.legacy).toBe(true);
      return;
    case "legacy_html":
    case "legacy_markdown":
      expect(classified.outcome).toBe(expectation);
      return;
    default:
      expect(classified.outcome).toBe("invalid");
      if (classified.outcome === "invalid") expect(classified.diagnostic.kind as string).toBe(expectation);
      return;
  }
}

// The mutator refusals run against the real port over per-case vaults.
const { ledger, core } = harness();
const documents = createDocuments(core);

/**
 * Ghost's mutator covers canonical PDC 2 bodies only: a write that targets a
 * PDC 1 source is refused, however harmless the write would be.
 */
async function expectLegacyWriteRefused(dir: string, caseId: string, input: string): Promise<void> {
  const bytes = readBytes(dir, input);
  const locator = `corpus.${extensionOf(input)}`;
  // A fresh vault per case: corpora reuse document ids across revisions.
  const path = mkdtempSync(join(tmpdir(), "ghost-pdc-mutator-"));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, locator), bytes);
  const spaceId = `space-${caseId.replace(/[^a-z0-9-]/gi, "-")}`;
  ledger.tx(() =>
    ledger.putSpace({
      id: spaceId,
      name: caseId,
      path,
      grants: [{ ghostId: "ghost-corpus", mode: "propose" }],
      createdAt: Date.now(),
    }),
  );
  const classified = classifyDocument(locator, bytes);
  expect(classified.outcome).toBe("valid");
  if (classified.outcome !== "valid") return;
  expect(classified.legacy).toBe(true);
  await expect(
    documents.check({
      spaceId,
      title: "Corpus case",
      body: "A body that would overwrite the legacy source.",
      profile: "pdc-markdown/1",
      pageId: classified.documentId,
      expectedHash: sha256(bytes),
    }),
  ).rejects.toThrow(/legacy_document_read_only/);
}

/** The YAML-mapping envelope of exactly `depth` combined levels (root included). */
function yamlMappingEnvelope(depth: number): Uint8Array {
  let text = "---\na:\n";
  for (let level = 1; level <= depth - 2; level++) text += `${" ".repeat(2 * level)}b:\n`;
  text += `${" ".repeat(2 * (depth - 1))}leaf: 1\n---\n\nbody\n`;
  return new TextEncoder().encode(text);
}

/** Registers one test per corpus case; returns the skipped case ids. */
function runCorpus(label: string, dir: string, expectedFormat: string, expectedRevision: number, validAllowsLegacy: boolean): string[] {
  const corpus = corpusOf(dir);
  expect(corpus.format).toBe(expectedFormat);
  expect(corpus.revision).toBe(expectedRevision);
  expect(corpus.cases.length).toBeGreaterThan(0);
  const skipped: string[] = [];

  for (const item of corpus.cases) {
    if (item.kind === "file" && item.path?.endsWith(".base")) {
      skipped.push(item.id);
      continue;
    }
    test(`${label}: ${item.id}`, async () => {
      switch (item.kind) {
        case "file": {
          const classified = classifyDocument(item.path!, readBytes(dir, item.path!));
          expectOutcome(item.id, classified, item.expect!, validAllowsLegacy);
          return;
        }
        case "set": {
          const ids = (item.paths ?? []).map((path) => {
            const classified = classifyDocument(path, readBytes(dir, path));
            expect(classified.outcome).toBe("valid");
            return classified.outcome === "valid" ? classified.documentId : "";
          });
          expect(new Set(ids).size).toBeLessThan(ids.length);
          expect(item.expect).toBe("duplicate_document_id");
          return;
        }
        case "operation":
          break;
        default:
          throw new Error(`${item.id}: unknown corpus case kind \`${item.kind}\``);
      }

      const input = item.input!;
      const bytes = readBytes(dir, input);
      const classified = classifyDocument(input, bytes);
      const legacySource = classified.outcome === "valid" && classified.legacy;

      switch (item.operation) {
        case "prefix-source-bytes": {
          const prefix = decodeHex(item.prefixHex!);
          const mutated = new Uint8Array(prefix.length + bytes.length);
          mutated.set(prefix);
          mutated.set(bytes, prefix.length);
          expectOutcome(item.id, classifyDocument(input, mutated), item.expect!, validAllowsLegacy);
          return;
        }
        case "pad-body-to-total-bytes": {
          const padded = new Uint8Array(item.totalBytes!);
          padded.set(bytes);
          padded.fill(0x0a, bytes.length);
          expect(padded.length).toBeGreaterThan(MAX_DOCUMENT_BYTES);
          const got = classifyDocument(input, padded);
          expect(got.outcome).toBe("invalid");
          if (got.outcome === "invalid") expect(got.diagnostic.kind).toBe("document_too_large");
          return;
        }
        case "replace-envelope-with-yaml-mapping-depth": {
          expect(item.expect).toBe("document_too_complex");
          const tooDeep = classifyDocument(input, yamlMappingEnvelope(item.depth!));
          expect(tooDeep.outcome).toBe("invalid");
          if (tooDeep.outcome === "invalid") expect(tooDeep.diagnostic.kind).toBe("document_too_complex");
          const atCap = classifyDocument(input, yamlMappingEnvelope(item.depth! - 1));
          const tooComplex = atCap.outcome === "invalid" && atCap.diagnostic.kind === "document_too_complex";
          expect(tooComplex).toBe(false);
          return;
        }
        case "replace-body-with-nested-block-quotes": {
          expect(item.expect).toBe("document_too_complex");
          expect(classified.outcome).toBe("valid");
          if (classified.outcome !== "valid") return;
          const prefix = bytes.slice(0, classified.bodyStart);
          const quote = (depth: number) => `${"> ".repeat(depth)}deep\n`;
          const tooDeep = new Uint8Array(prefix.length + quote(item.containerDepth!).length);
          tooDeep.set(prefix);
          tooDeep.set(new TextEncoder().encode(quote(item.containerDepth!)), prefix.length);
          const got = classifyDocument(input, tooDeep);
          expect(got.outcome).toBe("invalid");
          if (got.outcome === "invalid") expect(got.diagnostic.kind).toBe("document_too_complex");
          const legalQuote = quote(item.containerDepth! - 1);
          const legal = new Uint8Array(prefix.length + legalQuote.length);
          legal.set(prefix);
          legal.set(new TextEncoder().encode(legalQuote), prefix.length);
          expect(classifyDocument(input, legal).outcome).toBe("valid");
          return;
        }
        case "no-op-round-trip": {
          expect(item.expect).toBe("byte-identical");
          if (legacySource) {
            await expectLegacyWriteRefused(dir, item.id, input);
            return;
          }
          const source = new TextDecoder().decode(bytes);
          const out = patchDocumentMetadata(input, source, []);
          expect(Buffer.compare(Buffer.from(out, "utf8"), bytes)).toBe(0);
          return;
        }
        case "metadata-patch": {
          expect(item.expect).toBe("byte-identical");
          if (legacySource) {
            await expectLegacyWriteRefused(dir, item.id, input);
            return;
          }
          const patch = Object.entries(item.patch ?? {}).map(([key, value]) => ({ key, value }));
          const out = patchDocumentMetadata(input, new TextDecoder().decode(bytes), patch);
          expect(Buffer.compare(Buffer.from(out, "utf8"), readBytes(dir, item.expected!))).toBe(0);
          return;
        }
        case "external-change-before-save": {
          expect(item.expect).toBe("external_change_conflict");
          const external = readBytes(dir, item.external!);
          if (legacySource) {
            await expectLegacyWriteRefused(dir, item.id, input);
            return;
          }
          expect(() => saveGuarded(bytes, external, new Uint8Array())).toThrow(/external_change_conflict/);
          // The guard passes when the bytes still match the snapshot.
          expect(saveGuarded(bytes, bytes, new Uint8Array())).toEqual(new Uint8Array());
          return;
        }
        default:
          throw new Error(`${item.id}: unknown operation \`${item.operation}\``);
      }
    });
  }
  return skipped;
}

describe("pdc conformance corpora", () => {
  const skipped = runCorpus("v1", V1_DIR, "pdc-document-conformance/1", 3, true);
  skipped.push(...runCorpus("v2", V2_DIR, "pdc-document-conformance/2", 2, false));

  test("the v2 corpus pins the query contract", () => {
    expect(corpusOf(V2_DIR).queryContract).toBe("pdc-query/1");
  });

  test("the only skipped cases are the query-plane `.base` files Ghost does not claim", () => {
    expect(skipped.sort()).toEqual(["query-base-file", "query-invalid-yaml", "query-unknown-constructs-preserved"]);
  });

  test("a corpus revision bump fails this suite", () => {
    expect(corpusOf(V1_DIR).revision).toBe(3);
    expect(corpusOf(V2_DIR).revision).toBe(2);
  });
});
