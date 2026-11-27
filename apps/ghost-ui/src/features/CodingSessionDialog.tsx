import { useId, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { CodingDialog, CodingDialogAnswer } from '@ghost/contract';
import { Button, InlineError, Input } from '../ui';
import { codingDialogAnswer, codingError } from './CodingSessionModel';
import { CodingSessionPreview } from './CodingSessionPreview';

export function CodingSessionDialog({ sessionId, dialog, disabled, onAnswer }: {
  sessionId: string; dialog: CodingDialog; disabled: boolean; onAnswer(answer: CodingDialogAnswer): Promise<unknown>;
}) {
  const label = useId();
  const name = useId();
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const answering = useRef(false);
  const choices = dialog.kind === 'choices' || dialog.kind === 'select';
  const allowText = dialog.kind === 'input' || (dialog.kind === 'choices' && dialog.allowText);
  const gallery = dialog.kind === 'choices' && dialog.options?.some(option => option.image || option.html);
  const tool = dialog.kind === 'approval' ? dialog.tool : undefined;
  const answer = choices && selected ? codingDialogAnswer(dialog, { type: 'option', id: selected })
    : allowText ? codingDialogAnswer(dialog, { type: 'text', value: text }) : null;

  async function send(result: CodingDialogAnswer | null) {
    if (!result || answering.current || disabled) return;
    answering.current = true;
    setPending(true);
    setError('');
    try {
      await onAnswer(result);
      // Keep this answer locked while waiting for the session event to remove this dialog.
    } catch (reason) {
      answering.current = false;
      setPending(false);
      setError(codingError(reason, '응답을 보내지 못했습니다.'));
    }
  }

  return <section className="embedded-dialog" aria-labelledby={label} aria-busy={pending || undefined}>
    <form onSubmit={event => { event.preventDefault(); void send(answer); }}>
      <div className="embedded-dialog__body" tabIndex={0}>
        <header className="embedded-dialog__head">
          <p><CircleAlert size={15} aria-hidden="true"/>{dialog.kind === 'approval' ? '승인 대기' : '응답 필요'}</p>
          <h3 id={label}>{dialog.title}</h3>
        </header>
        {dialog.message && <p className="embedded-dialog__evidence">{dialog.message}</p>}
        {tool && <div className="embedded-dialog__command">
          <strong>{tool.name}</strong>
          {!dialog.message?.includes(tool.summary) && <pre><code>{tool.summary}</code></pre>}
        </div>}
        {choices && <fieldset className="embedded-choices" data-gallery={gallery || undefined}>
          <legend className="sr-only">선택지</legend>
          {dialog.options?.map(option => <div className="embedded-choice" key={option.id} data-selected={selected === option.id || undefined}>
            <label>
              <input type="radio" name={name} checked={selected === option.id} disabled={pending || disabled} onChange={() => { setSelected(option.id); setText(''); }}/>
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>
            {(option.image || option.html) && <div className="embedded-choice__evidence">
              {option.image && <CodingSessionPreview id={sessionId} kind="image" path={option.image.path} label={option.image.label ?? `${option.label} 이미지`} thumbnail/>}
              {option.html && <CodingSessionPreview id={sessionId} kind="html" path={option.html} label={option.label} thumbnail/>}
            </div>}
          </div>)}
        </fieldset>}
        {allowText && <div className="embedded-dialog__text">
          <label htmlFor={`${name}-answer`}>{dialog.kind === 'input' ? '응답' : '직접 답하기'}</label>
          <Input id={`${name}-answer`} value={text} placeholder={dialog.placeholder} maxLength={8000} disabled={pending || disabled}
            onChange={event => { setText(event.target.value); setSelected(''); }}/>
        </div>}
        {error && <InlineError>{error}</InlineError>}
      </div>
      <div className="embedded-dialog__actions">
        {dialog.kind === 'confirm' || dialog.kind === 'approval' ? <>
          <Button type="button" variant="outline" disabled={pending || disabled} onClick={() => void send(codingDialogAnswer(dialog, { type: 'confirm', yes: false }))}>{dialog.kind === 'approval' ? '거부' : '아니요'}</Button>
          <Button type="button" disabled={pending || disabled} onClick={() => void send(codingDialogAnswer(dialog, { type: 'confirm', yes: true }))}>{dialog.kind === 'approval' ? '한 번 허용' : '예'}</Button>
        </> : <>
          <Button type="button" variant="outline" disabled={pending || disabled} onClick={() => void send(codingDialogAnswer(dialog, { type: 'cancel' }))}>{dialog.kind === 'choices' ? '해당 없음' : '취소'}</Button>
          <Button type="submit" disabled={!answer || pending || disabled}>{selected ? '선택 보내기' : '응답 보내기'}</Button>
        </>}
      </div>
    </form>
  </section>;
}
