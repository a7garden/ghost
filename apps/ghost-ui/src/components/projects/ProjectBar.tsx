import { useEffect, useRef, useState, type MouseEventHandler, type Ref } from 'react';
import { BriefcaseBusiness, CodeXml, Folder, Settings2 } from 'lucide-react';
import { Button } from '../../ui';
import { PresenceAvatar } from '../agent';
import type { DotState } from '../../features/ghostState';
import type { Scope } from '@ghost/contract';
import { workbenchPath } from '../../features/workbenchRoute';

export interface ProjectTab { id: string; label: string; /** Items waiting on the owner. */ count?: number }

/** Keep project identity, destinations, and actions on the same edge. */
export function ProjectBar({ scope, receiver, folder, tabs, active, onTab, onHandoff, canHandoff, onManage, onOpenGhost, onOpenCoding, toolsRef, onRename }: {
  scope: Scope;
  receiver: { id: string; name: string; presence: DotState } | null;
  folder?: string;
  tabs: ProjectTab[];
  active: string;
  onTab(id: string): void;
  onHandoff: MouseEventHandler<HTMLButtonElement>;
  canHandoff: boolean;
  onManage(): void;
  onOpenGhost(id: string): void;
  onOpenCoding(path: string): void;
  toolsRef?: Ref<HTMLDivElement>;
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
  const folderName = folder?.split('/').filter(Boolean).at(-1) ?? folder;
  return <header className="project-bar">
    <div className="project-bar__layout">
      <div className="project-bar__id">
        <h1 className="project-bar__name">
          {editing
            ? <input ref={input} className="project-bar__input" aria-label="프로젝트 이름" value={draft} maxLength={128} autoComplete="off" aria-invalid={Boolean(error) || undefined}
              onChange={event => setDraft(event.target.value)} onBlur={() => void commit()}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') { event.preventDefault(); void commit(); }
                if (event.key === 'Escape') { cancelled.current = true; close(); }
              }}/>
            : <button type="button" title="이름 바꾸기" onClick={start}>{scope.name}</button>}
        </h1>
        {scope.state === 'paused' && <span className="project-bar__paused">멈춤</span>}
        {receiver
          ? <button type="button" className="project-bar__receiver" title={receiver.name} onClick={() => onOpenGhost(receiver.id)}>
            <PresenceAvatar ghostId={receiver.id} state={receiver.presence} size={20}/><span>{receiver.name}</span>
          </button>
          : <button type="button" className="link-quiet project-bar__receiver" onClick={onManage}>받을 Ghost 정하기</button>}
        {folder && <span className="project-bar__folder" title={folder}><Folder size={13} aria-hidden="true"/><span>{folderName}</span></span>}
        <div ref={toolsRef} className="project-bar__tools"/>
      </div>
      <nav className="project-nav" aria-label="프로젝트 내용">
        <div className="project-tabs">
          {tabs.map(item => <button key={item.id} type="button" className="project-tab" aria-current={active === item.id ? 'page' : undefined} onClick={() => onTab(item.id)}>
            {item.label}{item.count ? <span className="project-tab__count tabular" aria-label={`확인 필요 ${item.count}건`}>{item.count}</span> : null}
          </button>)}
          <a className="project-tab project-tab--coding" href={`#${workbenchPath(scope.id)}`} aria-label={`${scope.name} 코딩 작업대`}
            onClick={event => {
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
              event.preventDefault(); onOpenCoding(workbenchPath(scope.id));
            }}><CodeXml size={14} aria-hidden="true"/>코딩</a>
        </div>
        <div className="project-bar__actions">
          <Button variant="ghost" size="icon" className="project-bar__settings" aria-label="설정" title="설정"
            aria-current={active === 'settings' ? 'page' : undefined} onClick={onManage}><Settings2 size={16} aria-hidden="true"/></Button>
          <Button className="project-bar__handoff" aria-label="일 맡기기" title="일 맡기기" disabled={!canHandoff} onClick={onHandoff}>
            <BriefcaseBusiness size={16} aria-hidden="true"/><span>일 맡기기</span>
          </Button>
        </div>
      </nav>
    </div>
    {error && <p className="project-bar__error" role="alert">{error}</p>}
  </header>;
}
