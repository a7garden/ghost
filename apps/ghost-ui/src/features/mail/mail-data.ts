import createDOMPurify from 'dompurify';
import type { MailAddr, MailboxInfo, MailMessage, MailSendCommand, MailSummary } from '../../host/client';

/** Special-use mailboxes lead in the fixed reading order; everything else follows by name. */
const SPECIAL_USE_RANK: Partial<Record<NonNullable<MailboxInfo['specialUse']>, number>> = {
  inbox: 0, sent: 1, drafts: 2, archive: 3, junk: 4, trash: 5,
};

const SPECIAL_USE_LABELS: Record<NonNullable<MailboxInfo['specialUse']>, string> = {
  inbox: '받은편지함', sent: '보낸편지함', drafts: '임시보관함', archive: '보관함',
  junk: '스팸', trash: '휴지통', all: '모든 메일', flagged: '별표편지함',
};

/** What one mailbox row says: the special-use name when declared, else the server's name. */
export function mailboxLabel(mailbox: MailboxInfo): string {
  return mailbox.specialUse ? SPECIAL_USE_LABELS[mailbox.specialUse] : mailbox.name;
}

/** 받은편지함 · 보낸편지함 · 임시보관함 · 보관함 · 스팸 · 휴지통 first, the rest by name. Pure; tests pin it. */
export function orderMailboxes(mailboxes: readonly MailboxInfo[]): MailboxInfo[] {
  const rankOf = new Map(mailboxes.map(mailbox => [mailbox, mailbox.specialUse ? SPECIAL_USE_RANK[mailbox.specialUse] ?? 6 : 6]));
  return [...mailboxes].sort((a, b) => {
    const rankA = rankOf.get(a)!, rankB = rankOf.get(b)!;
    return rankA !== rankB ? rankA - rankB : a.name.localeCompare(b.name, 'ko');
  });
}

/** One mailbox's unseen marker after the owner read mail in it; unknown counts stay unknown. */
export function shiftMailboxUnseen(mailboxes: readonly MailboxInfo[], path: string, delta: number): MailboxInfo[] {
  return mailboxes.map(mailbox => mailbox.path !== path || mailbox.unseen === null ? mailbox
    : { ...mailbox, unseen: Math.max(0, mailbox.unseen + delta) });
}

/** The pseudo account that merges every account's 받은편지함 into one list. */
export const ALL_ACCOUNTS = '*';
/** The pseudo mailbox path paired with `ALL_ACCOUNTS`; no server mailbox has this name. */
export const ALL_INBOX = '*inbox';

/**
 * A listed message. The merged view carries its origin, because uids repeat across accounts;
 * a single account's list leaves these unset.
 */
export interface ListedMail extends MailSummary {
  accountId?: string;
  accountName?: string;
  mailboxPath?: string;
}

/** The list on screen plus the cursor for older pages. */
export interface MailListState {
  messages: ListedMail[];
  nextBefore: number | null;
  /** The committed search text the current page was fetched with. */
  query: string;
  /** Merged view only: each account's cursor for older mail, `null` once that account has no more. */
  cursors: Record<string, number | null>;
}

export const emptyMailList: MailListState = { messages: [], nextBefore: null, query: '', cursors: {} };

const sameOrigin = (message: ListedMail, accountId: string | undefined) => (message.accountId ?? '') === (accountId ?? '');
const listedKey = (message: ListedMail) => `${message.accountId ?? ''}\u0000${message.uid}`;

/** Append one fetched page: uids already on screen drop out, newest first is preserved. Pure; tests pin it. */
export function appendMailPage(state: MailListState, page: { messages: MailSummary[]; nextBefore: number | null }): MailListState {
  const seen = new Set(state.messages.map(message => message.uid));
  return { ...state, messages: [...state.messages, ...page.messages.filter(message => !seen.has(message.uid))], nextBefore: page.nextBefore };
}

/** Patch one message in place (읽음 · 별표); a message that already left the list is ignored. Pure; tests pin it. */
export function patchMailMessage(state: MailListState, uid: number, patch: Partial<MailSummary>, accountId?: string): MailListState {
  return { ...state, messages: state.messages.map(message => message.uid === uid && sameOrigin(message, accountId) ? { ...message, ...patch } : message) };
}

/** Drop one message from the list because it moved or left the mailbox. Pure; tests pin it. */
export function removeMailMessage(state: MailListState, uid: number, accountId?: string): MailListState {
  return { ...state, messages: state.messages.filter(message => !(message.uid === uid && sameOrigin(message, accountId))) };
}

/** One account's 받은편지함 for the merged view: the server's inbox, else a mailbox literally named INBOX. */
export function inboxMailbox(mailboxes: readonly MailboxInfo[]): MailboxInfo | null {
  return mailboxes.find(mailbox => mailbox.specialUse === 'inbox') ?? mailboxes.find(mailbox => mailbox.path.toUpperCase() === 'INBOX') ?? null;
}

/** A merged count is known only when every account reports its inbox's unseen count. */
export function mergedInboxUnseen(
  accounts: readonly { connectionId: string }[], mailboxes: ReadonlyMap<string, readonly MailboxInfo[]>,
): number | null {
  let total = 0;
  for (const { connectionId } of accounts) {
    const boxes = mailboxes.get(connectionId);
    const count = boxes && inboxMailbox(boxes)?.unseen;
    if (count == null) return null;
    total += count;
  }
  return total;
}

/** One account's page of its inbox, tagged for the merged list. */
export interface UnifiedPage {
  accountId: string;
  accountName: string;
  mailboxPath: string;
  messages: MailSummary[];
  nextBefore: number | null;
}

/** Newest first across accounts; equal dates fall back to account then uid so the order never flickers. */
const newestFirst = (a: ListedMail, b: ListedMail) =>
  b.date - a.date || (a.accountId ?? '').localeCompare(b.accountId ?? '') || b.uid - a.uid;

/** Fold fetched pages into the merged list; messages already shown drop out. Pure; tests pin it. */
export function mergeUnifiedPages(state: MailListState, pages: readonly UnifiedPage[]): MailListState {
  const shown = new Map(state.messages.map(message => [listedKey(message), message] as const));
  const cursors = { ...state.cursors };
  for (const page of pages) {
    cursors[page.accountId] = page.nextBefore;
    for (const message of page.messages) {
      const listed: ListedMail = { ...message, accountId: page.accountId, accountName: page.accountName, mailboxPath: page.mailboxPath };
      if (!shown.has(listedKey(listed))) shown.set(listedKey(listed), listed);
    }
  }
  return { ...state, messages: [...shown.values()].sort(newestFirst), cursors };
}

/** True while at least one account still has older mail to fetch. */
export const unifiedHasMore = (state: MailListState): boolean => Object.values(state.cursors).some(cursor => cursor !== null);

/**
 * Fold a fresh first page into a list that may already show older pages. New mail goes on top,
 * flags on mail the page also contains are refreshed, and the older-page cursor never moves.
 * Pure; tests pin it.
 */
export function refreshMailPage(state: MailListState, page: { messages: MailSummary[]; accountId?: string; accountName?: string; mailboxPath?: string }): MailListState {
  const origin = page.accountId;
  const fresh = new Map(page.messages.map(message => [message.uid, message] as const));
  const known = new Set(state.messages.filter(message => sameOrigin(message, origin)).map(message => message.uid));
  const added: ListedMail[] = page.messages.filter(message => !known.has(message.uid)).map(message => origin === undefined ? message
    : { ...message, accountId: origin, accountName: page.accountName, mailboxPath: page.mailboxPath });
  const updated = state.messages.map(message => {
    const next = sameOrigin(message, origin) ? fresh.get(message.uid) : undefined;
    if (!next || (next.seen === message.seen && next.flagged === message.flagged && next.answered === message.answered)) return message;
    return { ...message, seen: next.seen, flagged: next.flagged, answered: next.answered };
  });
  if (!added.length && updated.every((message, index) => message === state.messages[index])) return state;
  return { ...state, messages: origin === undefined ? [...added, ...updated] : [...added, ...updated].sort(newestFirst) };
}

/** A header address as people read it: the display name when there is one, else the address. */
export function mailAddressName(addr: MailAddr | null | undefined): string {
  return addr ? addr.name || addr.address : '(보낸 사람 없음)';
}

/** A header address in full, ready to paste into a compose field. */
export function mailAddressFull(addr: MailAddr): string {
  return addr.name ? `${addr.name} <${addr.address}>` : addr.address;
}

/** A recipient line, folded after `max` addresses so a long header stays one line. */
export function mailAddressList(addrs: readonly MailAddr[], max = 3): string {
  const shown = addrs.slice(0, max).map(mailAddressFull);
  const rest = addrs.length - shown.length;
  return shown.join(', ') + (rest > 0 ? ` 외 ${rest}명` : '');
}

/** Every non-empty token, so `a@b.c, d@e.f` and one address per line both work. */
export function parseMailAddresses(value: string): string[] {
  return value.split(/[\s,;]+/).map(token => token.trim()).filter(Boolean);
}

/** No scripts, forms, same-origin access, popups or top-level navigation. */
export const MAIL_IFRAME_SANDBOX = '';

/**
 * Preserve authored mail styles and links inside an opaque, CSP-protected frame.
 * Navigation metadata must be removed too: CSP does not stop a frame refreshing itself.
 */
export function mailHtmlDoc(html: string): string {
  const root = createDOMPurify(window).sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: ['meta', 'base', 'link'],
  }) as HTMLElement;
  const policy = root.ownerDocument.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
  const charset = root.ownerDocument.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  root.ownerDocument.head.prepend(policy, charset);
  return `<!doctype html>${root.outerHTML}`;
}

const headerDate = (at: number) =>
  new Date(at).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The quoted block a reply keeps beneath the new text, one `>` per original line. Pure; tests pin it. */
export function replyQuote(message: MailMessage): string {
  const header = `${headerDate(message.date)}, ${mailAddressName(message.replyTo[0] ?? message.from)} 작성:`;
  return [header, ...message.text.split('\n').map(line => `> ${line}`)].join('\n');
}

/** The block a forward carries: the original headers, then the body as received. Pure; tests pin it. */
export function forwardQuote(message: MailMessage): string {
  return [
    '전달하는 메일:',
    `보낸 사람: ${message.from ? mailAddressFull(message.from) : '(보낸 사람 없음)'}`,
    `받는 사람: ${message.to.map(mailAddressFull).join(', ') || '(없음)'}`,
    `제목: ${message.subject}`,
    `날짜: ${headerDate(message.date)}`,
    '',
    message.text,
  ].join('\n');
}

/** Re:/Fwd: exactly once; an already-prefixed subject keeps what it has. Pure; tests pin it. */
export const replySubject = (subject: string) => /^(re|답장)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
export const forwardSubject = (subject: string) => /^(fwd|전달)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;

/** A letter in progress; `reply` pins the message being answered. */
export interface MailComposeDraft {
  connectionId: string;
  to: string; cc: string; bcc: string; subject: string; text: string;
  reply?: { mailbox: string; uid: number };
}

/** Letter → mail.send. The body travels verbatim. Pure; tests pin it. */
export function buildMailSend(draft: MailComposeDraft): { ok: true; command: MailSendCommand } | { ok: false; error: string } {
  const to = parseMailAddresses(draft.to);
  if (!to.length) return { ok: false, error: '받는 사람을 한 명 이상 입력해 주세요.' };
  if (to.length > 50) return { ok: false, error: '받는 사람은 50명까지 적을 수 있습니다.' };
  const cc = parseMailAddresses(draft.cc);
  const bcc = parseMailAddresses(draft.bcc);
  if (cc.length > 50) return { ok: false, error: '참조는 50명까지 적을 수 있습니다.' };
  if (bcc.length > 50) return { ok: false, error: '숨은참조는 50명까지 적을 수 있습니다.' };
  const subject = draft.subject.trim();
  if (!subject) return { ok: false, error: '제목을 입력해 주세요.' };
  if (subject.length > 998) return { ok: false, error: '제목은 998자 이하여야 합니다.' };
  if (!draft.text.trim()) return { ok: false, error: '본문을 입력해 주세요.' };
  if (draft.text.length > 262144) return { ok: false, error: '본문이 너무 깁니다.' };
  return { ok: true, command: {
    type: 'mail.send', connectionId: draft.connectionId, to, subject, text: draft.text,
    ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), ...(draft.reply ? { replyTo: draft.reply } : {}),
  } };
}

/** 12.3 KB style; bytes stay exact below a kilobyte. */
export function mailSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
