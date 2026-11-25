import { useEffect, useRef, useState, type MouseEventHandler, type Ref } from 'react';
import { BriefcaseBusiness, Settings2 } from 'lucide-react';
import { Button } from '../../ui';
import { PresenceAvatar } from '../agent';
import type { DotState } from '../../features/ghostState';
import type { Scope } from '@ghost/contract';

export interface ProjectTab { id: string; label: string; /** Items waiting on the owner. */ count?: number }

/**
 * The project's whole header in two quiet lines: the name (renames in place), who carries it, then the
 * tabs. Conversation tools land in `toolsRef`, where the chat already shows its Ghost, so the bar names
 * the receiver only on the other tabs. On a phone the title bar names the project and 일 맡기기 folds
 * into the tab row as an icon.
 */
export function ProjectBar({ scope, receiver, folder, tabs, active, onTab, onHandoff, canHandoff, onManage, toolsRef, disabled, onRename }: {
  scope: Scope;
  receiver: { id: string; name: string; presence: DotState } | null;
  /** Full path of the project's folder, shown only on hover of the name. */
  folder?: string;
  tabs: ProjectTab[];
  active: string;
  onTab(id: string): void;
  onHandoff: MouseEventHandler<HTMLButtonElement>;
  canHandoff: boolean;
  /** Opens 설정 where the receiving Ghost is chosen. */
  onManage(): void;
  toolsRef?: Ref<HTMLDivElement>;
  disabled?: boolean;
  onRename(name: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const start = () => { setDraft(scope.name); setError(''); cancelled.current = false; setEditing(true); };
  const close = () => { setEditing(false); setError(''); };
  const commit = async () => {
    if (cancelled.current) { close(); return; }
    const name = draft.trim();
    if (!name || name === scope.name) { close(); return; }
    try { await onRename(name); close(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '이름을 바꾸지 못했습니다.'); }
  };
  const settings = tabs.find(tab => tab.id === 'settings');
  const content = tabs.filter(tab => tab.id !== 'settings');
  const inChat = active === 'conversation';
  const renderTab = (item: ProjectTab) => <button key={item.id} type="button" className="project-tab" aria-current={active === item.id ? 'page' : undefined} onClick={() => onTab(item.id)}
    aria-label={item.id === 'settings' ? item.label : undefined} title={item.id === 'settings' ? item.label : undefined}>
    {item.id === 'settings' && <Settings2 size={15} aria-hidden="true"/>}<span className="project-tab__label" data-icon-only={item.id === 'settings' || undefined}>{item.label}</span>
    {item.count ? <span className="project-tab__count tabular" aria-label={`확인 필요 ${item.count}건`}>{item.count}</span> : null}
  </button>;

  return <header className="project-bar">
    <div className="project-bar__line">
      <div className="project-bar__id">
        <h1 className="project-bar__name">
          {editing
            ? <input ref={input} className="project-bar__input" aria-label="프로젝트 이름" value={draft} maxLength={128} autoComplete="off" aria-invalid={Boolean(error) || undefined}
              onChange={event => setDraft(event.target.value)} onBlur={() => void commit()}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); void commit(); }
                if (event.key === 'Escape') { cancelled.current = true; close(); }
              }}/>
            : <button type="button" title={folder ? `이름 바꾸기 · ${folder}` : '이름 바꾸기'} disabled={disabled} onClick={start}>{scope.name}</button>}
        </h1>
        <p className="project-bar__meta">
          {scope.state === 'paused' && <span className="project-bar__paused">멈춤</span>}
          {!receiver && <button type="button" className="link-quiet" onClick={onManage}>받을 Ghost 정하기</button>}
          {receiver && !inChat && <span className="project-bar__receiver" title={receiver.name}>
            <PresenceAvatar ghostId={receiver.id} state={receiver.presence} size={20}/><span className="sr-only">{receiver.name}</span>
          </span>}
        </p>
      </div>
      <div className="project-bar__actions">
        <div ref={toolsRef} className="project-bar__tools"/>
        <Button variant="outline" className="project-bar__handoff max-[55.999rem]:hidden" disabled={!canHandoff} onClick={onHandoff}><BriefcaseBusiness size={16} aria-hidden="true"/>일 맡기기</Button>
      </div>
    </div>
    {error && <p className="project-bar__error" role="alert">{error}</p>}
    <nav className="project-tabs" aria-label="프로젝트 내용">
      {content.map(renderTab)}
      <span className="project-tabs__end">
        <button type="button" className="project-tab project-tabs__handoff" disabled={!canHandoff} aria-label="일 맡기기" title="일 맡기기" onClick={onHandoff}><BriefcaseBusiness size={16} aria-hidden="true"/></button>
        {settings && renderTab(settings)}
      </span>
    </nav>
  </header>;
}
