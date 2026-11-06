import { MessageCircle, PackagePlus, Palette, Plus, Settings2 } from 'lucide-react';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor, type Profile } from '../client/types';
import { ghostDisplayName, profileSummary } from './profileSummary';

/** Ghost roster and per-Ghost management, moved out of the title bar switcher. */
export function TeamSettings({ profiles, defaultGhostId, connected, onChat, onManage, onPortrait, onAdd, onImport }: {
  profiles: Profile[]; defaultGhostId: string | null; connected: boolean;
  onChat(id: string): void; onManage?: (id: string) => void; onPortrait(id: string): void; onAdd(): void; onImport(): void;
}) {
  return <section className="team-settings" aria-labelledby="team-heading">
    <div className="team-settings-heading"><h2 id="team-heading">팀</h2>
      <div className="team-settings-actions">
        <button className="button secondary" onClick={onImport}><PackagePlus size={15}/>패키지 추가</button>
        <button className="button primary" disabled={!connected} onClick={onAdd}><Plus size={15}/>새 Ghost</button>
      </div>
    </div>
    <ul className="team-list">{[...profiles].sort((a, b) => Number(b.id === defaultGhostId) - Number(a.id === defaultGhostId)).map(profile => {
      const name = ghostDisplayName(profile.name);
      return <li className="team-row" key={profile.id}>
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={36}/>
        <span className="team-row-copy"><strong>{name}{profile.id === defaultGhostId && <span className="ghost-default-badge">기본</span>}</strong>
          <small>{profileSummary(profile.persona)}</small></span>
        <span className="team-row-actions">
          <button className="icon-button" aria-label={`${name} 대화`} title="대화" onClick={() => onChat(profile.id)}><MessageCircle size={16}/></button>
          {onManage && <button className="icon-button" aria-label={`${name} 관리`} title="관리" onClick={() => onManage(profile.id)}><Settings2 size={16}/></button>}
          <button className="icon-button" aria-label={`${name} 초상화 색상`} title="초상화 색상" onClick={() => onPortrait(profile.id)}><Palette size={16}/></button>
        </span>
      </li>;
    })}</ul>
  </section>;
}
