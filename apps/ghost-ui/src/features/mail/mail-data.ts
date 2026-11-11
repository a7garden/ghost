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

/** The mailbox a fresh view opens: the first after ordering (받은편지함 when the server has one). */
export function defaultMailbox(mailboxes: readonly MailboxInfo[]): MailboxInfo | null {
  return orderMailboxes(mailboxes)[0] ?? null;
}

/** One mailbox's unseen marker after the owner read mail in it; unknown counts stay unknown. */
export function shiftMailboxUnseen(mailboxes: readonly MailboxInfo[], path: string, delta: number): MailboxInfo[] {
  return mailboxes.map(mailbox => mailbox.path !== path || mailbox.unseen === null ? mailbox
    : { ...mailbox, unseen: Math.max(0, mailbox.unseen + delta) });
}

/** The list on screen plus the cursor for older pages. */
export interface MailListState {
  messages: MailSummary[];
  nextBefore: number | null;
  /** The committed search text the current page was fetched with. */
  query: string;
}

export const emptyMailList: MailListState = { messages: [], nextBefore: null, query: '' };

/** Append one fetched page: uids already on screen drop out, newest first is preserved. Pure; tests pin it. */
export function appendMailPage(state: MailListState, page: { messages: MailSummary[]; nextBefore: number | null }): MailListState {
  const seen = new Set(state.messages.map(message => message.uid));
  return { ...state, messages: [...state.messages, ...page.messages.filter(message => !seen.has(message.uid))], nextBefore: page.nextBefore };
}

/** Patch one message in place (읽음 · 별표); a message that already left the list is ignored. Pure; tests pin it. */
export function patchMailMessage(state: MailListState, uid: number, patch: Partial<MailSummary>): MailListState {
  return { ...state, messages: state.messages.map(message => message.uid === uid ? { ...message, ...patch } : message) };
}

/** Drop one message from the list because it moved or left the mailbox. Pure; tests pin it. */
export function removeMailMessage(state: MailListState, uid: number): MailListState {
  return { ...state, messages: state.messages.filter(message => message.uid !== uid) };
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

/** What the compose sheet holds, as input strings; `reply` pins the message being answered. */
export interface MailComposeDraft {
  connectionId: string;
  to: string; cc: string; bcc: string; subject: string; text: string;
  reply?: { mailbox: string; uid: number };
}

/** Compose sheet → mail.send. The body travels verbatim. Pure; tests pin it. */
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
