import { expect, test } from "bun:test";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { rmSync } from "node:fs";
import type { Connection } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ImapFlow } from "imapflow";
import { SourceConnections } from "../src/integrations/activity-sources.ts";
import { activitySmtp } from "../src/integrations/activity-mail.ts";
import { MailService, validateMailSend } from "../src/integrations/mail.ts";
import { NoEffect } from "../src/core/effects.ts";
import { Access } from "../src/core/access.ts";
import { execute } from "../src/core/commands.ts";
import { serveMail } from "../src/api/mail.ts";
import { createMailTools } from "../src/tools/mail.ts";
import { cert, key } from "./fixtures/activity-tls.ts";
import { harness, tempDir } from "./support.ts";

const source = Buffer.from("From: sender@example.com\r\nTo: owner@example.com\r\nSubject: Protocol source\r\nMessage-ID: <source@example.com>\r\nReferences: <previous@example.com>\r\nDate: Tue, 10 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nUntrusted source text.\r\n--fixture\r\nContent-Type: text/plain; name=evidence.txt\r\nContent-Disposition: attachment; filename=evidence.txt\r\n\r\nIsolated attachment evidence.\r\n--fixture--\r\n");
async function listen(server: Server) {
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", ready.resolve);
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  return address.port;
}
async function fixture(gmail = false, commonNames = false, noFolders = false, hooks: { oauth2?: boolean; beforeConnect?: () => Promise<void>; beforeData?: () => void; afterAcceptance?: () => void } = {}) {
  const sockets = new Set<TLSSocket>(), commands: string[] = [], smtpCommands: string[] = [], sent: string[] = [], appended: string[] = [];
  const identity = { uidValidity: 7 };
  const track = (socket: TLSSocket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); };
  const imap = createServer({ key, cert }, socket => {
    track(socket);
    const capabilities = `IMAP4rev1 AUTH=${hooks.oauth2 ? "XOAUTH2" : "PLAIN"} SASL-IR MOVE UIDPLUS${gmail ? " X-GM-EXT-1" : ""}`;
    socket.write(`* OK [CAPABILITY ${capabilities}] ready\r\n`);
    let buffer = Buffer.alloc(0), literal = 0, appendTag = "", authTag = "";
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      for (;;) {
        if (literal) {
          if (buffer.length < literal + 2) return;
          appended.push(buffer.subarray(0, literal).toString()); buffer = buffer.subarray(literal + 2); literal = 0;
          socket.write(`${appendTag} OK [APPENDUID 7 4] appended\r\n`); continue;
        }
        const end = buffer.indexOf("\r\n"); if (end < 0) return;
        const line = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 2);
        if (authTag) { socket.write(`${authTag} OK authenticated\r\n`); authTag = ""; continue; }
        commands.push(line); const tag = line.split(" ")[0]!;
        if (/ CAPABILITY$/i.test(line)) socket.write(`* CAPABILITY ${capabilities}\r\n${tag} OK capability\r\n`);
        else if (/ AUTHENTICATE (?:PLAIN|XOAUTH2)$/i.test(line)) { authTag = tag; socket.write("+ \r\n"); }
        else if (/ AUTHENTICATE (?:PLAIN|XOAUTH2) /i.test(line)) socket.write(`${tag} OK authenticated\r\n`);
        else if (/ LIST "" ""$/i.test(line)) socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK list\r\n`);
        else if (/ (LIST|LSUB) /i.test(line)) {
          const op = / LSUB /i.test(line) ? "LSUB" : "LIST";
          const boxes = noFolders ? "" : commonNames ? `* ${op} () "/" "Sent Items"\r\n* ${op} () "/" "Deleted Messages"\r\n* ${op} () "/" "Archives"\r\n` : `* ${op} (\\Sent) "/" "[Gmail]/Sent Mail"\r\n* ${op} (\\Trash) "/" "[Gmail]/Trash"\r\n* ${op} (${gmail ? "\\All" : "\\Archive"}) "/" "Archive"\r\n`;
          socket.write(`* ${op} (\\HasNoChildren) "/" "INBOX"\r\n${boxes}${tag} OK list\r\n`);
        } else if (/ STATUS /i.test(line)) { const path = / STATUS (.+) \(/i.exec(line)![1]!; socket.write(`* STATUS ${path} (MESSAGES 3 UNSEEN 2)\r\n${tag} OK status\r\n`); }
        else if (/ (EXAMINE|SELECT) /i.test(line)) socket.write(`* FLAGS (\\Seen \\Flagged)\r\n* 3 EXISTS\r\n* OK [UIDVALIDITY ${identity.uidValidity}] valid\r\n* OK [UIDNEXT 4] next\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged)] flags\r\n${tag} OK [${/ EXAMINE /i.test(line) ? "READ-ONLY" : "READ-WRITE"}] selected\r\n`);
        else if (/ UID SEARCH /i.test(line)) {
          const range = /UID (\d+):(\d+)/i.exec(line), exact = / UID SEARCH UID ([0-9,]+)$/i.exec(line);
          const uids = range ? [1, 2, 3].filter(uid => uid >= Number(range[1]) && uid <= Number(range[2])) : exact ? exact[1]!.split(",").map(Number) : [1, 2, 3];
          socket.write(`* SEARCH ${uids.join(" ")}\r\n${tag} OK search\r\n`);
        } else if (/ UID FETCH /i.test(line)) {
          const uid = Number(/ UID FETCH (\d+)/i.exec(line)![1]);
          const meta = `UID ${uid} FLAGS () RFC822.SIZE ${source.length} INTERNALDATE "10-Nov-2026 10:00:00 +0000" ENVELOPE ("Tue, 10 Nov 2026 10:00:00 +0000" "Protocol source" (("Sender" NIL "sender" "example.com")) NIL NIL ((NIL NIL "owner" "example.com")) NIL NIL NIL "<source@example.com>")`;
          socket.write(line.includes("BODY.PEEK[]") ? Buffer.concat([Buffer.from(`* ${uid} FETCH (${meta} BODY[]<0> {${source.length}}\r\n`), source, Buffer.from(`)\r\n${tag} OK fetch\r\n`)]) : `* ${uid} FETCH (${meta})\r\n${tag} OK fetch\r\n`);
        } else if (/ UID (MOVE|STORE) /i.test(line)) socket.write(`${tag} OK changed\r\n`);
        else if (/ APPEND /i.test(line)) { literal = Number(/\{(\d+)\}$/.exec(line)![1]); appendTag = tag; socket.write("+ continue\r\n"); }
        else if (/ (CLOSE|UNSELECT)$/i.test(line)) socket.write(`${tag} OK closed\r\n`);
        else if (/ LOGOUT$/i.test(line)) socket.end(`* BYE goodbye\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} BAD unsupported\r\n`);
      }
    });
  });
  imap.on("tlsClientError", () => {});
  const smtp = createServer({ key, cert }, socket => {
    track(socket); socket.write("220 localhost fixture\r\n"); let buffer = "", data = false;
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        if (data) { const end = buffer.indexOf("\r\n.\r\n"); if (end < 0) return; sent.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false; socket.write("250 accepted\r\n"); hooks.afterAcceptance?.(); continue; }
        const end = buffer.indexOf("\r\n"); if (end < 0) return; const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        smtpCommands.push(line);
        if (/^EHLO /i.test(line)) socket.write(`250-localhost\r\n250 AUTH ${hooks.oauth2 ? "XOAUTH2" : "PLAIN"}\r\n`);
        else if (/^AUTH (?:PLAIN|XOAUTH2) /i.test(line)) socket.write("235 authenticated\r\n");
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write("250 accepted\r\n");
        else if (line === "DATA") { hooks.beforeData?.(); data = true; socket.write("354 continue\r\n"); }
        else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  });
  smtp.on("tlsClientError", () => {});
  const root = tempDir(), imapPort = await listen(imap), smtpPort = await listen(smtp);
  const connection: Connection = { id: "mail-account", name: "Fixture", hasCredential: true, credentialVersion: "v1", createdAt: 1, updatedAt: 1, config: { kind: "mail", host: "127.0.0.1", port: imapPort, username: "owner@example.com", mailbox: "INBOX", smtpHost: "127.0.0.1", smtpPort, smtpSecure: true, ...(hooks.oauth2 ? { authType: "oauth2" as const } : {}) } };
  let currentConnection = connection;
  const sources = new SourceConnections({ root, currentConnection: () => currentConnection });
  await sources.setCredential(connection.id, "fixture-app-password", "v1");
  const mail = new MailService({ connections: () => [currentConnection], sources, imap: options => {
    const client = new ImapFlow({ ...options, tls: { ...options.tls, ca: cert } });
    const connect = client.connect.bind(client);
    client.connect = async () => { await hooks.beforeConnect?.(); await connect(); };
    return client;
  }, smtp: options => activitySmtp({ ...options, tls: { ...options.tls, ca: cert } }) });
  return { mail, sources, connection, replaceConnection(next: Connection) { currentConnection = next; }, commands, smtpCommands, sent, appended, identity, async close() { await mail.close(); await sources.close(); for (const socket of sockets) socket.destroy(); imap.close(); smtp.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("mail client refreshes OAuth credentials before IMAP and SMTP and never attempts password authentication", async () => {
  const f = await fixture(true, false, false, { oauth2: true });
  const h = harness();
  const ghost = h.core.createGhost({ name: "OAuth mail", isDefault: true, tools: ["mail_send"] });
  h.ledger.setPiConversationId(ghost.directConversationId, "oauth-mail");
  const extension = createMailTools(h.core, f.mail);
  let refreshes = 0;
  f.sources.setOAuthRefresher(async connection => {
    await f.sources.rotateCredential(connection.id, `refreshed-access-${++refreshes}`, connection.credentialVersion!);
  });
  try {
    await f.mail.mailboxes("Fixture");
    const tool = extension.tools!.find(tool => tool.name === "mail_send")!;
    const result = await tool.execute({ account: "Fixture", to: ["to@example.com"], subject: "OAuth delivery", text: "Body" } as never,
      { conversationId: "oauth-mail", callId: "oauth-send" } as unknown as ToolExecutionApi, { abortSignal: undefined } as Context);
    expect(result.isError).toBeFalsy();
    const decision = h.ledger.pendingDecisions()[0]!;
    f.replaceConnection({ ...f.connection, updatedAt: Date.now() });
    await h.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(h.ledger.effect(decision.effectId!).state).toBe("done");
    expect(refreshes).toBe(2);
    const imapAuth = f.commands.filter(line => line.includes(" AUTHENTICATE XOAUTH2 "));
    expect(imapAuth).toHaveLength(2);
    expect(Buffer.from(imapAuth[0]!.split(" ").at(-1)!, "base64").toString()).toContain("auth=Bearer refreshed-access-1");
    expect(Buffer.from(imapAuth[1]!.split(" ").at(-1)!, "base64").toString()).toContain("auth=Bearer refreshed-access-2");
    const smtpAuth = f.smtpCommands.find(line => line.startsWith("AUTH XOAUTH2 "));
    expect(smtpAuth).toBeDefined();
    expect(Buffer.from(smtpAuth!.split(" ").at(-1)!, "base64").toString()).toContain("auth=Bearer refreshed-access-2");
    expect(f.commands.some(line => / AUTHENTICATE PLAIN | LOGIN /i.test(line))).toBe(false);
    expect(f.smtpCommands.some(line => /^AUTH (?:PLAIN|LOGIN) /i.test(line))).toBe(false);
    expect(f.sent).toHaveLength(1);
  } finally { await f.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); }
});

test("mail client refuses a failed OAuth refresh before opening a transport", async () => {
  const f = await fixture(true, false, false, { oauth2: true });
  f.sources.setOAuthRefresher(async () => { throw new Error("revoked"); });
  try {
    await expect(f.mail.mailboxes("Fixture")).rejects.toMatchObject({ code: "unavailable" });
    expect(f.commands).toEqual([]);
    expect(f.smtpCommands).toEqual([]);
  } finally { await f.close(); }
});

for (const change of ["revoke", "replace", "identity"] as const) test(`OAuth mail ${change} still refuses an approved transport before SMTP DATA`, async () => {
  const hooks: { oauth2: boolean; beforeData?: () => void } = { oauth2: true };
  const f = await fixture(true, false, false, hooks);
  hooks.beforeData = () => {
    const row = f.connection;
    if (row.config.kind !== "mail") throw new Error("mail fixture required");
    f.replaceConnection(change === "revoke" ? { ...row, hasCredential: false }
      : change === "replace" ? { ...row, credentialVersion: "replacement-epoch" }
      : { ...row, config: { ...row.config, username: "other@example.com" } });
  };
  try {
    await expect(f.mail.send("Fixture", { to: ["to@example.com"], subject: "Approved", text: "Must not leave" })).rejects.toBeInstanceOf(NoEffect);
    expect(f.sent).toHaveLength(0);
  } finally { await f.close(); }
});

test("IMAPS lists special-use and status, paginates newest UID first, searches and reads only with PEEK", async () => {
  const f = await fixture(true);
  try {
    const boxes = await f.mail.mailboxes("Fixture");
    expect(boxes.find(box => box.specialUse === "sent")?.path).toBe("[Gmail]/Sent Mail");
    expect(boxes[0]).toMatchObject({ specialUse: "inbox", total: 3, unseen: 2 });
    const first = await f.mail.list("Fixture", { limit: 2 });
    expect(first.messages.map(message => message.uid)).toEqual([3, 2]); expect(first.nextBefore).toBe(2);
    expect((await f.mail.list("Fixture", { before: first.nextBefore!, limit: 2 })).messages.map(message => message.uid)).toEqual([1]);
    await f.mail.list("Fixture", { query: "is:unread" }); expect(f.commands.some(line => line.includes("X-GM-RAW"))).toBe(true);
    expect((await f.mail.read("Fixture", "INBOX", 1)).text).toContain("Untrusted source text");
    const message = await f.mail.read("Fixture", "INBOX", 1);
    expect(message.hasAttachments).toBe(true);
    expect(message.attachments[0]?.filename).toBe("evidence.txt");
    expect((await f.mail.attachment("Fixture", "INBOX", 1, message.attachments[0]!.part)).bytes.toString()).toContain("Isolated attachment evidence.");
    expect(f.commands.filter(line => / FETCH .*BODY\[/i.test(line))).toHaveLength(0);
    expect(f.commands.some(line => line.includes("BODY.PEEK[]"))).toBe(true);
    expect(f.commands.some(line => / SELECT /i.test(line))).toBe(false);
    const response = await serveMail(new Request("http://fixture/api/mail/mail-account/message?uid=1"), new URL("http://fixture/api/mail/mail-account/message?uid=1"), f.mail);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  } finally { await f.close(); }
});

for (const gmail of [false, true]) test(`archive/trash use safe UID MOVE (${gmail ? "Gmail All" : "generic Archive"})`, async () => {
  const f = await fixture(gmail);
  try {
    expect(await f.mail.update("Fixture", "INBOX", [1], "archive")).toEqual({ updated: 1 });
    expect(await f.mail.update("Fixture", "INBOX", [2], "trash")).toEqual({ updated: 1 });
    await f.mail.update("Fixture", "INBOX", [3], "seen");
    expect(f.commands.some(line => / UID MOVE 1 Archive/.test(line))).toBe(true);
    expect(f.commands.some(line => / UID MOVE 2 "?\[Gmail\]\/Trash/.test(line))).toBe(true);
    expect(f.commands.some(line => / UID STORE 3 .*\\Seen/.test(line))).toBe(true);
    await expect(f.mail.update("Fixture", "INBOX", [1], "move", "Missing")).rejects.toThrow();
  } finally { await f.close(); }
});

test("SMTPS reply headers and Sent APPEND contain one matching message ID; Gmail skips APPEND", async () => {
  for (const gmail of [false, true]) {
    const f = await fixture(gmail);
    try {
      const result = await f.mail.send("Fixture", { to: ["reply@example.com"], subject: "Re: Protocol source", text: "Approved reply body", replyTo: { mailbox: "INBOX", uid: 1 } });
      expect(f.sent).toHaveLength(1); expect(f.sent[0]).toContain("In-Reply-To: <source@example.com>");
      expect(f.sent[0]).toContain("References: <previous@example.com> <source@example.com>");
      expect(f.sent[0]).toContain("Subject: Re: Protocol source"); expect(f.sent[0]).toContain(result.messageId); expect(result.sentCopy).toBe(true);
      expect(f.appended).toHaveLength(gmail ? 0 : 1); if (!gmail) expect(f.appended[0]).toContain(result.messageId);
    } finally { await f.close(); }
  }
});

test("common mailbox names work without special-use; absent folders refuse moves but not sending", async () => {
  const f = await fixture(false, true);
  try { await f.mail.update("Fixture", "INBOX", [1], "archive"); await f.mail.update("Fixture", "INBOX", [1], "trash"); expect((await f.mail.send("Fixture", { to: ["to@example.com"], subject: "Test", text: "Body" })).sentCopy).toBe(true); }
  finally { await f.close(); }
  const missing = await fixture(false, false, true);
  try { await expect(missing.mail.update("Fixture", "INBOX", [1], "trash")).rejects.toThrow(); expect((await missing.mail.send("Fixture", { to: ["to@example.com"], subject: "Test", text: "Body" })).sentCopy).toBe(false); }
  finally { await missing.close(); }
});

test("sending refuses address/subject header injection, invalid recipients and oversized bodies before network", () => {
  for (const to of ["a@example.com\r\nBcc:evil@example.com", "Name <a@example.com>", "a..b@example.com", "a@example.com,b@example.com"]) expect(() => validateMailSend({ to: [to], subject: "Safe", text: "Body" })).toThrow();
  expect(() => validateMailSend({ to: ["a@example.com"], subject: "Safe\r\nBcc:evil@example.com", text: "Body" })).toThrow();
  expect(() => validateMailSend({ to: ["a@example.com"], subject: "Safe", text: "a".repeat(262145) })).toThrow();
  expect(() => validateMailSend({ to: ["a+b@example.com", '"quoted.local"@example.com'], subject: "한국어", text: "Body" })).not.toThrow();
});

test("prepared replies preserve approved subject and refuse replaced mailbox or original message", async () => {
  const f = await fixture();
  try {
    const original = await f.mail.read("Fixture", "INBOX", 1);
    const prepared = { to: ["reply@example.com"], subject: "Exact approved subject", text: "Approved body", replyTo: { mailbox: "INBOX", uid: 1, uidValidity: original.uidValidity, messageId: original.messageId } };
    await f.mail.send("Fixture", prepared);
    expect(f.sent[0]).toContain("Subject: Exact approved subject");
    expect(f.sent).toHaveLength(1);
    f.identity.uidValidity++;
    await expect(f.mail.send("Fixture", prepared)).rejects.toBeInstanceOf(NoEffect);
    expect(f.sent).toHaveLength(1);
    f.identity.uidValidity--;
    await expect(f.mail.send("Fixture", { ...prepared, replyTo: { ...prepared.replyTo, messageId: "<different@example.com>" } })).rejects.toBeInstanceOf(NoEffect);
    expect(f.sent).toHaveLength(1);
  } finally { await f.close(); }
});

test("queued sends recheck execution grants after the account queue and immediately before SMTP DATA", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let revoked = false, first = true;
  const f = await fixture(false, false, false, { beforeConnect: async () => {
    if (first) { first = false; entered.resolve(); await release.promise; }
  } });
  const authorize = () => { if (revoked) throw new NoEffect("Mail grant revoked"); };
  try {
    const reading = f.mail.mailboxes("Fixture");
    await entered.promise;
    const queued = f.mail.send("Fixture", { to: ["to@example.com"], subject: "Queued", text: "Body" }, { authorize });
    const queuedUpdate = f.mail.update("Fixture", "INBOX", [1], "trash", undefined, authorize);
    const sendRefusal = queued.then(() => null, error => error);
    const updateRefusal = queuedUpdate.then(() => null, error => error);
    revoked = true; release.resolve();
    await reading;
    expect(await sendRefusal).toBeInstanceOf(NoEffect);
    expect(await updateRefusal).toBeInstanceOf(NoEffect);
    expect(f.commands.some(command => / UID (STORE|MOVE) /i.test(command))).toBe(false);
    expect(f.sent).toHaveLength(0);
  } finally { release.resolve(); await f.close(); }
  revoked = false;
  const data = await fixture(false, false, false, { beforeData: () => { revoked = true; } });
  try {
    await expect(data.mail.send("Fixture", { to: ["to@example.com"], subject: "DATA", text: "Body" }, { authorize })).rejects.toBeInstanceOf(NoEffect);
    expect(data.sent).toHaveLength(0);
  } finally { await data.close(); }
});

test("revocation after SMTP acceptance records an unknown effect, never a no-effect denial", async () => {
  let revoked = false;
  const f = await fixture(true, false, false, { afterAcceptance: () => { revoked = true; } });
  const h = harness();
  const ghost = h.core.createGhost({ name: "Mail", persona: "", tools: ["mail_send"] });
  const authorize = () => { if (revoked) throw new NoEffect("Mail grant revoked after acceptance"); };
  try {
    await expect(h.core.effects.run({
      conversationId: ghost.directConversationId, callId: "accepted-then-revoked", tool: "mail_send", input: {}, summary: "Send approved mail",
    }, async () => JSON.stringify(await f.mail.send("Fixture", { to: ["to@example.com"], subject: "Accepted", text: "Body" }, { authorize })))).rejects.toMatchObject({ code: "unavailable" });
    expect(f.sent).toHaveLength(1);
    expect(h.ledger.effectsInState("unknown")).toHaveLength(1);
    expect(h.ledger.effectsInState("denied")).toHaveLength(0);
    expect(h.ledger.pendingDecisions().some(decision => decision.kind === "reconcile_effect")).toBe(true);
  } finally { await f.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); }
});

test("owner reply command preserves the authored subject through SMTP delivery", async () => {
  const f = await fixture();
  const h = harness();
  h.core.createGhost({ name: "Owner mail", persona: "", isDefault: true });
  try {
    const subject = "Owner edited reply subject";
    await execute(h.core, new Access({ kind: "owner" }), {
      requestId: crypto.randomUUID(),
      command: { type: "mail.send", connectionId: "mail-account", to: ["reply@example.com"], subject, text: "Owner reply body", replyTo: { mailbox: "INBOX", uid: 1 } },
    }, { publicOrigin: "http://fixture", documents: null, mail: f.mail });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toContain(`Subject: ${subject}`);
    expect(f.sent[0]).toContain("In-Reply-To: <source@example.com>");
    expect(f.sent[0]).not.toContain("Subject: Re: Protocol source");
  } finally { await f.close(); h.core.stop(); await h.core.idle(); h.ledger.close(); }
});
