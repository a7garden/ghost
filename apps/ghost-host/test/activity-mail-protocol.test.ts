import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { createSecureContext, createServer, TLSSocket } from "node:tls";
import type { Connection } from "@ghost/contract";
import { ImapFlow } from "imapflow";
import { SourceConnections } from "../src/integrations/activity-sources.ts";
import { activitySmtp } from "../src/integrations/activity-mail.ts";
import { cert, key } from "./fixtures/activity-tls.ts";

const PASSWORD = "local-fixture-app-password";
const source = Buffer.from("From: sender@example.com\r\nReply-To: reply@example.com\r\nTo: owner@example.com\r\nSubject: Local protocol check\r\nMessage-ID: <local-source@example.com>\r\nDate: Sun, 8 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nReal TLS mail source body.");
async function listen(server: Server) {
  const ready = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => ready.resolve());
  await ready.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Protocol fixture address unavailable");
  return address.port;
}
async function protocolFixture() {
  const sockets = new Set<TLSSocket>();
  const imapCommands: string[] = [];
  const smtpCommands: string[] = [];
  const sent: string[] = [];
  const track = (socket: TLSSocket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); };
  const imap = createServer({ key, cert }, socket => {
    track(socket);
    socket.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] Local fixture ready\r\n");
    let buffer = "";
    let authTag: string | null = null;
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (authTag) {
          const auth = Buffer.from(line, "base64").toString();
          imapCommands.push(`${authTag} [PLAIN response redacted]`);
          socket.write(auth.includes(`owner@example.com\0${PASSWORD}`) ? `${authTag} OK authenticated\r\n` : `${authTag} NO authentication failed\r\n`);
          authTag = null;
          continue;
        }
        imapCommands.push(line);
        const tag = line.split(" ")[0];
        if (/ CAPABILITY$/i.test(line)) socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR\r\n${tag} OK capability\r\n`);
        else if (/ AUTHENTICATE PLAIN$/i.test(line)) {
          authTag = tag!;
          socket.write("+ \r\n");
        }
        else if (/ AUTHENTICATE PLAIN /i.test(line)) {
          const auth = Buffer.from(line.split(" ").at(-1)!, "base64").toString();
          socket.write(auth.includes(`owner@example.com\0${PASSWORD}`) ? `${tag} OK authenticated\r\n` : `${tag} NO authentication failed\r\n`);
        } else if (/ LIST "" ""$/i.test(line)) socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK hierarchy delimiter\r\n`);
        else if (/ LIST /i.test(line)) socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK list\r\n`);
        else if (/ LSUB /i.test(line)) socket.write(`* LSUB (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK subscribed\r\n`);
        else if (/ EXAMINE /i.test(line)) socket.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] valid\r\n* OK [UIDNEXT 2] next\r\n* OK [PERMANENTFLAGS ()] readonly\r\n${tag} OK [READ-ONLY] selected\r\n`);
        else if (/ UID SEARCH /i.test(line)) socket.write(`* SEARCH 1\r\n${tag} OK search\r\n`);
        else if (/ UID FETCH /i.test(line)) {
          socket.write(line.includes("BODY.PEEK[]")
            ? Buffer.concat([Buffer.from(`* 1 FETCH (UID 1 RFC822.SIZE ${source.byteLength} BODY[]<0> {${source.byteLength}}\r\n`), source, Buffer.from(`)\r\n${tag} OK fetch\r\n`)])
            : `* 1 FETCH (UID 1 RFC822.SIZE ${source.byteLength})\r\n${tag} OK fetch\r\n`);
        }
        else if (/ LOGOUT$/i.test(line)) { socket.end(`* BYE goodbye\r\n${tag} OK logout\r\n`); }
        else socket.write(`${tag} BAD unsupported fixture command\r\n`);
      }
    });
  });
  imap.on("tlsClientError", () => {});
  const smtp = createServer({ key, cert }, socket => {
    track(socket);
    socket.write("220 localhost fixture SMTP\r\n");
    let buffer = "";
    let data = false;
    socket.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) break;
          sent.push(buffer.slice(0, end)); buffer = buffer.slice(end + 5); data = false;
          socket.write("250 2.0.0 accepted local fixture\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        smtpCommands.push(line);
        if (/^EHLO /i.test(line)) socket.write("250-localhost\r\n250-AUTH PLAIN\r\n250 SIZE 65536\r\n");
        else if (/^AUTH PLAIN /i.test(line)) {
          const auth = Buffer.from(line.slice(11), "base64").toString();
          socket.write(auth.includes(`owner@example.com\0${PASSWORD}`) ? "235 2.7.0 authenticated\r\n" : "535 5.7.8 denied\r\n");
        } else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write("250 2.1.0 accepted\r\n");
        else if (/^DATA$/i.test(line)) { data = true; socket.write("354 End with dot\r\n"); }
        else if (/^QUIT$/i.test(line)) socket.end("221 goodbye\r\n");
        else socket.write("500 unsupported fixture command\r\n");
      }
    });
  });
  smtp.on("tlsClientError", () => {});
  const imapPort = await listen(imap);
  const smtpPort = await listen(smtp);
  return {
    imapCommands, smtpCommands, sent,
    connection: { id: "local-mail", name: "Isolated TLS fixture", hasCredential: true, credentialVersion: "local-account-v1", createdAt: Date.parse("2026-11-08T10:00:00Z"), updatedAt: Date.parse("2026-11-08T10:00:00Z"), config: { kind: "mail", host: "127.0.0.1", port: imapPort, username: "owner@example.com", mailbox: "INBOX", smtpHost: "127.0.0.1", smtpPort, smtpSecure: true } } satisfies Connection,
    close() { for (const socket of sockets) socket.destroy(); imap.close(); smtp.close(); },
  };
}

test("real IMAPS EXAMINE/PEEK plus real SMTPS authenticate, read, and reply only to the bound source", async () => {
  const fixture = await protocolFixture();
  const root = mkdtempSync(join(tmpdir(), "ghost-mail-protocol-"));
  const sources = new SourceConnections({
    root,
    // Only this isolated server CA is added; certificate and hostname validation stay enabled.
    imap: options => new ImapFlow({ ...options, tls: { ...options.tls, ca: cert } }),
    smtp: options => activitySmtp({ ...options, tls: { ...options.tls, ca: cert } }),
  });
  try {
    await sources.setCredential(fixture.connection.id, PASSWORD, fixture.connection.credentialVersion);
    expect((await sources.test(fixture.connection)).summary).toContain("No message was sent");
    expect(fixture.sent).toHaveLength(0);
    const result = await sources.poll(fixture.connection, { kind: "mail", connectionId: fixture.connection.id, sender: null, subjectContains: null, unreadOnly: false, includeExisting: true, pollSeconds: 60 }, null);
    const item = result.items[0]!;
    expect(item.title).toBe("Local protocol check");
    expect(item.text).toContain("Real TLS mail source body");
    expect((await sources.read(fixture.connection, item)).version).toBe(item.version);
    await sources.act(fixture.connection, item, { kind: "mail_reply", body: "Approved local protocol reply." });
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toContain("To: reply@example.com");
    expect(fixture.sent[0]).toContain("In-Reply-To: <local-source@example.com>");
    expect(fixture.sent[0]).toContain("Approved local protocol reply.");
    expect(fixture.smtpCommands.some(command => /^RCPT TO:<reply@example.com>$/i.test(command))).toBe(true);
    expect(fixture.imapCommands.some(command => / EXAMINE /i.test(command))).toBe(true);
    expect(fixture.imapCommands.filter(command => / UID FETCH .*BODY/i.test(command)).every(command => command.includes("BODY.PEEK[]"))).toBe(true);
    expect(fixture.imapCommands.some(command => / (SELECT|STORE|APPEND|EXPUNGE) /i.test(command))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  } catch (error) {
    const imapTrace = fixture.imapCommands.map(line => line.replace(/ AUTHENTICATE .*/i, " AUTHENTICATE [redacted]")).join(" | ");
    const smtpTrace = fixture.smtpCommands.map(line => line.replace(/^AUTH .*/i, "AUTH [redacted]")).join(" | ");
    throw new Error(`Local mail protocol failure: ${error instanceof Error ? error.message : "unknown"}; IMAP: ${imapTrace}; SMTP: ${smtpTrace}`, { cause: error });
  } finally { await sources.close(); fixture.close(); rmSync(root, { recursive: true, force: true }); }
});

test("production IMAPS and SMTPS reject an untrusted certificate before account authentication", async () => {
  const fixture = await protocolFixture();
  const root = mkdtempSync(join(tmpdir(), "ghost-mail-untrusted-"));
  const sources = new SourceConnections({ root });
  const trustedImapOnly = new SourceConnections({ root, imap: options => new ImapFlow({ ...options, tls: { ...options.tls, ca: cert } }) });
  try {
    await sources.setCredential(fixture.connection.id, PASSWORD, fixture.connection.credentialVersion);
    await expect(sources.test(fixture.connection)).rejects.toThrow();
    expect(fixture.imapCommands).toHaveLength(0);
    await expect(trustedImapOnly.test(fixture.connection)).rejects.toThrow();
    expect(fixture.smtpCommands).toHaveLength(0);
    expect(fixture.sent).toHaveLength(0);
  } finally { await sources.close(); await trustedImapOnly.close(); fixture.close(); rmSync(root, { recursive: true, force: true }); }
});

type StartTlsMode = "upgrade" | "unavailable" | "refused" | "broken";

async function startTlsFixture(mode: StartTlsMode = "upgrade") {
  const sockets = new Set<Socket>();
  const commands: { verb: string; encrypted: boolean; protocol: string | null }[] = [];
  const sent: string[] = [];
  const secureContext = createSecureContext({ key, cert, minVersion: "TLSv1.2" });
  let connections = 0;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };
  const server = createTcpServer(socket => {
    connections++;
    track(socket);
    socket.write("220 localhost STARTTLS fixture\r\n");
    const parse = (transport: Socket, encrypted: boolean) => {
      let buffer = "";
      let data = false;
      const receive = (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          if (data) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) break;
            sent.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            data = false;
            transport.write("250 2.0.0 accepted local STARTTLS fixture\r\n");
            continue;
          }
          const end = buffer.indexOf("\r\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const verb = line.split(" ", 1)[0]!.toUpperCase();
          // Keep only command names, never credential-bearing AUTH arguments.
          commands.push({ verb, encrypted, protocol: transport instanceof TLSSocket ? transport.getProtocol() : null });
          if (verb === "EHLO") {
            transport.write(!encrypted && mode !== "unavailable"
              ? "250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n"
              : "250-localhost\r\n250 AUTH PLAIN\r\n");
          } else if (verb === "STARTTLS" && !encrypted) {
            if (mode === "unavailable" || mode === "refused") {
              transport.write("454 4.7.0 TLS unavailable\r\n");
              continue;
            }
            transport.removeListener("data", receive);
            transport.write("220 2.0.0 Ready to start TLS\r\n");
            if (mode === "broken") {
              transport.end();
            } else {
              const upgraded = new TLSSocket(transport, { isServer: true, secureContext });
              track(upgraded);
              parse(upgraded, true);
            }
            return;
          } else if (verb === "AUTH") {
            const auth = Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString();
            transport.write(encrypted && auth === `\0owner@example.com\0${PASSWORD}`
              ? "235 2.7.0 authenticated\r\n"
              : "535 5.7.8 denied\r\n");
          } else if (/^(MAIL FROM|RCPT TO):/i.test(line)) {
            transport.write("250 2.1.0 accepted\r\n");
          } else if (verb === "DATA") {
            data = true;
            transport.write("354 End with dot\r\n");
          } else if (verb === "QUIT") {
            transport.end("221 goodbye\r\n");
          } else {
            transport.write("500 unsupported fixture command\r\n");
          }
        }
      };
      transport.on("data", receive);
    };
    parse(socket, false);
  });
  const port = await listen(server);
  return {
    port, commands, sent,
    get connections() { return connections; },
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

function startTlsClient(port: number, trust: "fixture" | "untrusted" | "wrong-host" = "fixture") {
  return activitySmtp({
    host: "127.0.0.1", port, secure: false, requireTLS: true, opportunisticTLS: false,
    tls: {
      rejectUnauthorized: true, minVersion: "TLSv1.2",
      ...(trust !== "untrusted" ? { ca: cert } : {}),
      ...(trust === "wrong-host" ? { servername: "wrong-host.invalid" } : {}),
    },
    connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000,
    auth: { user: "owner@example.com", pass: PASSWORD },
  });
}

const startTlsMessage = {
  from: "owner@example.com", to: "recipient@example.com",
  subject: "Verified STARTTLS delivery", text: "One approved encrypted message.",
};

test("real STARTTLS verifies TLS, authenticates only after upgrade, and sends DATA exactly once", async () => {
  const fixture = await startTlsFixture();
  const client = startTlsClient(fixture.port);
  const effects: string[] = [];
  try {
    expect(await client.sendMail(startTlsMessage, () => effects.push("authorize"), () => effects.push("write")))
      .toEqual({ accepted: ["recipient@example.com"], rejected: [] });
    expect(fixture.connections).toBe(1);
    expect(fixture.commands.map(command => command.verb)).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
    expect(fixture.commands.slice(0, 2).every(command => !command.encrypted && command.protocol === null)).toBe(true);
    expect(fixture.commands.slice(2).every(command => command.encrypted && /^TLSv1\.[23]$/.test(command.protocol ?? ""))).toBe(true);
    expect(effects).toEqual(["authorize", "authorize", "write"]);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.sent[0]).toContain("To: recipient@example.com");
    expect(fixture.sent[0]).toContain("One approved encrypted message.");
  } finally { client.close(); await fixture.close(); }
});

for (const scenario of [
  { name: "unadvertised and unavailable TLS", mode: "unavailable", trust: "fixture" },
  { name: "refused STARTTLS", mode: "refused", trust: "fixture" },
  { name: "failed TLS handshake", mode: "broken", trust: "fixture" },
  { name: "untrusted certificate", mode: "upgrade", trust: "untrusted" },
  { name: "certificate hostname mismatch", mode: "upgrade", trust: "wrong-host" },
] as const) test(`real STARTTLS refuses ${scenario.name} without AUTH or DATA`, async () => {
  const fixture = await startTlsFixture(scenario.mode);
  const client = startTlsClient(fixture.port, scenario.trust);
  let authorizations = 0;
  let writes = 0;
  try {
    await expect(client.sendMail(startTlsMessage, () => authorizations++, () => writes++)).rejects.toThrow();
    expect(fixture.connections).toBe(1);
    expect(fixture.commands.map(command => command.verb)).toEqual(["EHLO", "STARTTLS"]);
    expect(fixture.commands.every(command => !command.encrypted)).toBe(true);
    expect(fixture.sent).toHaveLength(0);
    expect(authorizations).toBe(0);
    expect(writes).toBe(0);
  } finally { client.close(); await fixture.close(); }
});
