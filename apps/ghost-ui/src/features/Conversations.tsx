import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { Ghost } from '@ghost/contract';
import { DotAvatar } from '../components/DotAvatar';
import { blurTouchSearchOnEnter } from '../ui/adaptive';
import { toneFor, visibleGhosts } from './ghostState';

export function Conversations({ ghosts, openGhost }: { ghosts: readonly Ghost[]; openGhost(id: string): void }) {
  const [query, setQuery] = useState('');
  const roster = visibleGhosts(ghosts);
  const needle = query.trim().toLocaleLowerCase();
  const matches = roster.filter(ghost => ghost.name.toLocaleLowerCase().includes(needle));

  return <section className="conversations" aria-labelledby="conversations-heading">
    <h1 id="conversations-heading" className="conversations__heading">대화</h1>
    {roster.length > 0 && <input type="search" className="conversations__search" aria-label="Ghost 찾기" placeholder="Ghost 찾기"
      value={query} enterKeyHint="search" onChange={event => setQuery(event.target.value)} onKeyDown={blurTouchSearchOnEnter}/>}
    {matches.length > 0
      ? <ul className="conversations__list">
        {matches.map(ghost => <li key={ghost.id}>
          <button type="button" onClick={() => openGhost(ghost.id)}>
            <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={36}/>
            <span className="conversations__name">{ghost.name}</span>
            {ghost.isDefault && <span className="presence-row__main-mark">메인</span>}
            <ChevronRight size={16} aria-hidden="true"/>
          </button>
        </li>)}
      </ul>
      : <p className="conversations__empty" role="status">{needle ? '일치하는 Ghost가 없습니다.' : '대화할 Ghost가 없습니다.'}</p>}
  </section>;
}
