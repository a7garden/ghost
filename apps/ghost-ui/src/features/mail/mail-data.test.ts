import { describe, expect, it } from 'vitest';
import type { MailboxInfo, MailMessage, MailSummary } from '../../host/client';
import {
  appendMailPage, buildMailSend, defaultMailbox, emptyMailList, forwardQuote,
  forwardSubject, mailboxLabel, mailSizeLabel, mailAddressName, mailAddressList,
  orderMailboxes, patchMailMessage, parseMailAddresses, removeMailMessage, replyQuote,
  replySubject, shiftMailboxUnseen,
} from './mail-data';

const mailbox = (path: string, specialUse: MailboxInfo['specialUse'] = null, name = path, unseen: number | null = 1): MailboxInfo =>
  ({ path, name, delimiter: '/', specialUse, total: 10, unseen });

const summary = (uid: number, patch: Partial<MailSummary> = {}): MailSummary => ({
  uid, messageId: `<m${uid}@e.com>`, from: { name: '발신자', address: 'from@example.com' },
  to: [{ name: '', address: 'me@example.com' }], subject: `제목 ${uid}`, date: uid,
  seen: true, flagged: false, answered: false, hasAttachments: false, size: 100, ...patch,
});

const message = (patch: Partial<MailMessage> = {}): MailMessage => ({
  ...summary(7), cc: [], replyTo: [], text: '첫 줄\n둘째 줄', html: null, attachments: [], ...patch,
});

describe('mailbox ordering and labels', () => {
  it('puts special-use mailboxes first in the fixed order, the rest by Korean name', () => {
    const ordered = orderMailboxes([
      mailbox('Custom', null, '메모'),
      mailbox('Trash', 'trash'),
      mailbox('INBOX', 'inbox'),
      mailbox('Notes', null, '게시판'),
      mailbox('Junk', 'junk'),
      mailbox('Sent', 'sent'),
      mailbox('Archive', 'archive'),
      mailbox('Drafts', 'drafts'),
    ]);
    expect(ordered.map(item => item.path)).toEqual(['INBOX', 'Sent', 'Drafts', 'Archive', 'Junk', 'Trash', 'Notes', 'Custom']);
  });

  it('names special-use mailboxes in Korean and keeps server names for the rest', () => {
    expect(mailboxLabel(mailbox('INBOX', 'inbox'))).toBe('받은편지함');
    expect(mailboxLabel(mailbox('Sent', 'sent'))).toBe('보낸편지함');
    expect(mailboxLabel(mailbox('Drafts', 'drafts'))).toBe('임시보관함');
    expect(mailboxLabel(mailbox('Archive', 'archive'))).toBe('보관함');
    expect(mailboxLabel(mailbox('Junk', 'junk'))).toBe('스팸');
    expect(mailboxLabel(mailbox('Trash', 'trash'))).toBe('휴지통');
    expect(mailboxLabel(mailbox('[Gmail]/All Mail', 'all'))).toBe('모든 메일');
    expect(mailboxLabel(mailbox('[Gmail]/Starred', 'flagged'))).toBe('별표편지함');
    expect(mailboxLabel(mailbox('Work', null, '업무'))).toBe('업무');
  });

  it('opens on 받은편지함 when present, else the first mailbox after ordering', () => {
    expect(defaultMailbox([mailbox('Trash', 'trash'), mailbox('INBOX', 'inbox')])?.path).toBe('INBOX');
    expect(defaultMailbox([mailbox('Archive', 'archive'), mailbox('Sent', 'sent')])?.path).toBe('Sent');
    expect(defaultMailbox([])).toBeNull();
  });

  it('shifts a known unseen count and leaves unknown counts and other mailboxes alone', () => {
    const shifted = shiftMailboxUnseen(
      [{ ...mailbox('INBOX', 'inbox'), unseen: 3 }, mailbox('All Mail', 'all', 'All Mail', null)], 'INBOX', -1);
    expect(shifted[0]?.unseen).toBe(2);
    expect(shifted[1]?.unseen).toBeNull();
    expect(shiftMailboxUnseen(shifted, 'Sent', -1)).toEqual(shifted);
    expect(shiftMailboxUnseen([{ ...mailbox('INBOX', 'inbox'), unseen: 0 }], 'INBOX', -1)[0]?.unseen).toBe(0);
  });
});

describe('message list paging state', () => {
  it('appends an older page without duplicates and carries the new cursor', () => {
    const state = { ...emptyMailList, messages: [summary(30), summary(31)], nextBefore: 30 };
    const next = appendMailPage(state, { messages: [summary(30), summary(29), summary(28)], nextBefore: 28 });
    expect(next.messages.map(item => item.uid)).toEqual([30, 31, 29, 28]);
    expect(next.nextBefore).toBe(28);
    expect(state.messages.map(item => item.uid)).toEqual([30, 31]);
    expect(state.nextBefore).toBe(30);
  });

  it('patches and removes by uid, leaving others and the cursor alone', () => {
    const state = { ...emptyMailList, messages: [summary(2), summary(1)], nextBefore: 1 };
    expect(patchMailMessage(state, 2, { seen: false, flagged: true }).messages[0]).toMatchObject({ uid: 2, seen: false, flagged: true });
    expect(patchMailMessage(state, 99, { seen: true }).messages).toHaveLength(2);
    expect(removeMailMessage(state, 2).messages.map(item => item.uid)).toEqual([1]);
    expect(removeMailMessage(state, 2).nextBefore).toBe(1);
  });
});

describe('addresses', () => {
  it('splits addresses on commas, semicolons and whitespace', () => {
    expect(parseMailAddresses('a@e.com, b@e.com;  c@e.com\n')).toEqual(['a@e.com', 'b@e.com', 'c@e.com']);
    expect(parseMailAddresses('   ')).toEqual([]);
  });

  it('shows the display name when there is one, else the address', () => {
    expect(mailAddressName({ name: '홍길동', address: 'h@e.com' })).toBe('홍길동');
    expect(mailAddressName({ name: '', address: 'h@e.com' })).toBe('h@e.com');
    expect(mailAddressName(null)).toBe('(보낸 사람 없음)');
    expect(mailAddressList([{ name: '가', address: 'a@e.com' }, { name: '', address: 'b@e.com' }, { name: '다', address: 'c@e.com' }, { name: '', address: 'd@e.com' }], 2))
      .toBe('가 <a@e.com>, b@e.com 외 2명');
    expect(mailAddressList([], 3)).toBe('');
  });
});

describe('compose → mail.send', () => {
  const base = { connectionId: 'c1', to: '', cc: '', bcc: '', subject: '', text: '' };

  it('builds a mail.send command with recipients, trimmed subject and a verbatim body', () => {
    expect(buildMailSend({ ...base, to: 'a@e.com, b@e.com', cc: ' c@e.com ', subject: ' 인사 ', text: '본문 줄\n' }))
      .toEqual({ ok: true, command: {
        type: 'mail.send', connectionId: 'c1', to: ['a@e.com', 'b@e.com'], cc: ['c@e.com'], subject: '인사', text: '본문 줄\n',
      } });
  });

  it('refuses to send without a recipient, subject or body', () => {
    expect(buildMailSend(base)).toEqual({ ok: false, error: '받는 사람을 한 명 이상 입력해 주세요.' });
    expect(buildMailSend({ ...base, to: 'a@e.com' })).toEqual({ ok: false, error: '제목을 입력해 주세요.' });
    expect(buildMailSend({ ...base, to: 'a@e.com', subject: '제목' })).toEqual({ ok: false, error: '본문을 입력해 주세요.' });
  });

  it('a reply pins replyTo on the answered message', () => {
    const built = buildMailSend({ ...base, to: 'h@e.com', subject: 'Re: 견적', text: '답변드립니다.', reply: { mailbox: 'INBOX', uid: 7 } });
    expect('command' in built && built.command.replyTo).toEqual({ mailbox: 'INBOX', uid: 7 });
    const plain = buildMailSend({ ...base, to: 'h@e.com', subject: '견적', text: '보냅니다.' });
    expect('command' in plain && plain.command.replyTo).toBeUndefined();
  });

  it('adds Re:/Fwd: exactly once', () => {
    expect(replySubject('인사')).toBe('Re: 인사');
    expect(replySubject('Re: 인사')).toBe('Re: 인사');
    expect(replySubject('re: 인사')).toBe('re: 인사');
    expect(replySubject('답장: 인사')).toBe('답장: 인사');
    expect(forwardSubject('인사')).toBe('Fwd: 인사');
    expect(forwardSubject('Fwd: 인사')).toBe('Fwd: 인사');
    expect(forwardSubject('전달: 인사')).toBe('전달: 인사');
  });

  it('a reply quote keeps one > per original line under the writer line', () => {
    const quoted = replyQuote(message({ from: { name: '홍', address: 'h@e.com' }, text: '첫 줄\n둘째 줄' }));
    const lines = quoted.split('\n');
    expect(lines[0]).toMatch(/홍 작성:$/);
    expect(lines.slice(1)).toEqual(['> 첫 줄', '> 둘째 줄']);
    const viaReplyTo = replyQuote(message({ replyTo: [{ name: '대신', address: 'r@e.com' }], from: { name: '홍', address: 'h@e.com' } }));
    expect(viaReplyTo.split('\n')[0]).toContain('대신');
  });

  it('a forward carries the original headers, then the body', () => {
    const quoted = forwardQuote(message({
      from: { name: '', address: 'h@e.com' },
      to: [{ name: '나', address: 'me@e.com' }],
      subject: '견적',
      text: '내용',
    }));
    expect(quoted.split('\n')).toEqual([
      '전달하는 메일:',
      '보낸 사람: h@e.com',
      '받는 사람: 나 <me@e.com>',
      '제목: 견적',
      expect.stringMatching(/^날짜: /),
      '',
      '내용',
    ]);
  });
});

describe('mailSizeLabel', () => {
  it('labels attachment sizes', () => {
    expect(mailSizeLabel(512)).toBe('512 B');
    expect(mailSizeLabel(1536)).toBe('1.5 KB');
    expect(mailSizeLabel(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(mailSizeLabel(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });
});
