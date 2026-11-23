import { useEffect, useId, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { ListEnd, Navigation, Paperclip, Slash, Square } from 'lucide-react';
import type { HerdrDelivery, HerdrSlashCommand, HerdrUpload } from '@ghost/contract';
import { Composer, InlineError } from '../ui';
import { NextSuggestions } from '../components/composer/NextSuggestions';
import { ComposerSuggest, type Suggestion } from '../components/composer/ComposerSuggest';
import { HerdrModelChip, type ModelChoice } from './HerdrModel';
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
 * The follow-up field of an agent pane. It stays writable while the agent works (a blocked agent shows its approval card instead of the field): Enter delivers the way the owner chose
 * in 설정 (스티어링 or 대기열), ⌥Enter the other way. A next message the owner is likely to send waits above the text
 * while the field is empty; Tab (or a tap) puts it in the field, nothing is sent.
 */
export function HerdrComposer({ agent, working, pending, delivery, draft, field, suggestions, commands, model, onSubmit, onStop, canUpload }: {
  agent: string | null; working: boolean; pending: boolean; delivery: HerdrDelivery;
  draft: HerdrDraft; field: RefObject<HTMLTextAreaElement | null>; suggestions: readonly string[];
  /** The slash commands the agent accepts; typing `/` offers them. */
  commands: readonly HerdrSlashCommand[];
  /** The conversation's model and the directory its choices are read for; absent when the agent has no model switch. */
  model?: { cwd: string | null; current: string | null; load(cwd: string, signal: AbortSignal): Promise<readonly ModelChoice[]> };
  onSubmit(text: string, delivery?: HerdrDelivery): Promise<boolean>; onStop?(): void; canUpload: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const queueable = working && agent === QUEUE_KEY_AGENT;
  const other: HerdrDelivery = delivery === 'steer' ? 'queue' : 'steer';
  const offered = !draft.draft && !working ? suggestions : [];
  async function send(sent: string, mode: HerdrDelivery) {
    if (pending || draft.uploading || !sent.trim()) return;
    const accepted = await onSubmit(sent.trim(), working ? mode : undefined);
    if (accepted) draft.setDraft(current => current === sent ? '' : current);
    requestAnimationFrame(() => { if (!matchMedia('(pointer: coarse)').matches) field.current?.focus({ preventScroll: true }); });
  }
  const pick = (text: string) => {
    draft.setDraft(text);
    requestAnimationFrame(() => field.current?.focus({ preventScroll: true }));
  };
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
  const placeholder = !working ? '후속 지시' : !queueable ? '작업 중 — 이어서 지시' : delivery === 'steer' ? '작업 중 — 지금 바로 전달' : '작업 중 — 끝난 뒤 전달';
  return <Composer className="coding-composer" label="후속 지시" placeholder={placeholder} submitLabel={queueable ? `${deliveryLabel[delivery]}로 보내기` : '보내기'}
    inputRef={field} value={draft.draft} onValueChange={value => { draft.setDraft(value); setActive(0); }} onSubmit={() => void send(draft.draft, delivery)}
    pending={pending || draft.uploading} running={working}
    onFiles={canUpload ? files => void draft.attach(files) : undefined}
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
      <button type="button" className="composer-plus__trigger" aria-label="파일 첨부" title="파일 첨부" disabled={pending || draft.uploading}
        onClick={() => picker.current?.click()}><Paperclip aria-hidden="true"/></button>
    </> : undefined}
    footer={model || queueable ? <>
      {model && agent && <HerdrModelChip agent={agent} cwd={model.cwd} current={model.current} load={model.load} disabled={working || pending}
        onPick={selector => void onSubmit(`/model ${selector}`)}/>}
      {queueable && <span className="coding-delivery" title={`Enter ${deliveryLabel[delivery]} · ⌥Enter ${deliveryLabel[other]}`}>
        {delivery === 'steer' ? <Navigation aria-hidden="true"/> : <ListEnd aria-hidden="true"/>}{deliveryLabel[delivery]}
      </span>}
    </> : undefined}
    trailing={onStop && working ? <button type="button" className="chat-stop" aria-label="작업 중단" title="작업 중단 (Esc)" onClick={onStop}>
      <Square aria-hidden="true"/></button> : undefined}/>;
}
