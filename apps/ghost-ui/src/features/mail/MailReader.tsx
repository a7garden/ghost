import { useState } from 'react';
import { Archive, ChevronLeft, Download, FolderInput, Forward, Mail, MailOpen, Paperclip, Reply, Star, Trash2 } from 'lucide-react';
import { Button, InlineError } from '../../ui';
import type { MailboxInfo, MailMessage } from '../../host/client';
import { useHost } from '../../host/context';
import { Modal } from '../../components/Modal';
import { absoluteTime } from '../time';
import { MAIL_IFRAME_SANDBOX, mailboxLabel, mailAddressList, mailAddressName, mailHtmlDoc, mailSizeLabel, orderMailboxes } from './mail-data';

/** One reader action; the view owns the command sending and the list update. */
export type MailReaderAction =
  | { type: 'reply' }
  | { type: 'forward' }
  | { type: 'toggleSeen' }
  | { type: 'toggleFlag' }
  | { type: 'archive' }
  | { type: 'trash' }
  | { type: 'move'; target: string };

/**
 * One message in full: headers, actions, then the body — plain text by default, HTML only
 * inside an empty-sandbox iframe whose CSP blocks scripts, remote loads and form actions.
 */
export function MailReader({ connectionId, mailboxPath, mailboxes, message, busy, actionError, onAction, onBack }: {
  connectionId: string;
  mailboxPath: string;
  /** Every mailbox of the account, for 이동. */
  mailboxes: MailboxInfo[];
  message: MailMessage;
  /** The action in flight ('' when idle); every action button waits for it. */
  busy: string;
  actionError: string;
  onAction(action: MailReaderAction): void;
  /** Stacked layout only: back from the reader to the list. */
  onBack?(): void;
}) {
  const { client } = useHost();
  const [html, setHtml] = useState(false);
  const [moving, setMoving] = useState(false);
  const [downloading, setDownloading] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const from = message.from;
  const download = async (part: string, filename: string) => {
    if (downloading) return;
    setDownloading(part); setDownloadError('');
    try { await client.mailAttachment(connectionId, mailboxPath, message.uid, part, filename || 'attachment'); }
    catch (reason) { setDownloadError(reason instanceof Error ? reason.message : '첨부 파일을 저장하지 못했습니다.'); }
    finally { setDownloading(''); }
  };
  const waiting = busy !== '';
  return <article className="mail-reader" aria-label={`메일 읽기: ${message.subject || '제목 없음'}`}>
    <header className="mail-reader__head">
      {onBack && <Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft size={15}/>목록</Button>}
      <div className="mail-reader__actions">
        <Button variant="outline" size="sm" disabled={waiting} onClick={() => onAction({ type: 'reply' })}><Reply size={14}/>답장</Button>
        <Button variant="outline" size="sm" disabled={waiting} onClick={() => onAction({ type: 'forward' })}><Forward size={14}/>전달</Button>
        <span className="mail-reader__tools">
          <Button variant="ghost" size="icon" disabled={waiting} title={message.seen ? '안읽음으로 표시' : '읽음으로 표시'}
            aria-label={message.seen ? '안읽음으로 표시' : '읽음으로 표시'}
            onClick={() => onAction({ type: 'toggleSeen' })}>{message.seen ? <Mail size={15}/> : <MailOpen size={15}/>}</Button>
          <Button variant="ghost" size="icon" disabled={waiting} title={message.flagged ? '별표 해제' : '별표'}
            aria-label={message.flagged ? '별표 해제' : '별표'} aria-pressed={message.flagged}
            onClick={() => onAction({ type: 'toggleFlag' })}><Star size={15} fill={message.flagged ? 'currentColor' : 'none'}/></Button>
          <Button variant="ghost" size="icon" disabled={waiting} title="보관함으로 이동" aria-label="보관함으로 이동"
            onClick={() => onAction({ type: 'archive' })}><Archive size={15}/></Button>
          <Button variant="ghost" size="icon" disabled={waiting} title="휴지통으로 이동" aria-label="휴지통으로 이동"
            onClick={() => onAction({ type: 'trash' })}><Trash2 size={15}/></Button>
          <Button variant="ghost" size="icon" disabled={waiting} title="메일함 이동" aria-label="메일함 이동"
            onClick={() => setMoving(true)}><FolderInput size={15}/></Button>
        </span>
      </div>
    </header>
    {(actionError || downloadError) && <div className="mail-reader__error">
      {actionError && <InlineError>{actionError}</InlineError>}
      {downloadError && <InlineError>{downloadError}</InlineError>}
    </div>}
    <div className="mail-reader__scroll">
      <h2 className="mail-reader__subject">{message.subject || '(제목 없음)'}</h2>
      <dl className="mail-reader__headers">
        <div className="mail-reader__header"><dt>보낸 사람</dt>
          <dd>{from ? <span className="mail-reader__sender">{from.name || from.address}
            {from.name && <span className="mail-reader__raw">{` ${from.address}`}</span>}</span> : '(보낸 사람 없음)'}</dd></div>
        <div className="mail-reader__header"><dt>받는 사람</dt><dd>{mailAddressList(message.to, 5) || '(없음)'}</dd></div>
        {message.cc.length > 0 && <div className="mail-reader__header"><dt>참조</dt><dd>{mailAddressList(message.cc, 5)}</dd></div>}
        {message.replyTo.length > 0 && <div className="mail-reader__header"><dt>답장 주소</dt><dd>{mailAddressList(message.replyTo, 2)}</dd></div>}
        <div className="mail-reader__header"><dt>날짜</dt><dd>{absoluteTime(message.date)}</dd></div>
      </dl>
      {message.html && <div className="mail-reader__mode">
        <Button variant="ghost" size="sm" aria-pressed={html} onClick={() => setHtml(value => !value)}>{html ? '텍스트 보기' : 'HTML 보기'}</Button>
      </div>}
      {html && message.html
        ? <iframe className="mail-reader__frame" title="메일 본문" sandbox={MAIL_IFRAME_SANDBOX} srcDoc={mailHtmlDoc(message.html)}/>
        : <div className="mail-reader__text">{message.text || '(내용 없음)'}</div>}
      {message.attachments.length > 0 && <ul className="mail-attachments" aria-label="첨부 파일">
        {message.attachments.map(file => <li key={file.part}>
          <Button variant="outline" size="sm" disabled={downloading !== ''} aria-label={`${file.filename} 저장`}
            onClick={() => void download(file.part, file.filename)}>
            <Paperclip size={13} aria-hidden="true"/>
            <span className="mail-attachment__name">{file.filename || '파일'}</span>
            <span className="mail-attachment__size tabular">{mailSizeLabel(file.size)}</span>
            <Download size={13} aria-hidden="true"/>
          </Button>
        </li>)}
      </ul>}
    </div>
    {moving && <Modal title="메일함 이동" onClose={() => setMoving(false)}>
      <ul className="mail-folders mail-folders--pick">
        {orderMailboxes(mailboxes).filter(mailbox => mailbox.path !== mailboxPath).map(mailbox => <li key={mailbox.path}>
          <Button variant="outline" size="sm" className="mail-folder__pick" disabled={waiting}
            onClick={() => { setMoving(false); onAction({ type: 'move', target: mailbox.path }); }}>{mailboxLabel(mailbox)}</Button>
        </li>)}
      </ul>
    </Modal>}
  </article>;
}
