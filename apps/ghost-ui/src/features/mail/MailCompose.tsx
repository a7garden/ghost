import { useLayoutEffect, useRef, useState } from 'react';
import { Button, InlineError } from '../../ui';
import { HostError, type MailAccounts, type MailMessage, type MailSendCommand } from '../../host/client';
import { useHost } from '../../host/context';
import { buildMailSend, forwardQuote, forwardSubject, replyQuote, replySubject, type MailComposeDraft } from './mail-data';

/** A fresh letter, or a continuation of the message in the reader. */
export type ComposeSeed = { mode: 'new' } | { mode: 'reply' | 'forward'; mailbox: string; message: MailMessage };

const draftFromSeed = (connectionId: string, seed: ComposeSeed): MailComposeDraft => {
  if (seed.mode === 'new') return { connectionId, to: '', cc: '', bcc: '', subject: '', text: '' };
  const { message } = seed;
  if (seed.mode === 'reply') return {
    connectionId,
    to: (message.replyTo[0] ?? message.from)?.address ?? '',
    cc: '', bcc: '',
    subject: replySubject(message.subject),
    text: `\n\n${replyQuote(message)}`,
    reply: { mailbox: seed.mailbox, uid: message.uid },
  };
  return { connectionId, to: '', cc: '', bcc: '', subject: forwardSubject(message.subject), text: forwardQuote(message) };
};

const composeTitle: Record<ComposeSeed['mode'], string> = { new: '메일 쓰기', reply: '답장 쓰기', forward: '전달 쓰기' };

/** A failed send keeps the letter intact. Replies stay on the receiving account. */
export function MailCompose({ connectionId, accounts, seed, onSent, onClose }: {
  /** The account the letter opens on. */
  connectionId: string;
  accounts: MailAccounts['accounts'];
  seed: ComposeSeed;
  onSent(): void;
  onClose(): void;
}) {
  const { client } = useHost();
  const [draft, setDraft] = useState<MailComposeDraft>(() => draftFromSeed(connectionId, seed));
  const [error, setError] = useState(''), [sending, setSending] = useState(false);
  const attempt = useRef<{ command: MailSendCommand; requestId: string } | null>(null);
  const inFlight = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const [addressing, setAddressing] = useState(false);
  const recipient = useRef<HTMLInputElement>(null);
  const cc = useRef<HTMLInputElement>(null);
  const bcc = useRef<HTMLInputElement>(null);
  const subject = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const sender = accounts.find(account => account.connectionId === draft.connectionId);
  const locked = sending || uncertain;
  const title = composeTitle[seed.mode];
  useLayoutEffect(() => {
    if (seed.mode === 'reply') {
      body.current?.setSelectionRange(0, 0);
      body.current?.focus();
    } else recipient.current?.focus();
  }, [seed.mode]);
  const set = (patch: Partial<MailComposeDraft>) => setDraft(current => ({ ...current, ...patch }));
  const send = async () => {
    if (inFlight.current || !sender?.canSend) return;
    if (!attempt.current) {
      const built = buildMailSend(draft);
      if (!built.ok) { setError(built.error); return; }
      attempt.current = { command: built.command, requestId: crypto.randomUUID() };
    }
    inFlight.current = true;
    setSending(true); setError('');
    try {
      await client.mailSend(attempt.current.command, attempt.current.requestId);
      onSent();
      onClose();
    } catch (reason) {
      if (!uncertain && reason instanceof HostError && reason.code === 'invalid') {
        // The host confirms validation failed before sending; the draft can be corrected.
        attempt.current = null;
        setError(`보내지 않았습니다. ${reason.message}`);
      } else {
        // A lost response is not a failed delivery. Keep both payload and receipt identity.
        setUncertain(true);
        setError(`전송 결과를 확인하지 못했습니다. ${reason instanceof Error ? reason.message : ''}`);
      }
      setSending(false);
    } finally {
      inFlight.current = false;
    }
  };
  const address = (key: 'to' | 'cc' | 'bcc', label: string, required = false) =>
    <label className="mail-letter__address">
      <span>{label}</span>
      <input ref={key === 'to' ? recipient : key === 'cc' ? cc : bcc} value={draft[key]} disabled={locked}
        required={required} inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false}
        onChange={event => set({ [key]: event.target.value })}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          const next = key === 'to' ? cc.current ?? subject.current : key === 'cc' ? bcc.current : subject.current;
          next?.focus();
        }}/>
    </label>;
  return <form className="mail-letter" data-mode={seed.mode} aria-label={title} noValidate
    onSubmit={event => { event.preventDefault(); void send(); }}
    onKeyDown={event => {
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' && !sending) { event.preventDefault(); onClose(); }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
    }}>
    <header className="mail-letter__head">
      <div className="mail-letter__envelope">
        <div className="mail-letter__sender">
          {accounts.length > 1 && seed.mode !== 'reply'
            ? <select className="mail-letter__account" aria-label="보내는 계정" value={draft.connectionId} disabled={locked}
              onChange={event => set({ connectionId: event.target.value })}>
              {accounts.map(account => <option key={account.connectionId} value={account.connectionId}>{account.name || account.address}</option>)}
            </select>
            : <span className="mail-letter__from">{sender?.address || sender?.name}</span>}
        </div>
        <Button type="button" variant="ghost" size="sm" aria-expanded={addressing} onClick={() => setAddressing(current => !current)}>
          <span aria-hidden="true">{addressing ? '−' : '+'}</span> {!addressing && (draft.cc.trim() || draft.bcc.trim()) ? '참조 있음' : '참조'}
        </Button>
      </div>
      {address('to', '받는 사람', true)}
      {addressing && <>
        {address('cc', '참조')}
        {address('bcc', '숨은참조')}
      </>}
      <input ref={subject} className="mail-letter__subject" aria-label="제목" required placeholder="제목"
        value={draft.subject} disabled={locked} onChange={event => set({ subject: event.target.value })}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
          event.preventDefault(); body.current?.focus();
        }}/>
    </header>
    <textarea ref={body} className="mail-letter__body" aria-label="본문" required
      placeholder="편지 쓰기" rows={seed.mode === 'new' ? 8 : 5} value={draft.text} disabled={locked}
      onChange={event => set({ text: event.target.value })}/>
    {!sender?.canSend && <InlineError>이 계정에는 보내기 설정(SMTP)이 없습니다. 설정 → 연결 계정에서 SMTP 서버를 저장해 주세요.</InlineError>}
    {error && <InlineError>{error}</InlineError>}
    {uncertain && <p className="mail-letter__notice">중복 전송을 막기 위해 내용을 잠갔습니다. 전송 상태 확인은 같은 요청을 다시 확인합니다. 보낸편지함도 확인해 주세요. 닫은 뒤 새로 보내면 중복될 수 있습니다.</p>}
    <footer className="mail-letter__foot">
      <Button variant="ghost" type="button" disabled={sending} onClick={onClose}>{uncertain ? '닫기' : '취소'}</Button>
      <Button type="submit" disabled={sending || !sender?.canSend}>{sending ? (uncertain ? '확인 중…' : '보내는 중…') : uncertain ? '전송 상태 확인' : '보내기'}</Button>
    </footer>
  </form>;
}
