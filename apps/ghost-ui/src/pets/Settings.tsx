import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, Download, Monitor, Moon, Palette, PawPrint, Plus, Sun, Trash2, RefreshCw, FolderInput, Cpu, type LucideIcon } from 'lucide-react';
import { Button, FormField, GSettings, GSettingsGroup, GSettingsRow, InlineError, SegmentedControl, SelectField, Switch } from '@garden/ui';
import type { Avatar, Command, Snapshot } from '../client/types';
import { toneFor } from '../client/types';
import { DotAvatar } from '../components/DotAvatar';
import { PetSprite } from './PetSprite';
import { PetEditor } from './PetEditor';
import type { AvatarInput } from './PetEditor';
import { useAvatarSource } from './AvatarProvider';
import { downloadPet } from './archive';
import { STATES } from './sprites';
import type { PetState } from './sprites';
import type { Preferences } from './preferences';
import { Modal } from '../components/Modal';
import { GhostCharacter } from './GhostCharacter';
import { GhostColorPicker } from './GhostColorPicker';
import { CodexPetImport } from './CodexPetImport';
import { ModelSettings } from './ModelSettings';

type Action = (command: Command) => Promise<Record<string, any>>;
export interface SettingsSection { id: string; label: string; icon: LucideIcon; content: ReactNode }
/** `sections` are owner-level areas rendered by the app shell (team, extensions, host). */
export function Settings({ snapshot, route, navigate, action, busy, mode, preferences, updatePreferences, storageError, connected = true, sections }: { snapshot: Snapshot; route: string; navigate: (path: string) => void; action: Action; busy: boolean; mode: 'demo' | 'live'; preferences: Preferences; updatePreferences: (p: Partial<Preferences>) => void; storageError: string; connected?: boolean; sections: SettingsSection[] }) {
  const params = new URLSearchParams(route.split('?')[1]);
  const items = [...sections.slice(0, 1), { id: 'models', label: '모델', icon: Cpu }, ...sections.slice(1), { id: 'appearance', label: '화면', icon: Palette }, { id: 'pets', label: '아바타', icon: PawPrint }];
  const requested = params.get('tab');
  const tab = items.some(item => item.id === requested) ? requested! : items[0].id;
  const profileId = params.get('ghost') ?? snapshot.profiles[0]?.id ?? '';
  const profile = snapshot.profiles.find(p => p.id === profileId) ?? snapshot.profiles[0];
  const changeTab = (next: string) => navigate(`/settings?tab=${next}${profile ? `&ghost=${encodeURIComponent(profile.id)}` : ''}`);
  const shellSection = sections.find(section => section.id === tab);
  return <GSettings title="설정" strings={{ navigationLabel: '설정 항목', contentLabel: '설정 내용' }}
    sections={items.map(item => ({ id: item.id, label: item.label, icon: <item.icon aria-hidden="true"/> }))}
    activeSection={tab} onSectionChange={changeTab}>
    {shellSection?.content}
    {storageError && <InlineError className="mt-4">{storageError}</InlineError>}
    {tab === 'appearance' && <GSettingsGroup title={<span className="sr-only">화면</span>}>
      <GSettingsRow label="테마">
        <SegmentedControl aria-label="테마" value={preferences.theme} onValueChange={theme => updatePreferences({ theme: theme as Preferences['theme'] })}
          options={[{ value: 'system', label: <span className="flex items-center gap-1.5"><Monitor size={14}/>시스템</span> },
            { value: 'light', label: <span className="flex items-center gap-1.5"><Sun size={14}/>밝게</span> },
            { value: 'dark', label: <span className="flex items-center gap-1.5"><Moon size={14}/>어둡게</span> }]}/>
      </GSettingsRow>
      <GSettingsRow label="아바타 애니메이션" description="작업 중에 움직입니다. 시스템의 동작 줄이기 설정을 따릅니다." htmlFor="animate-switch">
        <Switch id="animate-switch" checked={preferences.animate} onCheckedChange={animate => updatePreferences({ animate })}/>
      </GSettingsRow>
    </GSettingsGroup>}
    {tab === 'appearance' && <p className="m-0 text-caption text-ink-3">표시 설정은 이 브라우저에 저장됩니다.</p>}
    {tab === 'models' && <ModelSettings snapshot={snapshot} action={action} busy={busy} mode={mode} connected={connected}/>}
    {tab === 'pets' && <>
      <PetLibrary key={profile?.id ?? 'empty'} snapshot={snapshot} profileId={profile?.id} action={action} busy={busy} navigate={navigate} animate={preferences.animate} color={preferences.ghostColor} onColor={ghostColor => updatePreferences({ ghostColor })}/>
      <GSettingsGroup title="작업실 펫">
        <GSettingsRow label="작업실에 펫 표시" description="펫을 누르면 선택한 Ghost와의 대화가 열립니다." htmlFor="companion-switch">
          <Switch id="companion-switch" checked={preferences.companion} onCheckedChange={companion => updatePreferences({ companion })}/>
        </GSettingsRow>
        {preferences.companion && <GSettingsRow label="표시할 Ghost" htmlFor="companion-profile">
          <SelectField id="companion-profile" label="표시할 Ghost" value={snapshot.profiles.some(p => p.id === preferences.companionProfile) ? preferences.companionProfile : snapshot.profiles[0]?.id ?? ''}
            onValueChange={companionProfile => updatePreferences({ companionProfile })}
            options={snapshot.profiles.map(p => ({ value: p.id, label: p.name }))}/>
        </GSettingsRow>}
      </GSettingsGroup>
    </>}

  </GSettings>;
}
function PetLibrary({ snapshot, profileId, action, busy, navigate, animate, color, onColor }: { snapshot: Snapshot; profileId?: string; action: Action; busy: boolean; navigate: (path: string) => void; animate: boolean; color: string; onColor: (color: string) => void }) {
  const profile = snapshot.profiles.find(p => p.id === profileId);
  const [selectedId, setSelectedId] = useState<string | null>(profile?.avatar_id ?? null);
  const selected = snapshot.avatars.find(a => a.id === selectedId);
  const [editor, setEditor] = useState<true | Avatar | null>(null), [remove, setRemove] = useState(false), [importing, setImporting] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [motion, setMotion] = useState<PetState>('idle');
  const { source, error: imageError, retry } = useAvatarSource(selectedId, profile ? toneFor(profile.id) : 'mint');
  const inUse = selectedId ? snapshot.profiles.filter(p => p.avatar_id === selectedId) : [];
  useEffect(() => { if (selectedId && !snapshot.avatars.some(a => a.id === selectedId)) setSelectedId(profile?.avatar_id ?? null); }, [snapshot.avatars, selectedId, profile?.avatar_id]);
  const run = async (fn: () => Promise<void>) => { setError(''); setNotice(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '저장하지 못했습니다. 다시 시도해 주세요.'); } };
  const assign = async (id: string | null) => { if (!profile) return; await action({ type: 'workspace', action: { type: 'set_profile_avatar', profile_id: profile.id, avatar_id: id, version: profile.avatar_version ?? 0 } }); setNotice(`${profile.name}의 아바타를 저장했습니다.`); };
  const save = async (input: AvatarInput) => {
    setError(''); setNotice('');
    const created = await action({ type: 'workspace', action: { type: 'create_avatar', avatar: input } }) as Avatar;
    setSelectedId(created.id); setEditor(null); setImporting(false);
    try { await assign(created.id); if (!profile) setNotice('아바타를 보관함에 저장했습니다.'); } catch (e) { setError(`아바타는 보관함에 저장됐습니다. ${e instanceof Error ? e.message : 'Ghost에 다시 적용해 주세요.'}`); }
  };
  return <section className="flex min-w-0 flex-col gap-4" aria-label="아바타 보관함"><div className="flex flex-wrap items-end justify-between gap-4"><FormField label="아바타를 바꿀 Ghost">{control => <SelectField {...control} label="아바타를 바꿀 Ghost" className="w-[190px] max-w-full" value={profile?.id ?? '__empty__'} disabled={busy || !profile} onValueChange={id => { if (id !== '__empty__') navigate(`/settings?tab=pets&ghost=${encodeURIComponent(id)}`); }} options={[...snapshot.profiles.map(p => ({ value: p.id, label: p.name })), ...(!profile ? [{ value: '__empty__', label: '아직 Ghost가 없습니다' }] : [])]}/>}</FormField><Button type="button" disabled={busy} onClick={() => setImporting(true)}><FolderInput size={16}/>Codex 펫 가져오기</Button></div>
    <div className="grid min-h-[226px] grid-cols-[48%_minmax(0,1fr)] items-center gap-5 rounded-xl bg-inset px-5 py-3 max-[760px]:grid-cols-[42%_minmax(0,1fr)] max-[760px]:gap-2.5 max-[760px]:p-2.5"><div className="flex min-h-[204px] items-center justify-center text-ink-3">{selectedId === null ? <GhostCharacter size={146} state={motion} animate={animate} className="max-[480px]:max-w-full"/> : source && <PetSprite source={source} version={selected?.sprite_version ?? 2} state={motion} size={146} animate={animate} follow/>}{imageError && <Button variant="outline" type="button" onClick={retry}><RefreshCw size={15}/>다시 불러오기</Button>}</div><div className="flex min-w-0 flex-col items-start gap-2.5 py-2.5"><h3 className="m-0 text-body font-semibold text-ink [overflow-wrap:anywhere]">{selected?.name ?? '기본 Ghost'}</h3>{selected?.description && <p className="m-0 text-caption text-ink-2 [overflow-wrap:anywhere]">{selected.description}</p>}<div className="flex flex-wrap items-center gap-2 text-caption text-ink-2"><span>동작</span><SelectField className="w-auto max-w-[160px]" label="동작" value={motion} onValueChange={value => setMotion(value as PetState)} options={STATES.filter(s => selectedId !== null || ['idle', 'running'].includes(s.key)).map(s => ({ value: s.key, label: s.label }))}/></div><Button type="button" className="mt-1" disabled={busy || !profile || (profile.avatar_id ?? null) === selectedId || (selectedId !== null && !source)} onClick={() => void run(() => assign(selectedId))}>{(profile?.avatar_id ?? null) === selectedId ? <><Check size={15}/>사용 중</> : `${profile?.name ?? 'Ghost'}에 적용`}</Button></div></div>
    {selectedId === null && <GhostColorPicker value={color} onChange={onColor}/>}
    <div role="group" aria-label="아바타 선택" className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(112px,1fr))]"><button type="button" aria-pressed={selectedId === null} onClick={() => { setSelectedId(null); setMotion('idle'); setNotice(''); }} className="relative flex min-h-[125px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-line p-2.5 text-caption text-ink outline-none hover:bg-hover focus-visible:ring-[2px] focus-visible:ring-ring/40 aria-pressed:border-ink aria-pressed:bg-hover"><DotAvatar tone={profile ? toneFor(profile.id) : 'mint'} size={72}/><span className="max-w-full truncate">기본 Ghost</span>{selectedId === null && <Check size={14} className="absolute right-2 top-2"/>}</button>{snapshot.avatars.map(avatar => <AvatarChoice key={avatar.id} avatar={avatar} selected={selectedId === avatar.id} onSelect={() => { setSelectedId(avatar.id); setNotice(''); }}/>)}</div>
    <div className="flex flex-wrap items-center gap-4"><Button variant="ghost" type="button" disabled={!selected || !source} onClick={() => { if (source) { try { downloadPet(selected?.name ?? profile?.name ?? 'Ghost', selected?.description ?? '', selected?.sprite_version ?? 2, source); setNotice('Codex용 ZIP을 내보냈습니다.'); } catch (e) { setError(String(e)); } } }}><Download size={15}/>Codex용 내보내기</Button>{selected?.design && <Button variant="ghost" type="button" disabled={busy} onClick={() => setEditor(selected)}><Copy size={15}/>복사해서 수정</Button>}{selected && <Button variant="ghost" type="button" className="ml-auto" disabled={busy || inUse.length > 0} title={inUse.length ? `${inUse.map(p => p.name).join(', ')}에서 사용 중` : '보관함에서 삭제'} onClick={() => setRemove(true)}><Trash2 size={15}/>삭제</Button>}</div>
    {inUse.length > 0 && <p className="m-0 text-caption text-ink-3">{inUse.map(p => p.name).join(', ')}에서 사용 중</p>}
    {(error || imageError) && <InlineError>{error || imageError}</InlineError>}{notice && <p className="m-0 text-caption text-success" role="status">{notice}</p>}
    <section className="flex min-w-0 flex-col gap-3 border-t border-line pt-4 text-caption leading-relaxed text-ink-2"><h3 className="m-0 text-ui font-semibold text-ink">직접 만들기와 내보내기</h3><Button variant="outline" type="button" className="w-fit" disabled={busy} onClick={() => setEditor(true)}><Plus size={15}/>아바타 만들기</Button><p className="m-0 [overflow-wrap:anywhere]">내보낸 ZIP의 압축을 풀고, 폴더 전체를 Codex의 펫 폴더에 넣으세요. 기본 위치는 <code className="text-caption">~/.codex/pets/</code>입니다. Codex의 설정 → 펫에서 펫 폴더를 열면 현재 사용하는 위치를 확인할 수 있습니다.</p><p className="m-0 [overflow-wrap:anywhere]">폴더 안의 <code className="text-caption">pet.json</code>과 <code className="text-caption">spritesheet.png</code> 또는 <code className="text-caption">spritesheet.webp</code>를 함께 유지하세요. 새로 만든 아바타는 Codex 펫 v2(9가지 동작·16방향 시선)로 내보냅니다. Codex 계정 보관함과 자동 동기화되지는 않습니다.</p></section>
    {importing && <CodexPetImport animate={animate} busy={busy} onClose={() => setImporting(false)} onSave={save}/>}
    {editor && <PetEditor name={profile?.name ?? '새 Ghost'} seed={editor === true ? undefined : editor} animate={animate} busy={busy} onClose={() => setEditor(null)} onSave={save}/>}
    {remove && selected && <Modal title="아바타 삭제" onClose={() => !busy && setRemove(false)}><div className="flex flex-col gap-4"><p className="m-0">{selected.name}를 보관함에서 삭제할까요?</p>{error && <InlineError>{error}</InlineError>}<div className="flex justify-end gap-2"><Button variant="outline" type="button" disabled={busy} onClick={() => setRemove(false)}>취소</Button><Button variant="destructive" type="button" disabled={busy} onClick={() => void run(async () => { await action({ type: 'workspace', action: { type: 'delete_avatar', id: selected.id } }); setSelectedId(null); setRemove(false); setNotice('아바타를 삭제했습니다.'); })}>삭제</Button></div></div></Modal>}
  </section>;
}
function AvatarChoice({ avatar, selected, onSelect }: { avatar: Avatar; selected: boolean; onSelect: () => void }) {
  const { source, animate } = useAvatarSource(avatar.id);
  return <button type="button" aria-pressed={selected} onClick={onSelect} className="relative flex min-h-[125px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-line p-2.5 text-caption text-ink outline-none hover:bg-hover focus-visible:ring-[2px] focus-visible:ring-ring/40 aria-pressed:border-ink aria-pressed:bg-hover">{source ? <PetSprite source={source} version={avatar.sprite_version} size={72} animate={animate}/> : <span className="h-[78px] w-[72px] rounded-lg bg-inset"/>}<span className="max-w-full truncate">{avatar.name}</span>{selected && <Check size={14} className="absolute right-2 top-2"/>}</button>;
}
