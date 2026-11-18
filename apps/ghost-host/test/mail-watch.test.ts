import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import type { Connection } from "@ghost/contract";
import { ImapFlow } from "imapflow";
import { SourceConnections } from "../src/integrations/activity-sources.ts";
import { MailWatcher } from "../src/integrations/mail-watch.ts";
import { MailService } from "../src/integrations/mail.ts";
import { cert, key } from "./fixtures/activity-tls.ts";
import { harness, tempDir } from "./support.ts";

const INTERVAL = 100;

class FakeClock {
  private time = 0;
  private next = 0;
  private interval = 0;
  private tick: (() => Promise<void>) | null = null;

  now() { return this.time; }
  repeat(tick: () => Promise<void>, intervalMs: number) {
    this.tick = tick;
    this.interval = intervalMs;
    this.next = this.time + intervalMs;
    return () => { this.tick = null; };
  }
  async advance(ms = INTERVAL) {
    const end = this.time + ms;
    while (this.tick && this.next <= end) {
      this.time = this.next;
      this.next += this.interval;
      await this.tick();
    }
    this.time = end;
  }
}

interface Message { uid: number; subject: string; seen?: boolean; sender?: string }
interface FakeInbox {
  connection: Connection;
  commands: string[];
  validity: number;
  uidNext: number;
  messages: Message[];
  refuseAuth: boolean;
  holdExamine: (() => void) | null;
  close(): void;
}

async function fakeImap(id: string, name: string, credential = true): Promise<FakeInbox> {
  const sockets = new Set<TLSSocket>();
  const commands: string[] = [];
  const state = { validity: 7, uidNext: 1, messages: [] as Message[], refuseAuth: false, holdExamine: null as (() => void) | null };
  const server = createServer({ key, cert }, socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const capabilities = "IMAP4rev1 AUTH=PLAIN SASL-IR";
    socket.write(`* OK [CAPABILITY ${capabilities}] ready\r\n`);
    let buffer = "", authTag = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const tag = authTag || line.split(" ")[0]!;
        if (!authTag) commands.push(line);
        if (authTag || / (?:AUTHENTICATE PLAIN|LOGIN) /i.test(line)) {
          socket.write(state.refuseAuth ? `${tag} NO [AUTHENTICATIONFAILED] denied\r\n` : `${tag} OK authenticated\r\n`);
          authTag = "";
        } else if (/ CAPABILITY$/i.test(line)) socket.write(`* CAPABILITY ${capabilities}\r\n${tag} OK capability\r\n`);
        else if (/ AUTHENTICATE PLAIN$/i.test(line)) { authTag = tag; socket.write("+ \r\n"); }
        else if (/ LIST "" ""$/i.test(line)) socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK list\r\n`);
        else if (/ LIST /i.test(line)) socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if (/ EXAMINE /i.test(line)) {
          if (state.holdExamine) state.holdExamine();
          else socket.write(`* FLAGS (\\Seen)\r\n* ${state.messages.length} EXISTS\r\n* OK [UIDVALIDITY ${state.validity}] valid\r\n* OK [UIDNEXT ${state.uidNext}] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
        } else if (/ UID SEARCH /i.test(line)) {
          const range = /\bUID (\d+)(?::(\d+))?/i.exec(line);
          const min = Number(range?.[1] ?? 1), max = Number(range?.[2] ?? range?.[1] ?? state.uidNext - 1);
          const ids = state.messages.filter(message => message.uid >= min && message.uid <= max && (!/\bUNSEEN\b/i.test(line) || !message.seen)).map(message => message.uid);
          socket.write(`* SEARCH${ids.length ? ` ${ids.join(" ")}` : ""}\r\n${tag} OK search\r\n`);
        } else if (/ UID FETCH /i.test(line)) {
          const uid = Number(/ UID FETCH (\d+)/i.exec(line)?.[1]);
          const index = state.messages.findIndex(message => message.uid === uid), message = state.messages[index];
          if (message) socket.write(`* ${index + 1} FETCH (UID ${uid} ENVELOPE (NIL ${JSON.stringify(message.subject)} (("Sender" NIL "${message.sender ?? "sender"}" "example.com")) NIL NIL NIL NIL NIL NIL NIL))\r\n`);
          socket.write(`${tag} OK fetch\r\n`);
        } else socket.write(`${tag} BAD unsupported\r\n`);
      }
    });
  });
  server.on("tlsClientError", () => {});
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const connection: Connection = {
    id, name, hasCredential: credential, credentialVersion: credential ? "v1" : null, createdAt: 1, updatedAt: 1,
    config: { kind: "mail", host: "127.0.0.1", port: address.port, username: `${id}@example.com`, mailbox: "INBOX", smtpHost: null, smtpPort: 465, smtpSecure: true },
  };
  return Object.assign(state, { connection, commands, close() { for (const socket of sockets) socket.destroy(); server.close(); } });
}

async function fixture(...inboxes: FakeInbox[]) {
  const root = tempDir(), path = join(root, "ledger.db"), clock = new FakeClock();
  const connections = inboxes.map(inbox => inbox.connection);
  const sources = new SourceConnections({ root, currentConnection: id => connections.find(connection => connection.id === id) ?? null });
  for (const account of connections) {
    if (account.hasCredential) await sources.setCredential(account.id, "fixture-app-password", account.credentialVersion);
  }
  function boot() {
    const h = harness(path);
    const ghost = h.ledger.defaultGhost() ?? h.core.createGhost({ name: "Ghost", persona: "", isDefault: true });
    const mail = new MailService({ connections: () => connections, sources, imap: options => new ImapFlow({ ...options, tls: { ...options.tls, ca: cert } }) });
    const watcher = new MailWatcher(h.core, mail, { clock, intervalMs: INTERVAL });
    return { ...h, ghost, mail, watcher, async close() { await Promise.all([watcher.stop(), mail.close()]); h.ledger.close(); } };
  }
  let app = boot();
  return {
    get app() { return app; }, clock,
    async connect(account: Connection) {
      await sources.setCredential(account.id, "fixture-app-password", "v1");
      account.credentialVersion = "v1";
      account.hasCredential = true;
    },
    async restart() { await app.close(); app = boot(); },
    async close() {
      try { await app.close(); await sources.close(); }
      finally { for (const inbox of inboxes) inbox.close(); rmSync(root, { recursive: true, force: true }); }
    },
  };
}

function add(inbox: FakeInbox, ...messages: Message[]) {
  for (const message of messages) {
    inbox.messages.push(message);
    inbox.uidNext = Math.max(inbox.uidNext, message.uid + 1);
  }
}

test("first observation baselines silently and skips accounts without credentials", async () => {
  const inbox = await fakeImap("work", "업무"), disconnected = await fakeImap("offline", "미연결", false);
  const f = await fixture(inbox, disconnected);
  try {
    add(inbox, { uid: 1, subject: "Old unread" }, { uid: 4, subject: "Old read", seen: true });
    await f.app.watcher.start();
    expect(f.app.ledger.notificationsForState()).toEqual([]);
    expect(inbox.commands.filter(line => / EXAMINE /i.test(line))).toHaveLength(1);
    expect(inbox.commands.some(line => / UID (?:SEARCH|FETCH) /i.test(line))).toBe(false);
    expect(disconnected.commands).toEqual([]);
    await f.clock.advance(INTERVAL - 1);
    expect(inbox.commands.filter(line => / EXAMINE /i.test(line))).toHaveLength(1);
    await f.clock.advance(1);
    expect(inbox.commands.filter(line => / EXAMINE /i.test(line))).toHaveLength(2);
    expect(f.app.ledger.notificationsForState()).toEqual([]);
  } finally { await f.close(); }
});

test("aggregates new unseen UIDs for the default Ghost and fetches only three read-only envelopes", async () => {
  const inbox = await fakeImap("work", "업무 메일");
  const f = await fixture(inbox);
  try {
    add(inbox, { uid: 1, subject: "Old unread" }, { uid: 4, subject: "Old read", seen: true });
    await f.app.watcher.start();
    add(inbox, { uid: 5, subject: "Fourth" }, { uid: 6, subject: "Already read", seen: true },
      { uid: 4100, subject: "Third", sender: "third" }, { uid: 4101, subject: "Second", sender: "second" },
      { uid: 4102, subject: "First", sender: "first" }, { uid: 4103, subject: "Newest read", seen: true });
    await f.clock.advance();
    // A message already inside the observed UID window is not new when marked unread.
    inbox.messages.at(-1)!.seen = false;
    await f.clock.advance();
    expect(f.app.ledger.notificationsForState()).toEqual([expect.objectContaining({
      id: "mail-new:work:7:4102", kind: "message", ghostId: f.app.ghost.id, conversationId: f.app.ghost.directConversationId,
      workId: null, decisionId: null, title: "새 메일",
      body: "업무 메일 · 새 메일 4통\nfirst@example.com — First\nsecond@example.com — Second\nthird@example.com — Third",
    })]);
    expect(f.app.engine.submissions.size).toBe(0);
    expect(inbox.commands.filter(line => / UID SEARCH /i.test(line)).map(line => line.match(/UID \d+:\d+/i)?.[0])).toEqual(["UID 8:4103", "UID 5:7"]);
    const fetches = inbox.commands.filter(line => / UID FETCH /i.test(line));
    expect(fetches.map(line => line.match(/UID FETCH \d+/i)?.[0])).toEqual(["UID FETCH 4102", "UID FETCH 4101", "UID FETCH 4100"]);
    expect(fetches.every(line => /\bENVELOPE\b/i.test(line) && !/BODY|RFC822/i.test(line))).toBe(true);
    expect(inbox.commands.some(line => / (?:SELECT|STORE|MOVE|APPEND) /i.test(line))).toBe(false);
  } finally { await f.close(); }
});

test("restart resumes from the persisted mark, reporting only mail received while stopped", async () => {
  const inbox = await fakeImap("work", "업무"), f = await fixture(inbox);
  try {
    await f.app.watcher.start();
    add(inbox, { uid: 1, subject: "Before restart" });
    await f.clock.advance();
    await f.app.watcher.stop();
    add(inbox, { uid: 2, subject: "While stopped" });
    await f.restart();
    await f.app.watcher.start();
    await f.clock.advance();
    expect(f.app.ledger.notificationsForState().map(notification => [notification.id, notification.body]).sort()).toEqual([
      ["mail-new:work:7:1", "업무 · 새 메일 1통\nsender@example.com — Before restart"],
      ["mail-new:work:7:2", "업무 · 새 메일 1통\nsender@example.com — While stopped"],
    ]);
  } finally { await f.close(); }
});

test("changed UIDVALIDITY baselines silently and admits later UIDs in the new epoch", async () => {
  const inbox = await fakeImap("work", "업무"), f = await fixture(inbox);
  try {
    add(inbox, { uid: 300, subject: "Original inbox" });
    await f.app.watcher.start();
    inbox.validity = 8;
    inbox.uidNext = 1;
    inbox.messages = [];
    add(inbox, { uid: 1, subject: "Rebuilt inbox" });
    await f.clock.advance();
    expect(f.app.ledger.notificationsForState()).toEqual([]);
    add(inbox, { uid: 2, subject: "Arrived later" });
    await f.clock.advance();
    expect(f.app.ledger.notificationsForState().map(notification => notification.id)).toEqual(["mail-new:work:8:2"]);
  } finally { await f.close(); }
});

test("a failing account backs off without stopping another account and recovers silently", async () => {
  const bad = await fakeImap("bad", "실패"), good = await fakeImap("good", "정상");
  const f = await fixture(bad, good);
  try {
    bad.refuseAuth = true;
    add(bad, { uid: 1, subject: "While failing" });
    await f.app.watcher.start();
    const rejectedCommands = bad.commands.length;
    expect(bad.commands.some(line => / AUTHENTICATE /i.test(line))).toBe(true);
    expect(f.app.ledger.notificationsForState()).toEqual([]);
    add(good, { uid: 1, subject: "Delivered" });
    await f.clock.advance();
    expect(bad.commands).toHaveLength(rejectedCommands);
    expect(f.app.ledger.notificationsForState().map(notification => notification.id)).toEqual(["mail-new:good:7:1"]);
    bad.refuseAuth = false;
    await f.clock.advance();
    expect(bad.commands.some(line => / EXAMINE /i.test(line))).toBe(true);
    expect(f.app.ledger.notificationsForState()).toHaveLength(1);
    add(bad, { uid: 2, subject: "After recovery" });
    await f.clock.advance();
    expect(f.app.ledger.notificationsForState().map(notification => notification.id).sort()).toEqual(["mail-new:bad:7:2", "mail-new:good:7:1"]);
  } finally { await f.close(); }
});

test("hostile encoded subjects cannot add lines or retain control characters", async () => {
  const inbox = await fakeImap("work", "업무\r\n  계정"), f = await fixture(inbox);
  try {
    await f.app.watcher.start();
    const hostile = Buffer.from("Roadmap\r\n\t\x1b\u202e   review").toString("base64");
    add(inbox, { uid: 1, subject: `=?UTF-8?B?${hostile}?= ${"x".repeat(200)}` });
    await f.clock.advance();
    const lines = f.app.ledger.notification("mail-new:work:7:1").body.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("업무 계정 · 새 메일 1통");
    expect(lines[1]).toMatch(/^sender@example\.com — Roadmap review x+…$/u);
    expect(lines[1]!.length).toBeLessThanOrEqual(163);
    expect(lines.some(line => /[\p{Cc}\p{Cf}]/u.test(line))).toBe(false);
  } finally { await f.close(); }
});

test("a stalled poll does not block newly connected accounts and shutdown aborts the active read", async () => {
  const inbox = await fakeImap("stalled", "지연"), good = await fakeImap("work", "업무", false);
  const f = await fixture(inbox, good);
  try {
    const examining = Promise.withResolvers<void>();
    inbox.holdExamine = examining.resolve;
    const started = f.app.watcher.start();
    expect(await Promise.race([examining.promise.then(() => true), started.then(() => false)])).toBe(true);
    await f.connect(good.connection);
    await f.clock.advance();
    add(good, { uid: 1, subject: "Delivered during the stall" });
    await f.clock.advance();
    expect(f.app.ledger.notificationsForState().map(notification => notification.id)).toEqual(["mail-new:work:7:1"]);

    await Promise.all([f.app.watcher.stop(), f.app.mail.close(), started]);
    const counts = [inbox.commands.length, good.commands.length];
    await f.clock.advance(4 * INTERVAL);
    expect([inbox.commands.length, good.commands.length]).toEqual(counts);
  } finally { await f.close(); }
});
