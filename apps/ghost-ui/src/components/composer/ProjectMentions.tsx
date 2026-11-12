import { useEffect, useId, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { Folder, X } from 'lucide-react';
import { useHost } from '../../host/context';
import { useHostState } from '../../host/store';
import { projectMentionQuery } from '../../features/conversationSuggestions';
import { ComposerSuggest } from './ComposerSuggest';
import './project-mentions.css';

type Project = { id: string; name: string };

export function ProjectChips({ scopes, onRemove }: { scopes: readonly Project[]; onRemove?(id: string): void }) {
  if (!scopes.length) return null;
  return <div className="project-chips" aria-label="언급한 프로젝트">
    {scopes.map(space => onRemove
      ? <button key={space.id} type="button" className="project-chip" aria-label={`${space.name} 프로젝트 빼기`} onClick={() => onRemove(space.id)}>
        <Folder size={14} aria-hidden="true"/><span>{space.name}</span><X size={13} aria-hidden="true"/>
      </button>
      : <a key={space.id} className="project-chip" href={`#/scopes/${encodeURIComponent(space.id)}`}><Folder size={14} aria-hidden="true"/><span>{space.name}</span></a>)}
  </div>;
}

/** Shared by direct chat, home and the project hand-off; the textarea keeps keyboard focus. */
export function useProjectMentions(text: string, setText: (value: string) => void, inputRef: RefObject<HTMLTextAreaElement | null>, initialScopeIds: readonly string[] = [], disabled = false, selectionKey?: string) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const scopes = state?.scopes ?? [];
  const [ids, setIds] = useState<string[]>(() => [...initialScopeIds].slice(0, 1));
  const [caret, setCaret] = useState(text.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState('');
  const id = useId();
  const initialKey = initialScopeIds.join('\0');
  useEffect(() => { setIds(initialKey ? initialKey.split('\0').slice(0, 1) : []); }, [initialKey, selectionKey]);
  const token = !disabled && ids.length < 1 ? projectMentionQuery(text, caret) : null;
  const matches = token && dismissed !== `${text}:${caret}`
    ? scopes.filter(space => !ids.includes(space.id) && space.name.toLocaleLowerCase().includes(token.query)).slice(0, 8) : [];
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const choose = (scopeId: string) => {
    if (!token) return;
    setIds(previous => [...previous, scopeId]);
    setText(text.slice(0, token.start) + text.slice(token.end));
    setCaret(token.start); setActive(0);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(token.start, token.start); });
  };
  const open = matches.length > 0;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); setActive((current + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(matches[current].id); }
    else if (event.key === 'Escape') { event.preventDefault(); setDismissed(`${text}:${caret}`); }
  };
  const selected = ids.map(scopeId => scopes.find(item => item.id === scopeId) ?? { id: scopeId, name: '삭제된 프로젝트' });
  return {
    scopeIds: ids,
    clear: () => setIds([...initialScopeIds].slice(0, 1)),
    onChange: (value: string) => { setText(value); setCaret(inputRef.current?.selectionStart ?? value.length); setActive(0); setDismissed(''); },
    onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => setCaret(event.currentTarget.selectionStart),
    onKeyDown,
    open,
    inputAria: { role: 'combobox' as const, 'aria-expanded': open, 'aria-controls': open ? id : undefined, 'aria-activedescendant': open ? `${id}-${current}` : undefined, 'aria-autocomplete': 'list' as const },
    above: open && <ComposerSuggest id={id} label="프로젝트" active={current} onActive={setActive}
      items={matches.map(space => ({ id: space.id, label: space.name, icon: <Folder size={18}/>, onSelect: () => choose(space.id) }))}/>,
    chips: <ProjectChips scopes={selected} onRemove={scopeId => setIds(previous => previous.filter(item => item !== scopeId))}/>,
  };
}
