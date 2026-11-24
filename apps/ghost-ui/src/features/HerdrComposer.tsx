import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Paperclip, Slash, Square } from 'lucide-react';
import type { HerdrDelivery, HerdrSlashCommand, HerdrUpload } from '@ghost/contract';
import { Composer, InlineError } from '../ui';
import { NextSuggestions, useNextPick } from '../components/composer/NextSuggestions';
import { AttachmentTray, type PendingAttachment } from '../components/composer/attachments';
import { ComposerSuggest, type Suggestion } from '../components/composer/ComposerSuggest';
import { HerdrModelChip, type ModelChoice } from './HerdrModel';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';
import type { HerdrPromptDraft, HerdrReadyAttachment } from './HerdrPromptModel';

type CodingAttachment = PendingAttachment & { file: File; saved?: HerdrUpload };
const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export type HerdrDraft = {
  draft: string;
  setDraft: (text: string) => void;
  attach(files: File[]): void;
  items: PendingAttachment[];
  ready: readonly HerdrReadyAttachment[];
  remove(id: string): void;
  clear(): void;
  restore(message: HerdrPromptDraft): void;
  incomplete: boolean;
};

export function useHerdrDraft(key: string | undefined, upload?: (file: File) => Promise<HerdrUpload>): HerdrDraft {
  const [draft, setDraft] = useState(() => key ? readCodingValue(key) ?? '' : '');
  useEffect(() => { if (key) writeCodingValue(key, draft); }, [key, draft]);
  const [items, setItems] = useState<CodingAttachment[]>([]);
  const current = useRef<CodingAttachment[]>([]);
  useEffect(() => () => {
    for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
    current.current = [];
  }, []);
  function update(next: CodingAttachment[]) {
    current.current = next;
    setItems(next);
  }
  function remove(id: string) {
    const gone = current.current.find(item => item.id === id);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    update(current.current.filter(item => item.id !== id));
  }
  function patch(id: string, change: Partial<CodingAttachment>) {
    if (current.current.some(item => item.id === id)) update(current.current.map(item => item.id === id ? { ...item, ...change } : item));
  }
  function tile(id: string, file: File) {
    return { id, file, name: file.name, size: file.size, type: file.type,
      preview: file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif|heic)$/i.test(file.name) ? URL.createObjectURL(file) : undefined };
  }

  function attach(files: File[]) {
    if (!upload) return;
    for (const file of files.slice(0, Math.max(0, MAX_FILES - current.current.length))) {
      const id = crypto.randomUUID();
      const tooLarge = file.size > MAX_FILE_BYTES;
      update([...current.current, { ...tile(id, file), status: tooLarge ? 'failed' : 'uploading',
        ...(tooLarge && { error: '10MB보다 큽니다.' }) }]);
      if (!tooLarge) void upload(file).then(
        saved => patch(id, { status: 'ready', saved }),
        reason => patch(id, { status: 'failed', error: reason instanceof Error ? reason.message : '첨부하지 못했습니다.' }),
      );
    }
  }
  function clear() {
    for (const item of current.current) if (item.preview) URL.revokeObjectURL(item.preview);
    update([]);
    setDraft('');
  }
  function restore({ text, attachments }: HerdrPromptDraft) {
    if (text) setDraft(existing => existing ? `${existing}\n\n${text}` : text);
    if (!attachments.length) return;
    const returned = attachments.filter(item => !current.current.some(existing => existing.id === item.id));
    update([...current.current, ...returned.map(item => ({ ...tile(item.id, item.file), status: 'ready' as const, saved: item.saved }))]);
  }
  const ready: HerdrReadyAttachment[] = items.flatMap(({ id, file, saved }) => saved ? [{ id, file, saved }] : []);
  return { draft, setDraft, attach, items, ready, remove, clear, restore, incomplete: ready.length !== items.length };
}

const deliveryLabel = { steer: '스티어링', queue: '대기열' } as const satisfies Record<HerdrDelivery, string>;

/** Only omp's own keyboard separates steering (Enter) from queueing (Alt+Enter); the Host sends no other agent a different key. */
const QUEUE_KEY_AGENT = 'omp';

/**
 * The follow-up field of an agent pane. It stays writable while the agent works (a blocked agent shows its approval card instead of the field): Enter delivers the way the owner chose
 * in 설정 (스티어링 or 대기열), ⌥Enter the other way. A next message the owner is likely to send waits above the text
 * while the field is empty; Tab (or a tap) puts it in the field, nothing is sent.
 */
export function HerdrComposer({ agent, working, pending, delivery, draft, field, suggestions, commands, model, onSubmit, onCommand, onStop, canUpload }: {
  agent: string | null; working: boolean; pending: boolean; delivery: HerdrDelivery;
  draft: HerdrDraft; field: RefObject<HTMLTextAreaElement | null>; suggestions: readonly string[];
  /** The slash commands the agent accepts; typing `/` offers them. */
  commands: readonly HerdrSlashCommand[];
  /** The conversation's model and the directory its choices are read for; absent when the agent has no model switch. */
  model?: { cwd: string | null; current: string | null; load(cwd: string, signal: AbortSignal): Promise<readonly ModelChoice[]> };
  onSubmit(message: HerdrPromptDraft, delivery?: HerdrDelivery): void; onCommand(text: string): void;
  onStop?(): void; canUpload: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const queueable = working && agent === QUEUE_KEY_AGENT;
  const other: HerdrDelivery = delivery === 'steer' ? 'queue' : 'steer';
  const overLimit = draft.items.length > MAX_FILES;
  const offered = !draft.draft && !draft.items.length && !working ? suggestions : [];
  function send(mode: HerdrDelivery) {
    const text = draft.draft.trim();
    if (pending || draft.incomplete || overLimit || (!text && !draft.ready.length)) return;
    onSubmit({ text, attachments: draft.ready }, working ? mode : undefined);
    if (!matchMedia('(pointer: coarse)').matches) field.current?.focus({ preventScroll: true });
  }
  const pick = (text: string) => {
    draft.setDraft(text);
    requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  };
  const next = useNextPick(offered, pick);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const menuId = useId();
  // `/word` as the whole draft lists the commands whose name starts with, then contains, the word.
  const typed = commands.length ? /^\/(\S*)$/.exec(draft.draft) : null;
  const query = typed?.[1]!.toLowerCase() ?? '';
  const matches = !typed || dismissed === draft.draft ? [] : [
    ...commands.filter(command => command.name.toLowerCase().startsWith(query)),
    ...commands.filter(command => !command.name.toLowerCase().startsWith(query) && command.name.toLowerCase().includes(query)),
  ].slice(0, 40);
  const open = matches.length > 0;
  const current = Math.min(active, matches.length - 1);
  const choose = (command: HerdrSlashCommand) => { draft.setDraft(`/${command.name} `); setActive(0); requestAnimationFrame(() => field.current?.focus({ preventScroll: true })); };
  const items: Suggestion[] = matches.map(command => ({
    id: command.name, icon: <Slash aria-hidden="true"/>, label: command.name, hint: command.hint ?? command.description, onSelect: () => choose(command),
  }));
  return <Composer className="coding-composer" label="후속 지시" placeholder={working ? '작업 중 — 이어서 지시' : '메시지'} submitLabel={queueable ? `${deliveryLabel[delivery]}로 보내기` : '보내기'}
    inputRef={field} value={draft.draft} onValueChange={value => { draft.setDraft(value); setActive(0); }} onSubmit={() => send(delivery)}
    canSubmitEmpty={draft.ready.length > 0} keepInputEnabledWhilePending pending={pending || draft.incomplete || overLimit}
    onFiles={canUpload && !pending ? draft.attach : undefined}
    above={open ? <ComposerSuggest id={menuId} label="슬래시 명령" items={items} active={current} onActive={setActive}/> : undefined}
    inputAria={{ role: 'combobox', 'aria-expanded': open, 'aria-controls': open ? menuId : undefined, 'aria-activedescendant': open ? `${menuId}-${current}` : undefined, 'aria-autocomplete': 'list' }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (open) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((current + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          choose(matches[current]!);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDismissed(draft.draft);
        }
        return;
      }
      if (next.onKeyDown(event)) return;
      if (event.key === 'Enter' && event.altKey && queueable) {
        event.preventDefault();
        send(other);
      }
    }}
    ghost={offered.length > 0 ? <NextSuggestions items={offered} active={next.active} onCycle={() => next.cycle(1)} onPick={pick}/> : undefined}
    tray={<>
      <AttachmentTray items={draft.items} onRemove={draft.remove}/>
      {overLimit && <InlineError>파일은 {MAX_FILES}개까지 보낼 수 있습니다.</InlineError>}
    </>}
    leading={canUpload ? <>
      <input ref={picker} hidden type="file" multiple onChange={event => {
        if (event.currentTarget.files) draft.attach(Array.from(event.currentTarget.files));
        event.currentTarget.value = '';
      }}/>
      <button type="button" className="composer-plus__trigger" aria-label="파일 첨부" title="파일 첨부" disabled={pending || draft.items.length >= MAX_FILES}
        onClick={() => picker.current?.click()}><Paperclip aria-hidden="true"/></button>
    </> : undefined}
    footer={model && agent ? <HerdrModelChip agent={agent} cwd={model.cwd} current={model.current} load={model.load} disabled={working || pending}
      onPick={selector => onCommand(`/model ${selector}`)}/> : undefined}
    trailing={onStop && working ? <button type="button" className="chat-stop" aria-label="작업 중단" title="작업 중단 (Esc)" onClick={onStop}>
      <Square aria-hidden="true"/></button> : undefined}/>;
}
