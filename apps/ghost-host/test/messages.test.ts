import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CommandError } from "../src/core/errors.ts";
import { MacHost } from "../src/integrations/host.ts";
import { readVerificationCodes } from "../src/integrations/messages.ts";
import { tempDir } from "./support.ts";

const NOW = 1_700_000_000_000;
const APPLE_EPOCH_OFFSET = 978_307_200;

// Generated on macOS with:
// swift -e 'import Foundation; let d = NSArchiver.archivedData(withRootObject: NSAttributedString(string: "나이스정보통신 [Web발신] 본인확인 인증번호 [482913]을 입력해 주세요")); print(d.map { String(format: "%02x", $0) }.joined())'
// The output is stored as hex in fixtures/messages/attributed-body-*.hex.
const bodyFixture = (name: string) =>
  Uint8Array.from(
    readFileSync(join(import.meta.dir, "fixtures/messages", name), "utf8")
      .trim()
      .match(/.{2}/g)!
      .map((byte) => Number.parseInt(byte, 16)),
  );

function createChatDb(path: string, options: { tapbacks?: boolean } = {}) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY,
      guid TEXT,
      text TEXT,
      attributedBody BLOB,
      handle_id INTEGER,
      is_from_me INTEGER NOT NULL DEFAULT 0,
      service TEXT,
      date INTEGER NOT NULL${options.tapbacks === false ? "" : ", associated_message_type INTEGER DEFAULT 0"}
    );
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  db.exec("INSERT INTO handle (ROWID, id, service) VALUES (1, '+821012345678', 'SMS'), (2, 'noreply@kakao.example', 'iMessage')");
  return db;
}

function appleNanos(when: number) {
  return BigInt(Math.floor(when / 1000) - APPLE_EPOCH_OFFSET) * 1_000_000_000n;
}

function insertMessage(
  db: Database,
  input: {
    date: number | bigint;
    text?: string | null;
    body?: Uint8Array | null;
    handleId?: number;
    fromMe?: number;
    service?: string;
    associatedType?: number;
  },
) {
  const columns = ["date", "text", "attributedBody", "handle_id", "is_from_me", "service"];
  const values: (string | number | bigint | Uint8Array | null)[] = [
    input.date,
    input.text ?? null,
    input.body ?? null,
    input.handleId ?? 1,
    input.fromMe ?? 0,
    input.service ?? (input.handleId === 2 ? "iMessage" : "SMS"),
  ];
  if (input.associatedType !== undefined) {
    columns.push("associated_message_type");
    values.push(input.associatedType);
  }
  db.query(`INSERT INTO message (${columns.join(",")}) VALUES (${values.map(() => "?").join(",")})`).run(...values);
}

describe("Messages verification codes", () => {
  test("extracts plain and typedstream codes, applies window, sender, tapback and incoming filters", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "chat.db");
    const db = createChatDb(dbPath);
    try {
      insertMessage(db, {
        date: appleNanos(NOW - 2 * 60_000),
        text: "인증번호 135791을 입력해 주세요",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 3 * 60_000),
        body: bodyFixture("attributed-body-ko.hex"),
      });
      insertMessage(db, {
        date: appleNanos(NOW - 30_000),
        body: bodyFixture("attributed-body-en.hex"),
      });
      insertMessage(db, {
        date: appleNanos(NOW - 25_000),
        text: "Your code is 719355. It expires in 5 minutes.",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 26_000),
        text: "[Web발신] 카드 승인 1234 50,000원",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 27_000),
        text: "Your postcode is 12345",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 28_000),
        text: "Order #734291 payment approved: 50,000원",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 5 * 60_000),
        body: bodyFixture("attributed-body-dash.hex"),
      });
      insertMessage(db, {
        date: appleNanos(NOW - 6 * 60_000),
        body: bodyFixture("attributed-body-long.hex"),
      });
      insertMessage(db, {
        date: Math.floor((NOW - 7 * 60_000) / 1000) - APPLE_EPOCH_OFFSET,
        text: "인증번호 555012",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 4 * 60_000),
        text: "2026-11-10까지 유효합니다. 인증번호는 864213 입니다.",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 8 * 60_000),
        text: "카카오 로그인 인증번호 654321",
        handleId: 2,
      });
      insertMessage(db, {
        date: appleNanos(NOW - 10_000),
        text: "인증번호 999999 입니다",
        fromMe: 1,
      });
      insertMessage(db, {
        date: appleNanos(NOW - 20_000),
        text: "인증번호 777777 입니다",
        associatedType: 2000,
      });
      insertMessage(db, {
        date: appleNanos(NOW - 40_000),
        text: "점심 먹으러 갈래요?",
      });
      insertMessage(db, {
        date: appleNanos(NOW - 50_000),
        body: Uint8Array.from([0x04, 0x0b, 0xff, 0x81, 0x05, 0xfe, 0xe0]),
      });
      insertMessage(db, {
        date: appleNanos(NOW - 51_000),
        body: new TextEncoder().encode("verification code 999991"),
      });
      insertMessage(db, {
        date: appleNanos(NOW - 90 * 60_000),
        text: "인증번호 246810",
      });

      const result = await readVerificationCodes({ dbPath, withinMinutes: 10, now: NOW });
      expect(result.codes.map((item) => item.code)).toEqual([
        "719355",
        "582913",
        "135791",
        "482913",
        "864213",
        "123456",
        "7319024",
        "555012",
        "654321",
      ]);
      expect(result.codes.find((item) => item.code === "482913")?.receivedAt).toBe(NOW - 3 * 60_000);
      expect(result.codes.find((item) => item.code === "555012")?.receivedAt).toBe(NOW - 7 * 60_000);
      expect(result.codes.every((item, index, all) => index === 0 || all[index - 1]!.receivedAt >= item.receivedAt)).toBe(true);
      expect(result.codes.every((item) => item.excerpt.length <= 160)).toBe(true);
      expect(result.codes.find((item) => item.code === "482913")?.excerpt).toContain("인증번호");

      const oneMinute = await readVerificationCodes({ dbPath, withinMinutes: 1, now: NOW });
      expect(oneMinute.codes.map((item) => item.code)).toEqual(["719355", "582913"]);
      const sender = await readVerificationCodes({
        dbPath,
        withinMinutes: 10,
        senderContains: "KAKAO",
        now: NOW,
      });
      expect(sender.codes.map((item) => item.code)).toEqual(["654321"]);
      expect(sender.codes[0]?.sender).toBe("noreply@kakao.example");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads a freshly committed message from WAL while its writer stays open", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "chat.db");
    const db = createChatDb(dbPath);
    try {
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      insertMessage(db, {
        date: appleNanos(NOW - 15_000),
        text: "Your verification code is 384920",
      });
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      const result = await readVerificationCodes({ dbPath, withinMinutes: 10, now: NOW });
      expect(result.codes.map((item) => item.code)).toEqual(["384920"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("caps results at ten and handles a schema without associated_message_type", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "chat.db");
    const db = createChatDb(dbPath, { tapbacks: false });
    try {
      for (let index = 0; index < 12; index++)
        insertMessage(db, {
          date: appleNanos(NOW - index * 1000),
          text: `verification code ${String(100000 + index)}`,
        });
      const result = await readVerificationCodes({ dbPath, withinMinutes: 10, now: NOW });
      expect(result.codes).toHaveLength(10);
      expect(result.codes[0]?.code).toBe("100000");
      expect(result.codes.at(-1)?.code).toBe("100009");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("distinguishes a missing database from a permission failure", async () => {
    const dir = tempDir();
    try {
      await expect(
        readVerificationCodes({ dbPath: join(dir, "missing", "chat.db"), withinMinutes: 10 }),
      ).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("database not found") });

      const denied = join(dir, "denied");
      mkdirSync(denied);
      const dbPath = join(denied, "chat.db");
      const db = createChatDb(dbPath);
      db.close();
      chmodSync(denied, 0);
      try {
        await expect(
          readVerificationCodes({ dbPath, withinMinutes: 10 }),
        ).rejects.toMatchObject({
          code: "unavailable",
          message: expect.stringContaining(`Messages needs Full Disk Access for ${process.execPath}`),
        });
      } finally {
        chmodSync(denied, 0o700);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MacHost exposes fixture-path injection", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "chat.db");
    const db = createChatDb(dbPath);
    try {
      insertMessage(db, { date: appleNanos(NOW - 1000), text: "OTP code: 123456" });
      const result = await new MacHost().messageCodes({ dbPath, withinMinutes: 10, now: NOW });
      expect(result.codes.map((item) => item.code)).toEqual(["123456"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects an out-of-range time window", async () => {
    await expect(
      readVerificationCodes({ dbPath: "/does/not/matter", withinMinutes: 61 }),
    ).rejects.toBeInstanceOf(CommandError);
  });
});
