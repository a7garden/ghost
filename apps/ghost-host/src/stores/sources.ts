import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../core/ids.ts";

/** One page the Host read for a Ghost, kept so a citation can be checked against what was actually read. */
export interface SourceRecord {
  id: string;
  url: string;
  title: string | null;
  sha256: string;
  fetchedAt: number;
  ghostId: string;
  conversationId: string;
}

/** Each stored snapshot is bounded; a quote beyond it cannot be verified and is reported as such. */
export const SOURCE_TEXT_LIMIT = 512 * 1024;
/** A citation is `[S-` + 10 hex + `]`; the id is derived from the URL and the content hash. */
export const SOURCE_ID = /^S-[0-9a-f]{10}$/;
export const SOURCE_CITATION = /\[(S-[0-9a-f]{10})\]/g;

/** Whitespace, width and case differences are not a misquote; anything else is. */
export function normalizeQuote(text: string): string {
  return text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Snapshots of read pages at `<root>/sources/sources.db`, outside the ledger: reads stay unjournaled
 * and a previous release simply ignores this file. A row is immutable; the same URL with the same
 * bytes is the same source.
 */
export class SourceStore {
  private readonly db: Database;
  constructor(root: string, private readonly now: () => number = Date.now) {
    const dir = join(root, "sources");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dir, "sources.db"), { strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, sha256 TEXT NOT NULL, fetched_at INTEGER NOT NULL,
        ghost_id TEXT NOT NULL, conversation_id TEXT NOT NULL, text TEXT NOT NULL, truncated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sources_conversation ON sources(conversation_id, fetched_at);`);
  }
  close() { this.db.close(); }

  /** Record what was read; returns the existing row when the same URL had the same bytes. */
  record(input: { url: string; title: string | null; text: string; ghostId: string; conversationId: string }): SourceRecord {
    const digest = sha256(input.text);
    const id = `S-${sha256(`${input.url}\0${digest}`).slice(0, 10)}`;
    const text = input.text.length > SOURCE_TEXT_LIMIT ? input.text.slice(0, SOURCE_TEXT_LIMIT) : input.text;
    this.db.query("INSERT OR IGNORE INTO sources(id,url,title,sha256,fetched_at,ghost_id,conversation_id,text,truncated) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, input.url, input.title, digest, this.now(), input.ghostId, input.conversationId, text, text.length < input.text.length ? 1 : 0);
    return this.find(id)!;
  }

  find(id: string): SourceRecord | null {
    if (!SOURCE_ID.test(id)) return null;
    const row = this.db.query("SELECT id,url,title,sha256,fetched_at,ghost_id,conversation_id FROM sources WHERE id=?").get(id) as Row | null;
    return row ? fromRow(row) : null;
  }

  /** Sources read in these conversations, newest first. */
  listFor(conversationIds: readonly string[], limit = 100): SourceRecord[] {
    if (conversationIds.length === 0) return [];
    const marks = conversationIds.map(() => "?").join(",");
    return (this.db.query(`SELECT id,url,title,sha256,fetched_at,ghost_id,conversation_id FROM sources WHERE conversation_id IN (${marks}) ORDER BY fetched_at DESC LIMIT ?`)
      .all(...conversationIds, limit) as Row[]).map(fromRow);
  }

  /** Whether the stored snapshot contains the quote, with a little surrounding text when it does. */
  check(id: string, quote: string): { source: SourceRecord | null; found: boolean; context: string | null; truncated: boolean } {
    const source = this.find(id);
    if (!source) return { source: null, found: false, context: null, truncated: false };
    const row = this.db.query("SELECT text,truncated FROM sources WHERE id=?").get(id) as { text: string; truncated: number };
    const haystack = normalizeQuote(row.text), needle = normalizeQuote(quote);
    const at = needle ? haystack.indexOf(needle) : -1;
    return { source, found: at >= 0, context: at >= 0 ? haystack.slice(Math.max(0, at - 80), at + needle.length + 80) : null, truncated: row.truncated === 1 };
  }
}

type Row = { id: string; url: string; title: string | null; sha256: string; fetched_at: number; ghost_id: string; conversation_id: string };
const fromRow = (row: Row): SourceRecord => ({ id: row.id, url: row.url, title: row.title, sha256: row.sha256, fetchedAt: row.fetched_at, ghostId: row.ghost_id, conversationId: row.conversation_id });

/**
 * Citation problems in one text: every `[S-…]` must name a recorded source, and every quote written
 * right before its citation (`"…" [S-…]` or `「…」[S-…]`) must appear in that source.
 */
export function citationFailures(store: SourceStore, text: string): string[] {
  const failures: string[] = [];
  const ids = [...new Set([...text.matchAll(SOURCE_CITATION)].map((match) => match[1]!))];
  if (ids.length === 0) return ["cites no recorded source ([S-…])"];
  for (const id of ids) if (!store.find(id)) failures.push(`cites ${id}, which was never read`);
  const quoted = /(?:"([^"\n]{8,600})"|“([^”\n]{8,600})”|「([^」\n]{8,600})」)\s*\[(S-[0-9a-f]{10})\]/g;
  for (const match of text.matchAll(quoted)) {
    const quote = match[1] ?? match[2] ?? match[3] ?? "", id = match[4]!;
    const result = store.check(id, quote);
    if (result.source && !result.found) failures.push(`quote attributed to ${id} is not in that source${result.truncated ? " (its snapshot was truncated)" : ""}: ${quote.slice(0, 120)}`);
  }
  return failures;
}
