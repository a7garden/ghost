import { useEffect, useRef, useState } from 'react';
import { Paperclip, Square } from 'lucide-react';
import type { CodingPrompt, CodingSession } from '@ghost/contract';
import { AttachmentTray, type PendingAttachment } from '../components/composer/attachments';
import { Button, Composer, InlineError } from '../ui';
import { codingBusy, codingError } from './CodingSessionModel';

type PromptImage = NonNullable<CodingPrompt['images']>[number];
type LocalImage = PendingAttachment & { file: File };
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 9_000_000; // 12,000,000 base64 characters in the contract.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

async function encodeImage({ file, name, type }: LocalImage): Promise<PromptImage> {
  // FileReader's data URL keeps this compatible with the ES2022 iPhone webview.
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.onerror = () => reject(new Error(`${name} 파일을 읽지 못했습니다.`));
    reader.readAsDataURL(file);
  });
  return { data, mimeType: type, name: name.slice(0, 200) };
}

export function CodingSessionComposer({ state, disabled, stopping, onPrompt, onAbort }: {
  state: CodingSession['state']; disabled: boolean; stopping: boolean;
  onPrompt(prompt: CodingPrompt): Promise<{ disposition: 'started' | 'queued' }>; onAbort(): void;
}) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<LocalImage[]>([]);
  const [error, setError] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [queued, setQueued] = useState(false);
  const [pending, setPending] = useState(false);
  const attaching = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const attached = useRef<LocalImage[]>([]);
  const busy = codingBusy(state);
  const mode = state === 'working' ? 'steer' : state === 'waiting' ? 'follow_up' : 'prompt';
  const label = mode === 'steer' ? '방향 수정' : mode === 'follow_up' ? '후속 지시 예약' : '지시 보내기';
  const readyToSend = Boolean(draft.trim() || images.length);
  const tooLong = draft.trim().length > 24_000;

  useEffect(() => () => {
    for (const image of attached.current) if (image.preview) URL.revokeObjectURL(image.preview);
  }, []);

  function add(files: File[]) {
    if (sending.current || disabled) return;
    const next = [...attached.current];
    let warning = '';
    for (const file of files) {
      if (next.length === MAX_IMAGES) { warning = '이미지는 8장까지 첨부할 수 있습니다.'; break; }
      if (!IMAGE_TYPES.includes(file.type)) { warning = 'PNG, JPEG, GIF, WebP 이미지만 첨부할 수 있습니다.'; continue; }
      if (!file.size || file.size > MAX_IMAGE_BYTES) { warning = '이미지는 비어 있지 않은 9MB 이하 파일이어야 합니다.'; continue; }
      next.push({ id: crypto.randomUUID(), name: file.name, type: file.type, size: file.size,
        preview: URL.createObjectURL(file), status: 'ready', file });
    }
    attached.current = next;
    setImages(next);
    setAttachmentError(warning);
  }

  async function send(text: string, delivery: CodingPrompt['mode']) {
    if (disabled || sending.current || tooLong || (!text && !attached.current.length)) return;
    sending.current = true;
    setPending(true);
    setQueued(false);
    setError('');
    try {
      const files = await Promise.all(attached.current.map(encodeImage));
      const { disposition } = await onPrompt({ text, mode: delivery, ...(files.length ? { images: files } : {}) });
      for (const image of attached.current) if (image.preview) URL.revokeObjectURL(image.preview);
      attached.current = [];
      setImages([]);
      setDraft('');
      setAttachmentError('');
      setQueued(disposition === 'queued' && delivery === 'follow_up');
    } catch (reason) {
      setError(codingError(reason, '지시를 보내지 못했습니다.'));
    } finally {
      setPending(false);
      sending.current = false;
    }
  }

  return <>
    {error && <InlineError>{error}</InlineError>}
    {attachmentError && <InlineError>{attachmentError}</InlineError>}
    {tooLong && <InlineError>지시는 24,000자까지 보낼 수 있습니다.</InlineError>}
    {queued && busy && <p className="embedded-prompt-status" role="status">후속 지시를 예약했습니다.</p>}
    <Composer label="코딩 지시" placeholder="코딩 지시를 입력하세요" value={draft} onValueChange={setDraft}
      submitLabel={label} onSubmit={text => void send(text, mode)} disabled={disabled} pending={pending} running={state === 'working'}
      canSubmitEmpty={images.length > 0} onFiles={add}
      onKeyDown={event => {
        if (state !== 'working' || event.key !== 'Enter' || !event.altKey || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || matchMedia('(pointer: coarse)').matches) return;
        event.preventDefault();
        void send(draft.trim(), 'follow_up');
      }}
      tray={<AttachmentTray items={images} onRemove={id => {
        if (sending.current) return;
        const found = attached.current.find(image => image.id === id);
        if (found?.preview) URL.revokeObjectURL(found.preview);
        attached.current = attached.current.filter(image => image.id !== id);
        setImages(attached.current);
      }}/>}
      leading={<>
        <input ref={attaching} type="file" accept={IMAGE_TYPES.join(',')} aria-label="이미지 파일" hidden multiple onChange={event => {
          add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}/>
        <Button type="button" variant="ghost" size="icon" disabled={disabled || pending} aria-label="이미지 첨부" onClick={() => attaching.current?.click()}><Paperclip aria-hidden="true"/></Button>
      </>}
      trailing={<>
        {state === 'working' && <Button type="button" className="embedded-queue" variant="ghost" size="sm" disabled={!readyToSend || tooLong || disabled || pending} onClick={() => void send(draft.trim(), 'follow_up')}>후속 지시 예약</Button>}
        {busy && <Button type="button" variant="ghost" size="icon" aria-label="작업 중단" title="작업 중단" disabled={disabled || stopping} onClick={onAbort}><Square aria-hidden="true"/></Button>}
      </>}/>
  </>;
}
