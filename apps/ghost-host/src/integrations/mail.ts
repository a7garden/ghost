import { randomUUID } from "node:crypto";
import type { Connection } from "@ghost/contract";
import { ImapFlow, type ImapFlowOptions, type FetchMessageObject } from "imapflow";
import PostalMime, { type Email } from "postal-mime";
import MailComposer from "nodemailer/lib/mail-composer";
import { activitySmtp, type ActivitySmtpClient, type ActivitySmtpOptions } from "./activity-mail.ts";
import type { SourceConnections } from "./activity-sources.ts";
import { CommandError, invalid, notFound } from "../core/errors.ts";
import { NoEffect } from "../core/effects.ts";

const MAX_RAW = 25 * 1024 * 1024;
export class MailTooLarge extends Error {}
export interface Addr { name: string; address: string }
export interface MailMailbox {
  path: string; name: string; delimiter: string | null;
  specialUse: "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all" | "flagged" | null;
  total: number | null; unseen: number | null;
}
export interface MailSummary {
  uid: number; messageId: string | null; from: Addr | null; to: Addr[]; subject: string; date: number;
  seen: boolean; flagged: boolean; answered: boolean; hasAttachments: boolean; size: number;
}
export interface MailMessage extends MailSummary {
  uidValidity: number;
  cc: Addr[]; replyTo: Addr[]; text: string; html: string | null;
  attachments: { part: string; filename: string; contentType: string; size: number }[];
}
export interface MailSend {
  to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string;
  replyTo?: { mailbox: string; uid: number; uidValidity?: number; messageId?: string | null };
}
export type MailAction = "seen" | "unseen" | "flag" | "unflag" | "archive" | "trash" | "move";
interface Options {
  connections(): Connection[];
  sources: Pick<SourceConnections, "credentialPresent" | "mailAuthority">;
  imap?: (options: ImapFlowOptions) => ImapFlow;
  smtp?: (options: ActivitySmtpOptions) => ActivitySmtpClient;
}
const mailboxName = (value: string) => {
  if (!value || value.length > 1024 || /[\r\n\0]/.test(value)) throw invalid("올바른 메일함을 선택해 주세요.");
  return value;
};
const uidValue = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) throw invalid("올바른 메일 UID가 필요합니다.");
  return value;
};
/** Bare RFC 5322 addr-spec only: display names, lists, comments and header injection are refused. */
export function mailAddress(value: string): string {
  const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
  const local = `(?:${atom}(?:\\.${atom})*|\"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*\")`;
  const domain = "(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*";
  if (typeof value !== "string" || value.length > 254 || /[\r\n\0]/.test(value) || !new RegExp(`^${local}@(?:${domain}|\\[(?:[0-9A-Fa-f:.]+|IPv6:[0-9A-Fa-f:.]+)\\])$`).test(value)) throw invalid("이메일 주소는 이름 없이 올바른 주소만 입력해 주세요.");
  return value;
}
export function validateMailSend(input: MailSend): void {
  for (const [key, values] of Object.entries({ to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [] })) {
    if (!Array.isArray(values) || values.length > 50 || (key === "to" && !values.length)) throw invalid("받는 사람은 1–50명까지 지정할 수 있습니다.");
    for (const address of values) mailAddress(address);
  }
  if (typeof input.subject !== "string" || Buffer.byteLength(input.subject) > 998 || /[\r\n\0]/.test(input.subject)) throw invalid("제목은 줄바꿈 없이 998바이트 이내로 입력해 주세요.");
  if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 256 * 1024 || input.text.includes("\0")) throw invalid("메일 본문은 256 KiB 이내여야 합니다.");
  if (input.replyTo) { mailboxName(input.replyTo.mailbox); uidValue(input.replyTo.uid); }
}
const addr = (value: { name?: string; address?: string } | undefined): Addr | null => value?.address ? { name: value.name ?? "", address: value.address } : null;
const addresses = (values: readonly { name?: string; address?: string; group?: unknown }[] | undefined): Addr[] => (values ?? []).flatMap(value => { const result = addr(value); return result ? [result] : []; });
const safeId = (value: string | undefined) => value && value.length <= 998 && /^<[^<>\s\r\n]+@[^<>\s\r\n]+>$/.test(value) ? value : undefined;
const specialUses = { "\\Inbox": "inbox", "\\Sent": "sent", "\\Drafts": "drafts", "\\Trash": "trash", "\\Junk": "junk", "\\Archive": "archive", "\\All": "all", "\\Flagged": "flagged" } as const;
function attachmentSize(content: string | ArrayBuffer | Uint8Array): number { return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength; }
function hasAttachment(node: FetchMessageObject["bodyStructure"]): boolean {
  return !!node && (node.disposition?.toLowerCase() === "attachment" || !!node.dispositionParameters?.filename || !!node.parameters?.name || (node.childNodes ?? []).some(hasAttachment));
}
function summary(message: FetchMessageObject): MailSummary {
  const envelope = message.envelope;
  const date = envelope?.date ?? message.internalDate;
  const timestamp = date ? new Date(date).getTime() : 0;
  return { uid: message.uid, messageId: envelope?.messageId ?? null, from: addr(envelope?.from?.[0]), to: addresses(envelope?.to), subject: envelope?.subject ?? "", date: Number.isFinite(timestamp) ? timestamp : 0,
    seen: !!message.flags?.has("\\Seen"), flagged: !!message.flags?.has("\\Flagged"), answered: !!message.flags?.has("\\Answered"), hasAttachments: hasAttachment(message.bodyStructure), size: message.size ?? 0 };
}

/** Short-lived, serialized, TLS-only sessions. Raw provider errors never cross this boundary. */
export class MailService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly active = new Set<() => void>();
  private closed = false;
  constructor(private readonly options: Options) {}
  accounts() {
    return this.options.connections().filter(connection => connection.config.kind === "mail" && this.options.sources.credentialPresent(connection.id)).map(connection => ({ connectionId: connection.id, name: connection.name, address: connection.config.kind === "mail" ? connection.config.username : "", canSend: connection.config.kind === "mail" && !!connection.config.smtpHost }));
  }
  resolve(account: string): Connection {
    const accounts = this.options.connections().filter(connection => connection.config.kind === "mail" && (connection.id === account || connection.name === account));
    const exact = accounts.find(connection => connection.id === account);
    if (!exact && accounts.length !== 1) throw notFound("메일 계정이 없거나 이름이 중복됩니다. 설정에서 계정을 확인해 주세요.");
    return exact ?? accounts[0]!;
  }
  private operation<T>(account: string, writable: boolean, run: (client: ImapFlow, authorize: () => void, credential: string, track: (close: () => void) => void) => Promise<T>, executionGuard?: () => void): Promise<T> {
    const connection = this.resolve(account);
    const previous = this.queues.get(connection.id) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(async () => {
      if (this.closed) throw new CommandError("unavailable", "메일 연결이 닫혔습니다.");
      executionGuard?.();
      const config = connection.config;
      if (config.kind !== "mail") throw invalid("메일 계정이 아닙니다.");
      let authority: { credential: string; authorize(): void };
      try { authority = this.options.sources.mailAuthority(connection); }
      catch { throw new CommandError("unavailable", "메일 계정이나 앱 비밀번호가 변경되었습니다. 계정을 다시 연결해 주세요."); }
      const authorize = () => {
        if (this.closed) throw new CommandError("unavailable", "메일 연결이 닫혔습니다.");
        try { authority.authorize(); } catch { throw new CommandError("unavailable", "메일 계정 권한이 변경되었습니다."); }
        executionGuard?.();
      };
      const client = (this.options.imap ?? (options => new ImapFlow(options)))({
        host: config.host, port: config.port, secure: true, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
        auth: { user: config.username, pass: authority.credential }, logger: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000,
        maxLiteralSize: MAX_RAW + 65536, maxResponseSize: MAX_RAW + 131072, maxLineLength: 65536, maxResponseTokens: 20000,
      });
      client.on("error", () => {});
      const closers = new Set<() => void>([() => client.close()]);
      const close = () => { for (const stop of closers) stop(); };
      this.active.add(close);
      const timeout = Promise.withResolvers<never>();
      const timer = setTimeout(() => { close(); timeout.reject(new CommandError("unavailable", writable ? "메일 처리 결과를 확인할 수 없습니다. 자동으로 다시 보내지 않습니다. 보낸편지함을 확인해 주세요." : "메일 연결 시간이 초과되었습니다.")); }, 60_000);
      try {
        return await Promise.race([(async () => { authorize(); await client.connect(); authorize(); const result = await run(client, authorize, authority.credential, stop => closers.add(stop)); authorize(); return result; })(), timeout.promise]);
      } catch (error) {
        if (error instanceof CommandError || error instanceof MailTooLarge || error instanceof NoEffect) throw error;
        throw new CommandError("unavailable", writable ? "메일 작업 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다. 메일함에서 결과를 확인해 주세요." : "메일 서버에 연결하지 못했습니다. TLS 서버 주소, 권한과 앱 비밀번호를 확인해 주세요.");
      } finally { clearTimeout(timer); close(); this.active.delete(close); }
    });
    this.queues.set(connection.id, running);
    void running.finally(() => { if (this.queues.get(connection.id) === running) this.queues.delete(connection.id); }).catch(() => {});
    return running;
  }
  async mailboxes(account: string): Promise<MailMailbox[]> {
    return this.operation(account, false, async (client, authorize) => {
      const list = await client.list();
      const result = [];
      for (const box of list) {
        if (box.flags.has("\\Noselect")) continue;
        authorize();
        const status = await client.status(box.path, { messages: true, unseen: true });
        if (!status) throw new CommandError("unavailable", "메일함 상태를 확인할 수 없습니다.");
        result.push({ path: box.path, name: box.name, delimiter: box.delimiter ?? null, specialUse: box.path.toUpperCase() === "INBOX" ? "inbox" as const : specialUses[box.specialUse as keyof typeof specialUses] ?? null, total: status.messages ?? null, unseen: status.unseen ?? null });
      }
      return result;
    });
  }
  async list(account: string, options: { mailbox?: string; query?: string; before?: number; limit?: number; unreadOnly?: boolean } = {}) {
    const mailbox = mailboxName(options.mailbox ?? "INBOX"), limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.before !== undefined && !Number.isSafeInteger(options.before))) throw invalid("메일 목록 범위가 올바르지 않습니다.");
    if (options.before !== undefined) uidValue(options.before);
    if (options.query !== undefined && (options.query.length > 2048 || /[\r\n\0]/.test(options.query))) throw invalid("검색어는 줄바꿈 없이 2048자 이내여야 합니다.");
    return this.operation(account, false, async (client, authorize) => {
      const box = await client.mailboxOpen(mailbox, { readOnly: true });
      const search = options.query ? (client.capabilities.has("X-GM-EXT-1") ? { gmraw: options.query } : { or: [{ subject: options.query }, { from: options.query }, { body: options.query }] }) : {};
      const upper = Math.min((options.before ?? box.uidNext) - 1, box.uidNext - 1);
      const found = upper < 1 ? [] : await client.search({ ...search, uid: `1:${upper}`, ...(options.unreadOnly ? { seen: false } : {}) }, { uid: true });
      const uids = (found || []).filter(uid => Number.isSafeInteger(uid) && uid > 0 && uid <= upper).sort((a, b) => b - a);
      const selected = [...new Set(uids)].slice(0, limit), messages: MailSummary[] = [];
      for (const uid of selected) { authorize(); const message = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true }, { uid: true }); if (message) messages.push(summary(message)); }
      return { mailbox, uidValidity: Number(box.uidValidity), messages, nextBefore: uids.length > limit ? selected.at(-1)! : null };
    });
  }
  private async raw(client: ImapFlow, mailbox: string, uid: number, authorize: () => void, expectedValidity?: number): Promise<{ message: FetchMessageObject; email: Email; uidValidity: number }> {
    const box = await client.mailboxOpen(mailboxName(mailbox), { readOnly: true });
    const uidValidity = Number(box.uidValidity);
    if (expectedValidity !== undefined && uidValidity !== expectedValidity) throw new NoEffect("승인 이후 메일함이 새로 만들어졌습니다. 원본을 다시 읽고 새 승인을 받아 주세요.");
    authorize();
    const meta = await client.fetchOne(String(uidValue(uid)), { uid: true, size: true }, { uid: true });
    if (!meta || meta.uid !== uid) throw notFound("메일이 더 이상 이 메일함에 없습니다.");
    if ((meta.size ?? 0) > MAX_RAW) throw new MailTooLarge("메일 원문은 25 MiB까지 열 수 있습니다.");
    authorize();
    const message = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, size: true, internalDate: true, bodyStructure: true, source: { start: 0, maxLength: MAX_RAW + 1 } }, { uid: true });
    if (!message || message.uid !== uid || !message.source) throw notFound("메일 원문이 없습니다.");
    if (message.source.byteLength > MAX_RAW || (message.size ?? 0) > MAX_RAW) throw new MailTooLarge("메일 원문은 25 MiB까지 열 수 있습니다.");
    const email = await PostalMime.parse(message.source, { maxNestingDepth: 32, maxHeadersSize: 65536, maxPartCount: 256, maxRfc822NestingDepth: 0, maxForwardedAddresses: 128 });
    return { message, email, uidValidity };
  }
  async read(account: string, mailbox: string, uid: number): Promise<MailMessage> {
    return this.operation(account, false, async (client, authorize) => {
      const { message, email, uidValidity } = await this.raw(client, mailbox, uid, authorize);
      return { ...summary(message), uidValidity, messageId: email.messageId ?? null, from: addr(email.from), to: addresses(email.to), subject: email.subject ?? "", cc: addresses(email.cc), replyTo: addresses(email.replyTo), text: Buffer.from(email.text ?? "").subarray(0, 512 * 1024).toString("utf8"), html: email.html ? Buffer.from(email.html).subarray(0, 1024 * 1024).toString("utf8") : null,
        hasAttachments: email.attachments.length > 0, attachments: email.attachments.map((item, index) => ({ part: String(index + 1), filename: item.filename ?? "attachment", contentType: item.mimeType, size: attachmentSize(item.content) })) };
    });
  }
  async attachment(account: string, mailbox: string, uid: number, part: string) {
    if (!/^[1-9][0-9]{0,2}$/.test(part)) throw invalid("첨부파일 번호가 올바르지 않습니다.");
    return this.operation(account, false, async (client, authorize) => {
      const { email } = await this.raw(client, mailbox, uid, authorize), item = email.attachments[Number(part) - 1];
      if (!item) throw notFound("첨부파일이 없습니다.");
      const bytes = typeof item.content === "string" ? Buffer.from(item.content) : item.content instanceof ArrayBuffer ? Buffer.from(item.content) : Buffer.from(item.content);
      if (bytes.byteLength > MAX_RAW) throw new MailTooLarge("첨부파일은 25 MiB까지 받을 수 있습니다.");
      return { bytes, filename: item.filename ?? "attachment", contentType: item.mimeType };
    });
  }
  async update(account: string, mailbox: string, uids: number[], action: MailAction, target?: string, executionGuard?: () => void) {
    try {
      mailboxName(mailbox);
      this.resolve(account);
      if (!Array.isArray(uids) || !uids.length || uids.length > 500) throw invalid("한 번에 1–500개의 메일을 선택해 주세요.");
      uids.forEach(uidValue);
      if (!["seen", "unseen", "flag", "unflag", "archive", "trash", "move"].includes(action)) throw invalid("메일 동작이 올바르지 않습니다.");
    } catch (error) { throw new NoEffect(error instanceof CommandError ? error.message : "메일 변경 요청이 올바르지 않습니다."); }
    let writeStarted = false;
    return this.operation(account, true, async (client, authorize) => {
      let destination: string | undefined;
      if (["archive", "trash", "move"].includes(action)) {
        const list = await client.list();
        const flag = action === "trash" ? "\\Trash" : client.capabilities.has("X-GM-EXT-1") ? "\\All" : "\\Archive";
        const names = action === "trash" ? ["trash", "deleted messages", "deleted items", "휴지통"] : ["archive", "archives", "보관함"];
        destination = action === "move" ? list.find(box => box.path === target && !box.flags.has("\\Noselect"))?.path : list.find(box => box.specialUse === flag && !box.flags.has("\\Noselect"))?.path ?? list.find(box => names.includes(box.path.toLowerCase()) && !box.flags.has("\\Noselect"))?.path;
        if (!destination) throw invalid("대상 메일함이 없습니다. 설정된 보관함·휴지통을 확인해 주세요.");
        if (destination === mailbox) throw invalid("현재 메일함과 다른 대상 메일함을 선택해 주세요.");
      }
      await client.mailboxOpen(mailbox, { readOnly: false });
      const existing = await client.search({ uid: [...new Set(uids)].join(",") }, { uid: true });
      const selected = (existing || []).filter(uid => uids.includes(uid));
      if (!selected.length) return { updated: 0 };
      authorize(); writeStarted = true;
      if (destination) await client.messageMove(selected, destination, { uid: true });
      else if (action === "seen" || action === "flag") await client.messageFlagsAdd(selected, [action === "seen" ? "\\Seen" : "\\Flagged"], { uid: true });
      else await client.messageFlagsRemove(selected, [action === "unseen" ? "\\Seen" : "\\Flagged"], { uid: true });
      return { updated: selected.length };
    }, executionGuard).catch(error => {
      if (!writeStarted) throw error instanceof NoEffect ? error : new NoEffect(error instanceof CommandError ? error.message : "메일을 변경하기 전에 요청이 거절되었습니다.");
      if (error instanceof NoEffect) throw new CommandError("unavailable", "메일 변경 중 권한이 취소되어 결과를 확인할 수 없습니다. 메일함에서 결과를 확인해 주세요.");
      throw error;
    });
  }
  async send(account: string, input: MailSend, options: { authorize?: () => void } = {}): Promise<{ messageId: string; sentCopy: boolean }> {
    let config: Extract<Connection["config"], { kind: "mail" }>, from: string;
    try {
      validateMailSend(input);
      const selected = this.resolve(account).config;
      if (selected.kind !== "mail" || !selected.smtpHost) throw invalid("이 계정은 SMTP 보내기 설정이 필요합니다.");
      config = selected;
      from = mailAddress(config.username);
    } catch (error) { throw new NoEffect(error instanceof CommandError ? error.message : "메일 보내기 요청이 올바르지 않습니다."); }
    let writeStarted = false;
    return this.operation(account, true, async (client, authorize, credential, track) => {
      let inReplyTo: string | undefined, references: string[] | undefined;
      if (input.replyTo) {
        const { email } = await this.raw(client, input.replyTo.mailbox, input.replyTo.uid, authorize, input.replyTo.uidValidity);
        if (input.replyTo.messageId !== undefined && (email.messageId ?? null) !== input.replyTo.messageId) throw new NoEffect("승인한 원본 메일과 현재 메일이 다릅니다. 다시 읽고 새 승인을 받아 주세요.");
        inReplyTo = safeId(email.messageId);
        references = [...(email.references ?? "").split(/\s+/).map(safeId).filter((id): id is string => !!id).slice(-20), ...(inReplyTo ? [inReplyTo] : [])];
      }
      const messageId = `<${randomUUID()}@ghost.local>`;
      const message = { from: { name: "", address: from }, to: input.to.map(address => ({ name: "", address })), cc: input.cc?.map(address => ({ name: "", address })), bcc: input.bcc?.map(address => ({ name: "", address })), envelope: { from, to: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])] }, subject: input.subject, text: input.text, messageId, ...(inReplyTo ? { inReplyTo, references } : {}), disableFileAccess: true, disableUrlAccess: true };
      const smtp = (this.options.smtp ?? activitySmtp)({ host: config.smtpHost!, port: config.smtpPort, secure: config.smtpSecure, requireTLS: true, opportunisticTLS: false, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" }, auth: { user: config.username, pass: credential }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 15_000, dnsTimeout: 15_000, logger: false, debug: false, transactionLog: false, maxResponseSize: 65536 });
      track(() => smtp.close());
      authorize();
      const result = await smtp.sendMail(message, authorize, () => { writeStarted = true; });
      if (!result.accepted.length || result.rejected.length) throw new CommandError("unavailable", "일부 수신자의 전송 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다.");
      smtp.close();
      let sentCopy = client.capabilities.has("X-GM-EXT-1");
      if (!sentCopy) {
        const boxes = await client.list();
        const sent = boxes.find(box => box.specialUse === "\\Sent") ?? boxes.find(box => ["sent", "sent messages", "sent items", "보낸편지함"].includes(box.path.toLowerCase()) && !box.flags.has("\\Noselect"));
        if (sent) {
          const raw = await new MailComposer(message).compile().build();
          authorize();
          await client.append(sent.path, raw, ["\\Seen"]);
          sentCopy = true;
        }
      }
      return { messageId, sentCopy };
    }, options.authorize).catch(error => {
      if (!writeStarted) throw error instanceof NoEffect ? error : new NoEffect(error instanceof CommandError ? error.message : "SMTP 전송을 시작하기 전에 요청이 거절되었습니다.");
      if (error instanceof NoEffect) throw new CommandError("unavailable", "전송 중 권한이 변경되어 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다. 보낸편지함을 확인해 주세요.");
      throw error;
    });
  }
  async close(): Promise<void> { this.closed = true; for (const close of this.active) close(); await Promise.allSettled(this.queues.values()); }
}
