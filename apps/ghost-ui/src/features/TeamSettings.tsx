import { MessageCircle, PackagePlus, Palette, Plus, Settings2 } from 'lucide-react';
import { Badge, Button, GSettingsGroup, GSettingsRow } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { toneFor, type Profile } from '../client/types';
import { ghostDisplayName, profileSummary } from './profileSummary';

/** Ghost roster and per-Ghost management, moved out of the title bar switcher. */
export function TeamSettings({ profiles, defaultGhostId, connected, onChat, onManage, onPortrait, onAdd, onImport }: {
  profiles: Profile[]; defaultGhostId: string | null; connected: boolean;
  onChat(id: string): void; onManage?: (id: string) => void; onPortrait(id: string): void; onAdd(): void; onImport(): void;
}) {
  return <section className="flex min-w-0 flex-col gap-3" aria-labelledby="team-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="team-heading" className="m-0 text-ui font-semibold text-ink">팀</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" type="button" onClick={onImport}><PackagePlus size={15}/>패키지 추가</Button>
        <Button type="button" disabled={!connected} onClick={onAdd}><Plus size={15}/>새 Ghost</Button>
      </div>
    </div>
    <GSettingsGroup title={<span className="sr-only">Ghost 목록</span>}>{[...profiles].sort((a, b) => Number(b.id === defaultGhostId) - Number(a.id === defaultGhostId)).map(profile => {
      const name = ghostDisplayName(profile);
      return <GSettingsRow key={profile.id} label={<span className="flex min-w-0 items-center gap-3">
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={36}/>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5 text-ui font-medium text-ink [overflow-wrap:anywhere]">{name}{profile.id === defaultGhostId && <Badge variant="outline">메인</Badge>}</span>
          <span className="text-caption text-ink-3">{profileSummary(profile.persona)}</span>
        </span>
      </span>}>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon" type="button" aria-label={`${name} 대화`} title="대화" onClick={() => onChat(profile.id)}><MessageCircle size={16}/></Button>
          {onManage && <Button variant="ghost" size="icon" type="button" aria-label={`${name} 관리`} title="관리" onClick={() => onManage(profile.id)}><Settings2 size={16}/></Button>}
          <Button variant="ghost" size="icon" type="button" aria-label={`${name} 초상화 색상`} title="초상화 색상" onClick={() => onPortrait(profile.id)}><Palette size={16}/></Button>
        </span>
      </GSettingsRow>;
    })}</GSettingsGroup>
  </section>;
}
