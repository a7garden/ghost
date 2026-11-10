import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVault, generatePassword, GHOST_VAULT_ITEM_LIMIT, normalizeOrigin, PASSWORD_ALPHABET, totp, type Vault, type VaultInput } from "../src/stores/vault.ts";
import { tempDir } from "./support.ts";

const roots: string[] = [], vaults: Vault[] = [];
function fixture(now?: () => number) {
  const root = tempDir(); roots.push(root);
  const vault = createVault(root, { now }); vaults.push(vault);
  return { root, vault, dbPath: join(root, "vault/vault.db") };
}
afterEach(() => { for (const vault of vaults.splice(0)) vault.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const login = (extra: Partial<VaultInput> = {}): VaultInput => ({ kind: "login", title: "Synthetic account", origin: "https://EXAMPLE.com:443/", username: "user", password: "SYNTHETIC-password-unique-very-private", ghostIds: ["ghost-a"], ...extra });

describe("Shade origin and password rules", () => {
  test("normalizes case, IDNs and default ports without accepting parser repairs", () => {
    for (const [raw, canonical] of [["https://EXAMPLE.com:443/", "https://example.com"], ["https://bücher.example/", "https://xn--bcher-kva.example"], ["https://example.com:8443", "https://example.com:8443"], ["https://[2001:db8::1]:443/", "https://[2001:db8::1]"]]) expect(normalizeOrigin(raw!)).toBe(canonical!);
    for (const raw of ["http://example.com", "https://example.com/path", "https://example.com/.", "https://example.com/%2e", "https://example.com?x=1", "https://u:p@example.com", "https://@example.com", "https:///example.com", "https://example.com\\attacker", "https://example.com.", " https://example.com", "https://example.com#fragment", "https://example.com?", "https://example.com#", "https://%65xample.com", "HTTPS://example.com", "https://example.com\n", "https://"]) expect(() => normalizeOrigin(raw)).toThrow("invalid vault origin");
  });
  test("generates Shade's alphabet at its exact length bounds", () => {
    for (const length of [16, 24, 256]) {
      const value = generatePassword(length);
      expect(value.length).toBe(length);
      expect([...value].every((char) => PASSWORD_ALPHABET.includes(char))).toBe(true);
    }
    expect(generatePassword()).not.toBe(generatePassword());
    for (const length of [0, 15, 257, 1e6, 16.1, NaN]) expect(() => generatePassword(length)).toThrow("invalid password length");
    const { vault } = fixture();
    for (const password of ["", "bad\0value", "x".repeat(65537)]) expect(() => vault.create(login({ password }))).toThrow("invalid vault password");
  });
});

describe("extra login origins", () => {
  test("normalizes exact extra origins, matches them in listFor, clears them and refuses them on cards", () => {
    const { vault } = fixture();
    const item = vault.create(login({ extraOrigins: ["https://LOGIN.example.com:443/", "https://example.com", "https://login.example.com"] }));
    expect(item.origin).toBe("https://example.com");
    expect(item.extraOrigins).toEqual(["https://login.example.com"]);
    expect(vault.listFor("ghost-a", { origin: "https://login.example.com" }).map((row) => row.id)).toEqual([item.id]);
    expect(vault.listFor("ghost-a", { origin: "https://other.example.com" })).toEqual([]);
    expect(vault.update(item.id, { title: "renamed" }).extraOrigins).toEqual(["https://login.example.com"]);
    expect(vault.update(item.id, { extraOrigins: [] }).extraOrigins).toBeUndefined();
    for (const extraOrigins of [["http://login.example.com"], ["https://example.com/login"], Array.from({ length: 9 }, (_, n) => `https://l${n}.example.com`)]) expect(() => vault.create(login({ extraOrigins }))).toThrow();
    expect(() => vault.create({ kind: "card", title: "Card", card: { number: "4111 1111 1111 1111", expiry: "12/30", cvc: "123", name: "Owner" }, extraOrigins: ["https://pay.example.com"] })).toThrow("fields do not belong to vault item kind");
  });
});

describe("encrypted vault", () => {
  test("encrypts fields and their history, restricts files and persists grants", () => {
    const { root, vault, dbPath } = fixture();
    const seed = "JBSWY3DPEHPK3PXP";
    const item = vault.create(login({ totp: seed, hints: "Use the test account" }));
    expect(statSync(join(root, "vault")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "vault/key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "vault/key")).length).toBe(32);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(vault.listFor("ghost-a", { origin: "https://EXAMPLE.com:443/", kind: "login" })).toEqual([item]);
    expect(vault.listFor("other")).toEqual([]);
    expect(() => vault.itemFor("other", item.id)).toThrow("not granted");
    expect(() => vault.reveal("other", item.id, "password")).toThrow("not granted");
    expect(vault.reveal("ghost-a", item.id, "username")).toBe("user");
    expect(vault.reveal("ghost-a", item.id, "password")).toBe(login().password!);
    expect(() => vault.reveal("ghost-a", item.id, "card_number")).toThrow("kind");
    const next = "SYNTHETIC-password-replacement-not-visible";
    vault.update(item.id, { password: next, title: "Updated" });
    vault.update(item.id, { hints: "new hint" });
    expect(vault.history(item.id).map((v) => v.version)).toEqual([1, 2, 3]);
    expect(vault.reveal("ghost-a", item.id, "password")).toBe(next);
    const card = { number: "4111111111111111", expiry: "12/30", cvc: "987", name: "SYNTHETIC PRIVATE CARDHOLDER" };
    const cardItem = vault.create({ kind: "card", title: "Card", card, ghostIds: ["ghost-a"] });
    expect(cardItem.cardLast4).toBe("1111"); expect(cardItem.cardExpiry).toBe("12/30");
    expect(vault.reveal("ghost-a", cardItem.id, "card_name")).toBe(card.name);
    vault.create({ kind: "secret", title: "Token", value: "SYNTHETIC PRIVATE TOKEN", ghostIds: [] });
    const db = new Database(dbPath);
    expect(db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM secrets WHERE item_id=? AND field='password'").get(item.id)!.n).toBe(2);
    // Decrypt the first revision independently to prove history retains the previous secret with bound AAD.
    const old = db.query<{ sealed: Uint8Array }, [string]>("SELECT sealed FROM secrets WHERE item_id=? AND field='password' AND version=1").get(item.id)!;
    const sealedOld = Buffer.from(old.sealed), master = readFileSync(join(root, "vault/key"));
    const key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "ghost-vault/1 aead", 32));
    const importKey = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "ghost-vault/1 import-tag", 32));
    expect(key.equals(master)).toBe(false); expect(importKey.equals(key)).toBe(false);
    for (const wrongKey of [master, importKey]) {
      const wrong = createDecipheriv("aes-256-gcm", wrongKey, sealedOld.subarray(0, 12));
      wrong.setAAD(Buffer.from(JSON.stringify(["ghost-vault/1", item.id, "password", 1])));
      wrong.setAuthTag(sealedOld.subarray(12, 28));
      expect(() => { wrong.update(sealedOld.subarray(28)); wrong.final(); }).toThrow();
    }
    master.fill(0); importKey.fill(0);
    const decipher = createDecipheriv("aes-256-gcm", key, sealedOld.subarray(0, 12));
    decipher.setAAD(Buffer.from(JSON.stringify(["ghost-vault/1", item.id, "password", 1])));
    decipher.setAuthTag(sealedOld.subarray(12, 28));
    expect(Buffer.concat([decipher.update(sealedOld.subarray(28)), decipher.final()]).toString()).toBe(login().password!);
    key.fill(0);
    db.exec("PRAGMA wal_checkpoint(FULL)"); db.close();
    for (const path of [dbPath, `${dbPath}-wal`]) if (existsSync(path)) {
      const bytes = readFileSync(path);
      for (const value of [login().password!, next, seed, card.number, card.name, "SYNTHETIC PRIVATE TOKEN"]) expect(bytes.includes(Buffer.from(value))).toBe(false);
    }
    vault.update(item.id, { ghostIds: [] });
    expect(() => vault.reveal("ghost-a", item.id, "password")).toThrow("not granted");
    vault.remove(item.id);
    expect(() => vault.itemFor("ghost-a", item.id)).toThrow("not found");
    const removed = new Database(dbPath);
    expect(removed.query<{ n: number }, [string]>("SELECT count(*) AS n FROM secrets WHERE item_id=?").get(item.id)!.n).toBe(0);
    expect(removed.query<{ n: number }, [string]>("SELECT count(*) AS n FROM versions WHERE item_id=?").get(item.id)!.n).toBe(0); removed.close();
  });
  test("authenticates item, field and revision and sanitizes authentication errors", () => {
    const { vault, dbPath } = fixture();
    const a = vault.create(login()), b = vault.create(login());
    const db = new Database(dbPath);
    const sealed = db.query<{ sealed: Uint8Array }, [string]>("SELECT sealed FROM secrets WHERE item_id=? AND field='password'").get(a.id)!.sealed;
    db.query("UPDATE secrets SET sealed=? WHERE item_id=? AND field='password'").run(sealed, b.id);
    expect(() => vault.reveal("ghost-a", b.id, "password")).toThrow("vault storage operation failed");
    db.close();
  });
  test("one-time items expire on every access and remove all versions", () => {
    let time = 1000; const { vault, dbPath } = fixture(() => time);
    const item = vault.create(login(), { expiresAt: 2000 });
    time = 2000;
    expect(() => vault.reveal("ghost-a", item.id, "password")).toThrow("not found");
    expect(vault.list()).toEqual([]);
    expect(() => vault.itemFor("ghost-a", item.id)).toThrow("not found");
    const db = new Database(dbPath);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM secrets").get()!.n).toBe(0); db.close();
  });
  test("rejects malformed metadata, cross-kind fields and immutable kind changes", () => {
    const { vault } = fixture(); const item = vault.create(login());
    for (const input of [{ kind: "secret" }, { title: null }, { ghostIds: "bad" }, { username: 123 }, { card: {} }, { password: null }, { unknown: "do not echo me" }]) expect(() => vault.update(item.id, input as never)).toThrow();
    const contact = vault.create({ kind: "contact", title: "Contact", contact: { name: "Person", email: "person@example.com" } });
    expect(contact.contact?.name).toBe("Person");
    expect(() => vault.create({ kind: "secret", title: "bad", value: "private", password: "private" })).toThrow("kind");
  });
  test("refuses symlink and missing-key stores without replacing the original", () => {
    const { vault, root } = fixture(); vault.create(login());
    const key = join(root, "vault/key"), original = readFileSync(key);
    unlinkSync(key); writeFileSync(join(root, "outside"), original); symlinkSync(join(root, "outside"), key);
    expect(() => createVault(root)).toThrow("could not be opened");
    unlinkSync(key);
    expect(() => createVault(root)).toThrow("could not be opened");
    expect(existsSync(key)).toBe(false);
  });
});

function encode32(value: string) {
  let result = "", bits = 0, number = 0;
  for (const byte of Buffer.from(value)) { number = (number << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(number >>> bits) & 31]; } }
  if (bits) result += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[(number << (5 - bits)) & 31];
  return result;
}
test("RFC 6238 SHA1, SHA256 and SHA512 vectors through reveal", () => {
  const { vault } = fixture();
  const times = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];
  const vectors = [
    ["SHA1", "12345678901234567890", ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"]],
    ["SHA256", "12345678901234567890123456789012", ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"]],
    ["SHA512", "1234567890123456789012345678901234567890123456789012345678901234", ["90693936", "25091201", "99943326", "93441116", "38618901", "47863826"]],
  ] as const;
  for (const [algorithm, seed, codes] of vectors) {
    const item = vault.create(login({ totp: `otpauth://totp/Example?secret=${encode32(seed)}&algorithm=${algorithm}&digits=8&period=30` }));
    for (let i = 0; i < times.length; i++) expect(vault.reveal("ghost-a", item.id, "totp", times[i]! * 1000)).toBe(codes[i]!);
  }
  expect(totp(encode32("12345678901234567890"), 59000)).toBe("287082");
  for (const seed of ["bad!", "A", "otpauth://hotp/test?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&algorithm=MD5", "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&period=0", "otpauth://totp/test?secret=JBSWY3DPEHPK3PXP&digits=7"]) expect(() => totp(seed)).toThrow("invalid vault TOTP");
});

describe("Apple and Chrome CSV import", () => {
  test("handles BOM, quoted newlines, duplicate rows and password conflicts without overwrite", () => {
    const { vault } = fixture();
    vault.create(login({ password: "SYNTHETIC-old" }));
    const csv = '\uFEFFTitle,URL,Username,Password,Notes,OTPAuth\r\nExisting,https://EXAMPLE.com/login?return=1,user,SYNTHETIC-old,,\r\n"Synthetic ""quoted""\r\nname",https://new.example/login,user,SYNTHETIC-p1,,\r\nRepeat,https://new.example/other,user,SYNTHETIC-p1,,\r\nConflict,https://example.com/login,user,SYNTHETIC-new,,\r\nOther conflict,https://new.example/path,user,SYNTHETIC-p2,,\r\nHTTP,http://legacy.example/login,user,SYNTHETIC-http,,\r\nEmpty,https://empty.example,user,,,\r\n';
    expect(vault.importCsv(csv)).toEqual({ imported: 3, skipped: 2, rejected: 2 });
    expect(vault.list().length).toBe(4);
    expect(vault.list().find((item) => item.origin === "https://new.example")?.title).toBe('Synthetic "quoted"\r\nname');
    expect(vault.importCsv(csv)).toEqual({ imported: 0, skipped: 5, rejected: 2 });
    expect(vault.importCsv("name,url,username,password,note\nChrome,https://chrome.example/login,,SYNTHETIC-chrome,ignored\n")).toEqual({ imported: 1, skipped: 0, rejected: 0 });
  });
  test("imports valid Apple OTP seeds and rejects non-HTTPS or ambiguous authorities", () => {
    const { vault } = fixture();
    expect(vault.importCsv("Title,URL,Username,Password,OTPAuth\nOTP,https://otp.example/login,user,password,JBSWY3DPEHPK3PXP\nCredentials,https://u:p@example.com,user,password,\nEncoded,https://%65xample.com,user,password,\n")).toEqual({ imported: 1, skipped: 0, rejected: 2 });
    expect(vault.list()[0]?.hasTotp).toBe(true);
  });
  test("oversized title and username rows are rejected without losing valid logins", () => {
    const { vault } = fixture();
    const csv = `Title,URL,Username,Password\nValid,https://valid.example,user,password\n${"x".repeat(257)},https://large-title.example,user,password\nLarge username,https://large-user.example,${"x".repeat(513)},password\n${"x".repeat(65537)},https://huge-title.example,user,password\n`;
    expect(vault.importCsv(csv)).toEqual({ imported: 1, skipped: 0, rejected: 3 });
    expect(vault.list().map((item) => item.origin)).toEqual(["https://valid.example"]);
  });
  test("the 10,000-row limit still aborts the whole import", () => {
    const { vault } = fixture();
    const csv = "Title,URL,Username,Password\n" + "Valid,https://example.com,user,password\n".repeat(10001);
    expect(() => vault.importCsv(csv)).toThrow("row limit");
    expect(vault.list()).toEqual([]);
  });
  test("malformed or oversized input is atomic and errors never echo row values", () => {
    const { vault } = fixture();
    for (const csv of ['URL,Username,Password\nhttps://good.example,u,SYNTHETIC-private\nhttps://bad.example,u,"unfinished', "URL,Username,Password,Password\nhttps://example.com,u,private,private", "URL,Username,Password\nhttps://good.example,u,private\nshort,u", "URL,Username,Password\nhttps://good.example,u,private\nhttps://bad.example,u," + "x".repeat(65537), "x".repeat(1024 * 1024 + 1)]) {
      let message = ""; try { vault.importCsv(csv); } catch (error) { message = (error as Error).message; }
      expect(message.length).toBeGreaterThan(0); expect(message).not.toContain("SYNTHETIC-private"); expect(vault.list()).toEqual([]);
    }
  });
});

test("generated login reuse is exact, grant-bound and subject to a persistent per-creator quota", () => {
  const { root, vault } = fixture();
  const owner = vault.create(login({ title: "Owner login", ghostIds: ["ghost-a"] }));
  expect(vault.generateLogin("ghost-a", { origin: "https://EXAMPLE.com:443/", username: "user" }).id).toBe(owner.id);
  const fresh = vault.generateLogin("ghost-b", { origin: "https://example.com", username: "user" });
  expect(fresh.id).not.toBe(owner.id);
  for (let i = 1; i < GHOST_VAULT_ITEM_LIMIT; i++) vault.generateLogin("ghost-b", { origin: "https://example.com", username: `user-${i}` });
  const reopened = createVault(root); vaults.push(reopened);
  expect(() => reopened.generateLogin("ghost-b", { origin: "https://other.example", username: "over-limit" })).toThrow("Ghost-created vault item limit reached (200)");
  expect(reopened.generateLogin("ghost-b", { origin: "https://example.com", username: "user" }).id).toBe(fresh.id);
  expect(reopened.generateLogin("ghost-a", { origin: "https://other.example", username: "independent" }).ghostIds).toEqual(["ghost-a"]);
  // Owner writes and grants do not consume a Ghost's creation quota.
  const granted = reopened.create(login({ origin: "https://owner.example", ghostIds: ["ghost-b"] }));
  expect(reopened.generateLogin("ghost-b", { origin: "https://owner.example", username: "user" }).id).toBe(granted.id);
  reopened.update(fresh.id, { ghostIds: [] });
  expect(() => reopened.generateLogin("ghost-b", { origin: "https://example.com", username: "user" })).toThrow("limit reached");
  reopened.remove(fresh.id);
  expect(reopened.generateLogin("ghost-b", { origin: "https://replacement.example", username: "replacement" }).ghostIds).toEqual(["ghost-b"]);
});
