import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VaultItem as ItemSchema, validate, type VaultItem, type SecureFormRequest } from "@ghost/contract";
import type { VaultField, VaultPort } from "../integrations/ports.ts";
import { CommandError, conflict, forbidden, invalid, notFound } from "../core/errors.ts";
import { idFor } from "../core/ids.ts";
import { generatePassword, normalizeOrigin, totp, validatePassword, validateTotp } from "./vault/model.ts";
import { parseCsv } from "./vault/csv.ts";
export { generatePassword, normalizeOrigin, PASSWORD_ALPHABET, totp } from "./vault/model.ts";

export interface VaultInput {
  id?: string; kind: VaultItem["kind"]; title: string; origin?: string | null; username?: string | null;
  password?: string; totp?: string; card?: { number: string; expiry: string; cvc: string; name: string };
  contact?: VaultItem["contact"]; value?: string; hints?: string; ghostIds?: string[];
}
type Stored = { metadata: string; version: number };
type SecretRow = { field: VaultField; version: number; sealed: Uint8Array };
const INPUT_KEYS: Record<string, true> = { id: true, kind: true, title: true, origin: true, username: true, password: true, totp: true, card: true, contact: true, value: true, hints: true, ghostIds: true };
const KIND_FIELDS: Record<VaultItem["kind"], readonly VaultField[]> = { login: ["username", "password", "totp"], card: ["card_number", "card_expiry", "card_cvc", "card_name"], contact: [], secret: ["value"] };
export const GHOST_VAULT_ITEM_LIMIT = 200;

/** Values never leave this store except through the host-only VaultPort.reveal fill boundary.
 * Metadata is plain; every secret revision is independently AEAD-bound to item, field and revision.
 */
export class Vault implements VaultPort {
  private readonly db: Database;
  private readonly aeadKey: Buffer;
  private readonly importTagKey: Buffer;
  private readonly now: () => number;
  constructor(root: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    const dir = join(root, "vault"), keyPath = join(dir, "key"), dbPath = join(dir, "vault.db");
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error();
      chmodSync(dir, 0o700);
      for (const path of [keyPath, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (!existsSync(keyPath)) {
        if (existsSync(dbPath)) throw new Error();
        const temporary = join(dir, `.key-${randomUUID()}`), bytes = randomBytes(32);
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, bytes); fsyncSync(fd);
          try { linkSync(temporary, keyPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        } finally { closeSync(fd); bytes.fill(0); unlinkSync(temporary); }
        const directory = openSync(dir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      chmodSync(keyPath, 0o600);
      const key = readFileSync(keyPath);
      try {
        if (key.length !== 32) throw new Error();
        this.aeadKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "ghost-vault/1 aead", 32));
        this.importTagKey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "ghost-vault/1 import-tag", 32));
      } finally { key.fill(0); }
      const fd = openSync(dbPath, "a", 0o600); closeSync(fd); chmodSync(dbPath, 0o600);
      this.db = new Database(dbPath, { strict: true });
      const version = this.db.query("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== 0 && version.user_version !== 1) { this.db.close(); throw new Error(); }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, version INTEGER NOT NULL, expires_at INTEGER, creator_ghost_id TEXT);
        CREATE INDEX IF NOT EXISTS items_creator ON items(creator_ghost_id);
        CREATE TABLE IF NOT EXISTS secrets(item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, field TEXT NOT NULL, version INTEGER NOT NULL, sealed BLOB NOT NULL, PRIMARY KEY(item_id,field,version));
        CREATE TABLE IF NOT EXISTS versions(item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, version INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(item_id,version));
        PRAGMA user_version=1;`);
    } catch { throw new CommandError("unavailable", "vault storage could not be opened"); }
  }
  close() { this.db.close(); this.aeadKey.fill(0); this.importTagKey.fill(0); }
  private storage<T>(operation: () => T): T {
    try { return operation(); } catch (error) { if (error instanceof CommandError) throw error; throw new CommandError("unavailable", "vault storage operation failed"); }
  }
  private prune() { this.db.query("DELETE FROM items WHERE expires_at IS NOT NULL AND expires_at<=?").run(this.now()); }
  list(): VaultItem[] {
    return this.storage(() => { this.prune(); return (this.db.query("SELECT metadata FROM items ORDER BY rowid").all() as { metadata: string }[]).map((row) => JSON.parse(row.metadata) as VaultItem); });
  }
  private row(id: string): Stored {
    this.prune();
    const row = this.db.query("SELECT metadata,version FROM items WHERE id=?").get(id) as Stored | null;
    if (!row) throw notFound("vault item not found");
    return row;
  }
  listFor(ghostId: string, filter: { origin?: string; kind?: VaultItem["kind"] } = {}): VaultItem[] {
    const origin = filter.origin === undefined ? undefined : normalizeOrigin(filter.origin);
    return this.list().filter((item) => item.ghostIds.includes(ghostId) && (origin === undefined || item.origin === origin) && (filter.kind === undefined || item.kind === filter.kind));
  }
  itemFor(ghostId: string, itemId: string): VaultItem {
    return this.storage(() => {
      const item = JSON.parse(this.row(itemId).metadata) as VaultItem;
      if (!item.ghostIds.includes(ghostId)) throw forbidden("vault item is not granted to this Ghost");
      return item;
    });
  }
  private decrypt(itemId: string, row: SecretRow): string {
    const sealed = Buffer.from(row.sealed);
    const decipher = createDecipheriv("aes-256-gcm", this.aeadKey, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify(["ghost-vault/1", itemId, row.field, row.version])));
    decipher.setAuthTag(sealed.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
    try { return plain.toString("utf8"); } finally { plain.fill(0); }
  }
  private field(itemId: string, field: VaultField): string {
    const row = this.db.query("SELECT field,version,sealed FROM secrets WHERE item_id=? AND field=? ORDER BY version DESC LIMIT 1").get(itemId, field) as SecretRow | null;
    if (!row) throw notFound("vault field is absent");
    return this.decrypt(itemId, row);
  }
  reveal(ghostId: string, itemId: string, field: VaultField, at?: number): string {
    return this.storage(() => {
      const item = this.itemFor(ghostId, itemId);
      if (!KIND_FIELDS[item.kind].includes(field)) throw invalid("field does not belong to vault item kind");
      if (field === "username") return item.username ?? "";
      const value = this.field(itemId, field);
      return field === "totp" ? totp(value, at ?? this.now()) : value;
    });
  }
  private prepare(input: Partial<VaultInput>, previous?: VaultItem, expiresAt?: number): { item: VaultItem; secrets: Partial<Record<VaultField, string>> } {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !Object.hasOwn(INPUT_KEYS, key))) throw invalid("invalid vault item fields");
    for (const key of ["id", "kind", "title", "hints"] as const) if (input[key] !== undefined && typeof input[key] !== "string") throw invalid("invalid vault item metadata");
    if (input.ghostIds !== undefined && !Array.isArray(input.ghostIds)) throw invalid("invalid vault grants");
    if (previous && input.kind !== undefined && input.kind !== previous.kind) throw invalid("vault item kind cannot change");
    if (previous && input.id !== undefined && input.id !== previous.id) throw invalid("vault item id cannot change");
    const kind = previous?.kind ?? input.kind;
    if (!kind || !Object.hasOwn(KIND_FIELDS, kind)) throw invalid("invalid vault item kind");
    if ((kind !== "login" && ["username", "password", "totp"].some((key) => key in input)) || (kind !== "card" && "card" in input) || (kind !== "contact" && "contact" in input) || (kind !== "secret" && "value" in input)) throw invalid("fields do not belong to vault item kind");
    const secrets: Partial<Record<VaultField, string>> = {};
    if (input.password !== undefined) { validatePassword(input.password); secrets.password = input.password; }
    if (input.totp !== undefined) { validateTotp(input.totp); secrets.totp = input.totp; }
    if (input.value !== undefined) { validatePassword(input.value); secrets.value = input.value; }
    if (input.card !== undefined) {
      const card = input.card;
      if (!card || typeof card !== "object" || Array.isArray(card) || Object.keys(card).some((key) => !["number", "expiry", "cvc", "name"].includes(key)) || ![card.number, card.expiry, card.cvc, card.name].every((s) => typeof s === "string" && s.length > 0 && !s.includes("\0")) || !/^[0-9 -]{12,32}$/.test(card.number) || !/^\d{12,19}$/.test(card.number.replace(/[ -]/g, "")) || card.expiry.length > 16 || !/^\d{3,4}$/.test(card.cvc) || card.name.length > 256) throw invalid("invalid vault card fields");
      Object.assign(secrets, { card_number: card.number, card_expiry: card.expiry, card_cvc: card.cvc, card_name: card.name });
    }
    const rawOrigin = input.origin === undefined ? previous?.origin ?? null : input.origin;
    const origin = rawOrigin === null ? null : normalizeOrigin(rawOrigin);
    if (kind === "login" && !origin) throw invalid("login requires an HTTPS origin");
    const time = this.now();
    const item: VaultItem = {
      id: previous?.id ?? input.id ?? randomUUID(), kind, title: input.title ?? previous?.title ?? "", origin,
      username: kind === "login" ? input.username === undefined ? previous?.username ?? "" : input.username : null,
      cardLast4: input.card ? input.card.number.replace(/[ -]/g, "").slice(-4) : previous?.cardLast4 ?? null,
      cardExpiry: input.card?.expiry ?? previous?.cardExpiry ?? null,
      contact: input.contact === undefined ? previous?.contact ?? null : input.contact,
      hints: input.hints ?? previous?.hints ?? "", ghostIds: input.ghostIds ?? previous?.ghostIds ?? [],
      hasPassword: input.password !== undefined || previous?.hasPassword === true, hasTotp: input.totp !== undefined || previous?.hasTotp === true,
      expiresAt: expiresAt ?? previous?.expiresAt ?? null, createdAt: previous?.createdAt ?? time, updatedAt: time,
    };
    if (!validate(ItemSchema, item) || !item.title.trim() || [item.id, item.title, item.username, item.hints, ...item.ghostIds].some((s) => s?.includes("\0")) || (item.contact && Object.keys(item.contact).some((key) => !["name", "phone", "email", "address"].includes(key)))) throw invalid("invalid vault item metadata");
    if (!previous && ((kind === "login" && !item.hasPassword && !item.hasTotp) || (kind === "card" && !input.card) || (kind === "contact" && !item.contact) || (kind === "secret" && !input.value))) throw invalid("required vault fields are missing");
    return { item, secrets };
  }
  private write(item: VaultItem, secrets: Partial<Record<VaultField, string>>, version: number) {
    this.db.query("INSERT INTO items(id,metadata,version,expires_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,version=excluded.version,expires_at=excluded.expires_at").run(item.id, JSON.stringify(item), version, item.expiresAt);
    this.db.query("INSERT INTO versions(item_id,version,metadata) VALUES(?,?,?)").run(item.id, version, JSON.stringify(item));
    for (const [field, value] of Object.entries(secrets)) {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.aeadKey, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(["ghost-vault/1", item.id, field, version])));
      const plain = Buffer.from(value);
      try {
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        const sealed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
        this.db.query("INSERT INTO secrets(item_id,field,version,sealed) VALUES(?,?,?,?)").run(item.id, field, version, sealed);
      } finally { plain.fill(0); }
    }
  }
  create(input: VaultInput, options: { expiresAt?: number; creatorGhostId?: string } = {}): VaultItem {
    const { item, secrets } = this.prepare(input, undefined, options.expiresAt);
    return this.storage(() => this.db.transaction(() => {
      this.prune();
      if (this.db.query("SELECT id FROM items WHERE id=?").get(item.id)) throw conflict("vault item id already exists");
      const count = this.db.query("SELECT count(*) AS n FROM items").get() as { n: number };
      if (count.n >= 10000) throw conflict("vault item limit exceeded");
      if (options.creatorGhostId) {
        const count = this.db.query("SELECT count(*) AS n FROM items WHERE creator_ghost_id=?").get(options.creatorGhostId) as { n: number };
        if (count.n >= GHOST_VAULT_ITEM_LIMIT) throw conflict(`Ghost-created vault item limit reached (${GHOST_VAULT_ITEM_LIMIT}); reuse an existing login or ask the owner to manage the vault`);
      }
      this.write(item, secrets, 1);
      if (options.creatorGhostId) this.db.query("UPDATE items SET creator_ghost_id=? WHERE id=?").run(options.creatorGhostId, item.id);
      return item;
    })());
  }
  update(id: string, input: Partial<VaultInput>): VaultItem {
    return this.storage(() => this.db.transaction(() => {
      const old = this.row(id), { item, secrets } = this.prepare(input, JSON.parse(old.metadata));
      if (old.version >= 10000) throw conflict("vault version limit exceeded");
      this.write(item, secrets, old.version + 1); return item;
    })());
  }
  /** Owner-only history metadata. Secret revisions remain encrypted and have no public read API. */
  history(id: string): { version: number; item: VaultItem }[] {
    return this.storage(() => {
      this.row(id);
      return (this.db.query("SELECT version,metadata FROM versions WHERE item_id=? ORDER BY version").all(id) as { version: number; metadata: string }[])
        .map((row) => ({ version: row.version, item: JSON.parse(row.metadata) as VaultItem }));
    });
  }
  remove(id: string) { return this.storage(() => { this.row(id); this.db.query("DELETE FROM items WHERE id=?").run(id); }); }
  generateLogin(ghostId: string, input: { origin: string; username: string; title?: string; hints?: string }, id?: string): VaultItem {
    const items = this.list();
    if (id && items.some((item) => item.id === id)) return this.itemFor(ghostId, id);
    const origin = normalizeOrigin(input.origin);
    const existing = items.find((item) => item.kind === "login" && item.origin === origin && item.username === input.username && item.ghostIds.includes(ghostId));
    if (existing) return existing;
    return this.create({ ...input, id, origin, kind: "login", title: input.title ?? origin, password: generatePassword(), ghostIds: [ghostId] }, { creatorGhostId: ghostId });
  }
  /** A decision's fixed item identity permits recovery after a vault commit but before ledger resolution. */
  answerSecureForm(decisionId: string, ghostId: string, request: SecureFormRequest, input: VaultInput, save: boolean): VaultItem {
    if (input.kind !== request.kind || (request.origin && normalizeOrigin(input.origin ?? request.origin) !== request.origin)) throw invalid("secure form kind or origin does not match the request");
    const id = idFor("vault-request", decisionId);
    const existing = this.list().find((item) => item.id === id);
    if (existing) {
      if (existing.kind !== request.kind || (request.origin && existing.origin !== request.origin)) throw conflict("secure form item identity conflicts");
      return this.itemFor(ghostId, id);
    }
    return this.create({ ...input, id, title: input.title ?? request.title ?? request.origin ?? request.kind, origin: input.origin ?? request.origin, ghostIds: [ghostId] }, { expiresAt: save ? undefined : this.now() + 24 * 60 * 60 * 1000 });
  }
  importCsv(csv: string): { imported: number; skipped: number; rejected: number } {
    const parsed = parseCsv(csv);
    return this.storage(() => this.db.transaction(() => {
      const known = new Set<string>();
      const tag = (origin: string, username: string, password: string) => createHmac("sha256", this.importTagKey).update("ghost-vault/import/1\0").update(JSON.stringify([origin, username, password])).digest("hex");
      for (const item of this.list()) if (item.kind === "login" && item.hasPassword) known.add(tag(item.origin!, item.username ?? "", this.field(item.id, "password")));
      let imported = 0, skipped = 0;
      for (const row of parsed.rows) {
        const identity = tag(row.origin, row.username, row.password);
        if (known.has(identity)) { skipped++; continue; }
        this.create({ ...row, kind: "login" }); known.add(identity); imported++;
      }
      return { imported, skipped, rejected: parsed.rejected };
    })());
  }
}
export function createVault(root: string, options: { now?: () => number } = {}): Vault { return new Vault(root, options); }
