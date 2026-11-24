import { useState } from 'react';
import type { Scope } from '@ghost/contract';
import { Button, InlineError } from '../ui';
import { useHost } from '../host/context';
import { uiTerms } from '../uiText';
import { HoldButton } from '../components/projects/HoldButton';
import { ScopeEditor } from './ScopeEditor';
import { Activities } from './Activities';
import { PolicySettings } from './PolicySettings';
import { ScopeMetrics } from './ScopeMetrics';
import { ConfigHistory } from './ConfigHistory';

/** The parts of 설정; `settings` is the basics form, the rest are the project's standing machinery. */
export const settingsParts = [
  { id: 'settings', label: '기본 정보' },
  { id: 'triggers', label: uiTerms.activities },
  { id: 'rules', label: uiTerms.rules },
  { id: 'metrics', label: uiTerms.metrics },
  { id: 'history', label: uiTerms.configHistory },
] as const;

/** Everything about how the project is set up, one part at a time, so the daily tabs stay few. */
export function ProjectSettings({ scope, part, onPart, navigate, onLeave, onDeleted }: {
  scope: Scope; part: string; onPart(id: string): void; navigate(path: string): void; onLeave(): void; onDeleted(): void;
}) {
  return <div className="project-settings">
    <nav className="project-settings__nav" aria-label="프로젝트 설정">
      {settingsParts.map(item => <button key={item.id} type="button" aria-current={part === item.id ? 'page' : undefined} onClick={() => onPart(item.id)}>{item.label}</button>)}
    </nav>
    <div className="project-settings__panel">
      {part === 'settings' && <><ScopeEditor key={scope.updatedAt} scope={scope} onClose={onLeave} onSaved={onLeave}/><DeleteProject scope={scope} onDeleted={onDeleted}/></>}
      {part === 'triggers' && <Activities scopeId={scope.id} navigate={navigate}/>}
      {part === 'rules' && <PolicySettings scopeId={scope.id}/>}
      {part === 'metrics' && <ScopeMetrics scopeId={scope.id}/>}
      {part === 'history' && <ConfigHistory scopeId={scope.id}/>}
    </div>
  </div>;
}

function DeleteProject({ scope, onDeleted }: { scope: Scope; onDeleted(): void }) {
  const { client } = useHost();
  const [armed, setArmed] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('');
  const remove = async () => {
    setPending(true); setError('');
    try { await client.send({ type: 'scope.delete', scopeId: scope.id }); onDeleted(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '삭제하지 못했습니다.'); } finally { setPending(false); }
  };
  return <section className="project-delete" aria-label="프로젝트 삭제">
    {!armed ? <Button variant="ghost" size="sm" disabled={pending} onClick={() => setArmed(true)}>프로젝트 삭제</Button>
      : <div className="project-delete__strip"><p>{scope.name} 프로젝트 등록을 지울까요? 보관함의 문서는 지워지지 않습니다.</p>
        <div className="project-delete__row"><Button variant="outline" size="sm" disabled={pending} onClick={() => setArmed(false)}>취소</Button><HoldButton label="삭제" holdingLabel="누르는 중" disabled={pending} onComplete={() => void remove()}/></div></div>}
    {error && <InlineError>{error}</InlineError>}
  </section>;
}
