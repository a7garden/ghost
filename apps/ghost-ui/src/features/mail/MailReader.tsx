import { useId, useRef, useState, type ReactNode } from 'react';
import { Archive, Download, FolderInput, Forward, Mail, MailOpen, Paperclip, Reply, Star, Trash2 } from 'lucide-react';
import { Button, InlineError } from '../../ui';
import type { MailboxInfo, MailMessage } from '../../host/client';
import { useHost } from '../../host/context';
import { absoluteTime } from '../time';
import { MAIL_IFRAME_SANDBOX, mailboxLabel, mailAddressFull, mailAddressList, mailAddressName, mailHtmlDoc, mailSizeLabel, orderMailboxes } from './mail-data';

/** One reader action; the view owns the command sending and the list update. */
export type MailReaderAction =
  | { type: 'reply' | 'forward'; trigger: HTMLButtonElement }
  | { type: 'toggleSeen' }
  | { type: 'toggleFlag' }
  | { type: 'archive' }
  | { type: 'trash' }
  | { type: 'move'; target: string };

/**
 * One message in full: headers, actions, then the body — plain text by default, HTML only
 * inside an empty-sandbox iframe whose CSP blocks scripts, remote loads and form actions.
 */
export function MailReader({ connectionId, mailboxPath, ownerAddress, mailboxes, message, busy, actionError, onAction, draft }: {
  connectionId: string;
  mailboxPath: string;
  ownerAddress?: string;
  /** Every mailbox of the account, for 이동. */
  mailboxes: MailboxInfo[];
  message: MailMessage;
  /** The action in flight ('' when idle); every action button waits for it. */
  busy: string;
  actionError: string;
  onAction(action: MailReaderAction): void;
  /** A reply or forward extends the message at the end of the reading column. */
  draft?: ReactNode;
}) {
  const { client } = useHost();
  const [html, setHtml] = useState(false);
  const [moving, setMoving] = useState(false);
  const moveTrigger = useRef<HTMLButtonElement>(null);
  const moveChoicesId = useId();
  const [showAddresses, setShowAddresses] = useState(false);
  const addressesId = useId();
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const from = message.from;
  const to = message.to[0];
  const recipient = to ? to.address.toLowerCase() === ownerAddress?.toLowerCase() ? '나' : mailAddressFull(to) : '받는 사람 없음';
  const hasAddresses = message.to.length > 1 || message.cc.length > 0 || message.replyTo.length > 0;
  const download = async (part: string, filename: string) => {
    if (downloading) return;
    setDownloading(part); setDownloadError('');
    try { await client.mailAttachment(connectionId, mailboxPath, message.uid, part, filename || 'attachment'); }
    catch (reason) { setDownloadError(reason instanceof Error ? reason.message : '첨부 파일을 저장하지 못했습니다.'); }
    finally { setDownloading(''); }
  };
  const waiting = busy !== '' || Boolean(draft);
  const destinations = moving && !draft ? orderMailboxes(mailboxes).filter(mailbox => mailbox.path !== mailboxPath) : null;
  const closeMove = () => {
    setMoving(false);
    moveTrigger.current?.focus();
  };
  return <article className="mail-reader" aria-label={`메일 읽기: ${message.subject || '제목 없음'}`}>
    <div className="mail-reader__scroll">
      <div className="mail-reader__measure">
        <header className="mail-reader__head" onKeyDown={event => {
          if (destinations && event.key === 'Escape' && busy !== 'move') {
            event.preventDefault();
            closeMove();
          }
        }}>
          <h2 className="mail-reader__subject">{message.subject || '(제목 없음)'}</h2>
          <p className="mail-reader__meta">
            <span>
              <span className={from?.name ? 'mail-reader__sender' : 'mail-reader__raw'}>{mailAddressName(from)}</span>
              {from?.name && from.name !== from.address && <>{' '}<span className="mail-reader__raw">{from.address}</span></>}
              {' '}<span aria-hidden="true">→</span><span className="sr-only">, 받는 사람</span>
              {' '}{recipient}{message.to.length > 1 && ` 외 ${message.to.length - 1}명`}
            </span>
            <span>· <time dateTime={new Date(message.date).toISOString()}>{absoluteTime(message.date)}</time></span>
            {hasAddresses && <Button type="button" variant="ghost" size="sm" aria-expanded={showAddresses}
              aria-controls={addressesId} onClick={() => setShowAddresses(value => !value)}>
              <span aria-hidden="true">{showAddresses ? '−' : '+'}</span> 주소 보기
            </Button>}
          </p>
          {hasAddresses && <dl id={addressesId} className="mail-reader__addresses" hidden={!showAddresses}>
            {message.to.length > 1 && <div><dt>받는 사람</dt><dd>{mailAddressList(message.to, message.to.length)}</dd></div>}
            {message.cc.length > 0 && <div><dt>참조</dt><dd>{mailAddressList(message.cc, message.cc.length)}</dd></div>}
            {message.replyTo.length > 0 && <div><dt>답장 주소</dt><dd>{mailAddressList(message.replyTo, message.replyTo.length)}</dd></div>}
          </dl>}
          <div className="mail-reader__actions">
            <span className="mail-reader__reply">
              <Button type="button" variant="outline" size="sm" disabled={waiting} onClick={event => {
                setMoving(false); onAction({ type: 'reply', trigger: event.currentTarget });
              }}><Reply size={14} aria-hidden="true"/>답장</Button>
              <Button type="button" variant="outline" size="sm" disabled={waiting} onClick={event => {
                setMoving(false); onAction({ type: 'forward', trigger: event.currentTarget });
              }}><Forward size={14} aria-hidden="true"/>전달</Button>
            </span>
            <span className="mail-reader__tools" role="group" aria-label="메일 상태 및 이동">
              <Button type="button" variant="ghost" size="icon" disabled={waiting} title={message.seen ? '안읽음으로 표시' : '읽음으로 표시'}
                aria-label={message.seen ? '안읽음으로 표시' : '읽음으로 표시'}
                onClick={() => onAction({ type: 'toggleSeen' })}>{message.seen ? <Mail size={15}/> : <MailOpen size={15}/>}</Button>
              <Button type="button" variant="ghost" size="icon" disabled={waiting} title={message.flagged ? '별표 해제' : '별표'}
                aria-label={message.flagged ? '별표 해제' : '별표'} aria-pressed={message.flagged}
                onClick={() => onAction({ type: 'toggleFlag' })}><Star size={15} fill={message.flagged ? 'currentColor' : 'none'}/></Button>
              <Button type="button" variant="ghost" size="icon" disabled={waiting} title="보관함으로 이동" aria-label="보관함으로 이동"
                onClick={() => onAction({ type: 'archive' })}><Archive size={15}/></Button>
              <Button type="button" variant="ghost" size="icon" disabled={waiting} title="휴지통으로 이동" aria-label="휴지통으로 이동"
                onClick={() => onAction({ type: 'trash' })}><Trash2 size={15}/></Button>
              <Button type="button" ref={moveTrigger} variant="ghost" size="icon" disabled={waiting} title="메일함 이동" aria-label="메일함 이동"
                aria-expanded={destinations !== null} aria-controls={destinations ? moveChoicesId : undefined}
                onClick={() => setMoving(current => !current)}><FolderInput size={15}/></Button>
            </span>
          </div>
          {destinations && <div id={moveChoicesId} className="mail-reader__destinations" role="group" aria-label="이동할 메일함">
            {destinations.length > 0 ? <ul className="mail-reader__destination-list">
              {destinations.map(mailbox => <li key={mailbox.path}>
                <Button variant="outline" size="sm" type="button" disabled={waiting}
                  className="h-auto min-h-7 max-w-full whitespace-normal text-start [overflow-wrap:anywhere] max-[55.999rem]:min-h-11"
                  onClick={() => onAction({ type: 'move', target: mailbox.path })}>{mailboxLabel(mailbox)}</Button>
              </li>)}
            </ul> : <span>이동할 메일함이 없습니다.</span>}
            {busy === 'move' && <span role="status">이동 중…</span>}
            <Button variant="ghost" size="sm" type="button" disabled={busy === 'move'} onClick={closeMove}>취소</Button>
          </div>}
          {actionError && <InlineError>{actionError}</InlineError>}
        </header>
        {message.attachments.length > 0 && <ul className="mail-attachments" aria-label="첨부 파일">
          {message.attachments.map(file => <li key={file.part}>
            <Button type="button" variant="outline" size="sm" disabled={downloading !== ''} aria-label={`${file.filename || '첨부 파일'} 저장`}
              title={file.filename || '첨부 파일 저장'} onClick={() => void download(file.part, file.filename)}>
              <Paperclip size={13} aria-hidden="true"/>
              <span className="mail-attachment__name">{file.filename || '파일'}</span>
              <span className="mail-attachment__size tabular">{mailSizeLabel(file.size)}</span>
              <Download size={13} aria-hidden="true"/>
            </Button>
          </li>)}
        </ul>}
        {downloadError && <InlineError>{downloadError}</InlineError>}
        {message.html && <Button type="button" className="mail-reader__mode" variant="ghost" size="sm" aria-pressed={html}
          onClick={() => setHtml(value => !value)}>{html ? '텍스트 보기' : 'HTML 보기'}</Button>}
        {html && message.html
          ? <iframe className="mail-reader__frame" title="메일 본문" sandbox={MAIL_IFRAME_SANDBOX} srcDoc={mailHtmlDoc(message.html)}/>
          : <div className="mail-reader__text">{message.text || '(내용 없음)'}</div>}
        {draft}
      </div>
    </div>
  </article>;
}
