import { useRef, useState } from 'react';
import { Button, FormField, InlineError, Input, Textarea } from '../../ui';
import { HostError, type MailMessage, type MailSendCommand } from '../../host/client';
import { useHost } from '../../host/context';
import { Modal } from '../../components/Modal';
import { buildMailSend, forwardQuote, forwardSubject, replyQuote, replySubject, type MailComposeDraft } from './mail-data';

/** What opens the compose sheet: a fresh mail, a reply to one message, or a forward of one. */
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

/** The compose sheet: 받는 사람 · 참조 · 숨은참조 · 제목 · 본문. A failed send keeps every field. */
export function MailCompose({ connectionId, canSend, seed, onSent, onClose }: {
  connectionId: string;
  /** False when the account has no SMTP; sending stays off with one clear line. */
  canSend: boolean;
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
  const set = (patch: Partial<MailComposeDraft>) => setDraft(current => ({ ...current, ...patch }));
  const send = async () => {
    if (inFlight.current) return;
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
  const field = (key: 'to' | 'cc' | 'bcc' | 'subject', label: string, options: { required?: boolean; inputMode?: 'email'; placeholder?: string } = {}) =>
    <FormField label={label} required={options.required}>
      {control => <Input {...control} value={draft[key]} disabled={sending || uncertain} autoComplete="off" inputMode={options.inputMode}
        placeholder={options.placeholder} onChange={event => set({ [key]: event.target.value })}/>}
    </FormField>;
  return <Modal title={composeTitle[seed.mode]} onClose={() => { if (!sending) onClose(); }}>
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void send(); }}>
      {!canSend && <InlineError>이 계정에는 보내기 설정(SMTP)이 없습니다. 설정 → 연결 계정에서 SMTP 서버를 저장해 주세요.</InlineError>}
      {field('to', '받는 사람', { required: true, inputMode: 'email', placeholder: 'a@example.com, b@example.com' })}
      <div className="grid gap-4 sm:grid-cols-2">
        {field('cc', '참조', { inputMode: 'email' })}
        {field('bcc', '숨은참조', { inputMode: 'email' })}
      </div>
      {field('subject', '제목', { required: true })}
      <FormField label="본문" required>
        {control => <Textarea {...control} value={draft.text} rows={10} disabled={sending || uncertain}
          onChange={event => set({ text: event.target.value })}/>}
      </FormField>
      {error && <InlineError>{error}</InlineError>}
      {uncertain && <p className="m-0 text-caption text-ink-2">중복 전송을 막기 위해 내용을 잠갔습니다. 전송 상태 확인은 같은 요청을 다시 확인합니다. 보낸편지함도 확인해 주세요. 닫은 뒤 새로 보내면 중복될 수 있습니다.</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={sending} onClick={onClose}>{uncertain ? '닫기' : '취소'}</Button>
        <Button type="submit" disabled={sending || !canSend}>{sending ? (uncertain ? '확인 중…' : '보내는 중…') : uncertain ? '전송 상태 확인' : '보내기'}</Button>
      </div>
    </form>
  </Modal>;
}
