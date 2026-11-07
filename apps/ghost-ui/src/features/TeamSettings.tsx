import { useState } from 'react';
import { MessageCircle, PackagePlus, Palette, Plus, Settings2 } from 'lucide-react';
import { Badge, Button, FormField, GSettingsGroup, GSettingsRow, InlineError, Input, SelectField, Textarea } from '@garden/ui';
import type { Ghost, ModelRef } from '@ghost/contract';
import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { toneFor } from './ghostState';
import { DotAvatar } from '../components/DotAvatar';
import { GhostAgentSettingsEditor } from './GhostAgentSettings';
import { profileSummary } from './profileSummary';
import { NO_MODEL, modelFromKey, modelSelectOptions } from '../pets/ModelPicker';
import { Modal } from '../components/Modal';

const stateBadge: Record<Ghost['state'], string | null> = { active: null, paused: '일시정지', retired: '은퇴' };

/** Ghost 목록과 새 Ghost 만들기. 대화·꾸미기 이동은 App이 콜백으로 연결하고, 선택한 Ghost의 설정(역할·도구)은 이 탭에서 고친다. */
export function TeamSettings({ onChat, onManage, onPortrait, onImport, selectedGhostId }: {
  onChat(id: string): void;
  onManage?(id: string): void;
  onPortrait?(id: string): void;
  onImport?(): void;
  /** Settings 주소의 ?ghost= 값. 없으면 첫 Ghost를 보여 준다. */
  selectedGhostId?: string;
}) {
  const { store, client } = useHost();
  const { state } = useHostState(store);
  const ghosts = [...(state?.ghosts ?? [])].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt - b.createdAt);
  const selected = ghosts.find(ghost => ghost.id === selectedGhostId) ?? ghosts[0] ?? null;
  const [creating, setCreating] = useState(false);
  return <section className="flex min-w-0 flex-col gap-3" aria-labelledby="team-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="team-heading" className="m-0 text-ui font-semibold text-ink">팀</h2>
      <div className="flex flex-wrap gap-2">
        {onImport && <Button variant="outline" type="button" onClick={onImport}><PackagePlus size={15}/>패키지 추가</Button>}
        <Button type="button" disabled={!state} onClick={() => setCreating(true)}><Plus size={15}/>새 Ghost</Button>
      </div>
    </div>
    <GSettingsGroup title={<span className="sr-only">Ghost 목록</span>}>{ghosts.map(ghost => {
      const badge = stateBadge[ghost.state];
      return <GSettingsRow key={ghost.id} label={<span className="flex min-w-0 items-center gap-3">
        <DotAvatar profileId={ghost.id} tone={toneFor(ghost.id)} size={36}/>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5 text-ui font-medium text-ink [overflow-wrap:anywhere]">{ghost.name}{ghost.isDefault && <Badge variant="outline">메인</Badge>}{badge && <Badge variant="outline">{badge}</Badge>}</span>
          <span className="text-caption text-ink-3">{profileSummary(ghost.persona)}</span>
        </span>
      </span>}>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="icon" type="button" aria-label={`${ghost.name} 대화`} title="대화" onClick={() => onChat(ghost.id)}><MessageCircle size={16}/></Button>
          {onManage && <Button variant="ghost" size="icon" type="button" aria-label={`${ghost.name} 설정`} title="Ghost 설정" onClick={() => onManage(ghost.id)}><Settings2 size={16}/></Button>}
          {onPortrait && <Button variant="ghost" size="icon" type="button" aria-label={`${ghost.name} 꾸미기`} title="꾸미기" onClick={() => onPortrait(ghost.id)}><Palette size={16}/></Button>}
        </span>
      </GSettingsRow>;
    })}</GSettingsGroup>
    {selected && <section className="grid gap-3" aria-labelledby="ghost-settings-heading">
      <h3 id="ghost-settings-heading" className="m-0 text-ui font-semibold text-ink">{selected.name} 설정</h3>
      <GhostAgentSettingsEditor key={selected.id} ghostId={selected.id}/>
    </section>}
    {creating && <GhostCreateDialog onClose={() => setCreating(false)} onCreate={async input => {
      const created = await client.send<Partial<Ghost>>({ type: 'ghost.create', ...input });
      setCreating(false);
      if (created.id) onChat(created.id);
    }}/>}
  </section>;
}

function GhostCreateDialog({ onClose, onCreate }: { onClose: () => void; onCreate(input: { name: string; persona: string; model?: ModelRef | null }): Promise<void> }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const [name, setName] = useState(''), [persona, setPersona] = useState(''), [modelKey, setModelKey] = useState(NO_MODEL);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim() || !persona.trim() || saving) return;
    setSaving(true); setError('');
    try { await onCreate({ name: name.trim(), persona, model: modelFromKey(state?.settings, modelKey) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Ghost를 만들지 못했습니다.'); setSaving(false); }
  };
  return <Modal title="새 Ghost" onClose={() => !saving && onClose()} className="w-[min(560px,calc(100vw-2rem))] sm:max-w-[560px]">
    <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <FormField label="이름">{control => <Input {...control} value={name} onChange={event => setName(event.target.value)} required maxLength={128} disabled={saving}/>}</FormField>
      <FormField label="역할 지시" description="이 Ghost가 어떻게 말하고 일할지 알려 주세요.">
        {control => <Textarea {...control} value={persona} onChange={event => setPersona(event.target.value)} required rows={5} maxLength={8192} disabled={saving}/>}
      </FormField>
      <FormField label="모델" description="설정의 기본 모델을 따르려면 선택 안 함.">
        {control => <SelectField {...control} label="모델" value={modelKey} disabled={saving} onValueChange={setModelKey}
          options={[{ value: NO_MODEL, label: '기본 모델 따름' }, ...modelSelectOptions(state?.settings)]}/>}
      </FormField>
      {error && <InlineError>{error}</InlineError>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" type="button" disabled={saving} onClick={onClose}>취소</Button>
        <Button type="submit" disabled={saving || !name.trim() || !persona.trim()}>{saving ? '만드는 중…' : '만들기'}</Button>
      </div>
    </form>
  </Modal>;
}
