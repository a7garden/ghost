import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type FormEvent, type RefObject } from 'react';
import { ArrowUp, Paperclip } from 'lucide-react';
import type { HerdrUpload } from '@ghost/contract';
import { Button, InlineError, Textarea } from '../ui';
import { submitCodingOnShortcut } from './herdrDisplay';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';

export function useHerdrDraft(key: string | undefined, upload?: (file: File) => Promise<HerdrUpload>) {
  const [draft, setDraft] = useState(() => key ? readCodingValue(key) ?? '' : '');
  useEffect(() => { if (key) writeCodingValue(key, draft); }, [key, draft]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const active = useRef(false);

  async function attach(files: FileList) {
    if (!upload || !files.length || active.current) return;
    active.current = true;
    setUploading(true);
    setUploadError('');
    const errors: string[] = [];
    try {
      for (const file of Array.from(files)) {
        try {
          const saved = await upload(file);
          setDraft(current => `${current}${current && !/\s$/.test(current) ? ' ' : ''}@${saved.path} `);
        } catch (reason) {
          errors.push(`${file.name}: ${reason instanceof Error ? reason.message : '첨부하지 못했습니다.'}`);
        }
      }
      setUploadError(errors.join('\n'));
    } finally {
      active.current = false;
      setUploading(false);
    }
  }
  function paste(event: ClipboardEvent, enabled: boolean) {
    if (!event.clipboardData.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    if (enabled) void attach(event.clipboardData.files);
  }
  function drag(event: DragEvent) {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  }
  function drop(event: DragEvent, enabled: boolean) {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    if (enabled) void attach(event.dataTransfer.files);
  }
  return { draft, setDraft, attach, paste, drag, drop, uploading, uploadError };
}

export function HerdrComposer({ shell, blocked, working, pending, compact, draft, field, onSubmit, onModifiedKey, canUpload }: {
  shell: boolean; blocked: boolean; working: boolean; pending: boolean; compact: boolean;
  draft: ReturnType<typeof useHerdrDraft>; field: RefObject<HTMLTextAreaElement | null>;
  onSubmit(text: string): Promise<boolean>; onModifiedKey(text: string): boolean; canUpload: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const disabled = pending || blocked || working;
  const label = shell ? '셸 명령' : '후속 지시';
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sent = draft.draft;
    if (!disabled && !draft.uploading && sent.trim() && await onSubmit(shell ? sent : sent.trim())) {
      draft.setDraft(current => current === sent ? '' : current);
    }
  }
  function change(event: ChangeEvent<HTMLTextAreaElement>) {
    // Mobile soft keyboards may only produce an input event (without a printable keydown).
    const native = event.nativeEvent;
    if (native instanceof InputEvent && !native.isComposing && native.inputType === 'insertText' && native.data && onModifiedKey(native.data)) return;
    const text = event.currentTarget.value;
    draft.setDraft(shell ? text.replace(/[\r\n]+/g, ' ') : text);
  }
  return <>
    {draft.uploading && <p className="coding-hint" role="status">첨부 중…</p>}
    {draft.uploadError && <InlineError className="whitespace-pre-line">{draft.uploadError}</InlineError>}
    <form className="coding-compose" onSubmit={event => void send(event)}>
      {canUpload && <>
        <input ref={picker} hidden type="file" multiple onChange={event => {
          if (event.currentTarget.files) void draft.attach(event.currentTarget.files);
          event.currentTarget.value = '';
        }}/>
        <Button type="button" size="icon" variant="ghost" aria-label="파일 첨부" disabled={disabled || draft.uploading} onClick={() => picker.current?.click()}>
          <Paperclip aria-hidden="true"/>
        </Button>
      </>}
      <Textarea ref={field} aria-label={label} placeholder={label}
        className="min-h-11 bg-transparent shadow-none focus:shadow-none"
        rows={1} maxLength={24_000} value={draft.draft} disabled={disabled} onChange={change} autoCorrect="off" spellCheck={false}
        aria-keyshortcuts={compact ? undefined : 'Enter'} onKeyDown={event => {
          if (!event.nativeEvent.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && onModifiedKey(event.key)) {
            event.preventDefault();
            return;
          }
          if (!compact && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          } else submitCodingOnShortcut(event);
        }}/>
      <Button type="submit" size="icon" aria-label="보내기" disabled={disabled || draft.uploading || !draft.draft.trim()}><ArrowUp aria-hidden="true"/></Button>
    </form>
  </>;
}
