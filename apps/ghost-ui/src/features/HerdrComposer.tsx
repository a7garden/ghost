import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ListEnd, Navigation, Paperclip, Square } from 'lucide-react';
import type { HerdrDelivery, HerdrUpload } from '@ghost/contract';
import { Composer, InlineError } from '../ui';
import { NextSuggestions } from '../components/composer/NextSuggestions';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';

export interface HerdrDraft {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  attach(files: ArrayLike<File>): Promise<void>;
  uploading: boolean;
  uploadError: string;
}

export function useHerdrDraft(key: string | undefined, upload?: (file: File) => Promise<HerdrUpload>): HerdrDraft {
  const [draft, setDraft] = useState(() => key ? readCodingValue(key) ?? '' : '');
  useEffect(() => { if (key) writeCodingValue(key, draft); }, [key, draft]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const active = useRef(false);

  async function attach(files: ArrayLike<File>) {
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
  return { draft, setDraft, attach, uploading, uploadError };
}

const deliveryLabel = { steer: '스티어링', queue: '대기열' } as const satisfies Record<HerdrDelivery, string>;

/** Only omp's own keyboard separates steering (Enter) from queueing (Alt+Enter); the Host sends no other agent a different key. */
const QUEUE_KEY_AGENT = 'omp';

/**
 * The follow-up field of an agent pane. It stays writable while the agent works: Enter delivers the way the owner chose
 * in 설정 (스티어링 or 대기열), ⌥Enter the other way. A next message the owner is likely to send waits above the text
 * while the field is empty; Tab (or a tap) puts it in the field, nothing is sent.
 */
export function HerdrComposer({ agent, blocked, working, pending, delivery, draft, field, suggestions, onSubmit, onStop, canUpload }: {
  agent: string | null; blocked: boolean; working: boolean; pending: boolean; delivery: HerdrDelivery;
  draft: HerdrDraft; field: RefObject<HTMLTextAreaElement | null>; suggestions: readonly string[];
  onSubmit(text: string, delivery?: HerdrDelivery): Promise<boolean>; onStop?(): void; canUpload: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const queueable = working && agent === QUEUE_KEY_AGENT;
  const other: HerdrDelivery = delivery === 'steer' ? 'queue' : 'steer';
  const offered = !draft.draft && !working && !blocked ? suggestions : [];
  async function send(sent: string, mode: HerdrDelivery) {
    if (pending || blocked || draft.uploading || !sent.trim()) return;
    const accepted = await onSubmit(sent.trim(), working ? mode : undefined);
    if (accepted) draft.setDraft(current => current === sent ? '' : current);
    requestAnimationFrame(() => { if (!matchMedia('(pointer: coarse)').matches) field.current?.focus({ preventScroll: true }); });
  }
  const pick = (text: string) => {
    draft.setDraft(text);
    requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  };
  const placeholder = !working ? '후속 지시' : !queueable ? '작업 중 — 이어서 지시' : delivery === 'steer' ? '작업 중 — 지금 바로 전달' : '작업 중 — 끝난 뒤 전달';
  return <Composer className="coding-composer" label="후속 지시" placeholder={placeholder} submitLabel={queueable ? `${deliveryLabel[delivery]}로 보내기` : '보내기'}
    inputRef={field} value={draft.draft} onValueChange={draft.setDraft} onSubmit={() => void send(draft.draft, delivery)}
    disabled={blocked} pending={pending || draft.uploading} running={working}
    onFiles={canUpload ? files => void draft.attach(files) : undefined}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && offered.length) {
        event.preventDefault();
        pick(offered[0]!);
      } else if (event.key === 'Enter' && event.altKey && queueable) {
        event.preventDefault();
        void send(draft.draft, other);
      }
    }}
    header={offered.length > 0 ? <NextSuggestions items={offered} onPick={pick}/> : undefined}
    tray={draft.uploading || draft.uploadError ? <>
      {draft.uploading && <p className="coding-hint" role="status">첨부 중…</p>}
      {draft.uploadError && <InlineError className="whitespace-pre-line">{draft.uploadError}</InlineError>}
    </> : undefined}
    leading={canUpload ? <>
      <input ref={picker} hidden type="file" multiple onChange={event => {
        if (event.currentTarget.files) void draft.attach(Array.from(event.currentTarget.files));
        event.currentTarget.value = '';
      }}/>
      <button type="button" className="composer-plus__trigger" aria-label="파일 첨부" title="파일 첨부" disabled={blocked || pending || draft.uploading}
        onClick={() => picker.current?.click()}><Paperclip aria-hidden="true"/></button>
    </> : undefined}
    footer={queueable ? <span className="coding-delivery" title={`Enter ${deliveryLabel[delivery]} · ⌥Enter ${deliveryLabel[other]}`}>
      {delivery === 'steer' ? <Navigation aria-hidden="true"/> : <ListEnd aria-hidden="true"/>}{deliveryLabel[delivery]}
    </span> : undefined}
    trailing={onStop && (working || blocked) ? <button type="button" className="chat-stop" aria-label="작업 중단" title="작업 중단 (Esc)" onClick={onStop}>
      <Square aria-hidden="true"/></button> : undefined}/>;
}
