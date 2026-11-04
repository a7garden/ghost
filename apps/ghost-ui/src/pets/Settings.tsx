import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, Download, Monitor, Moon, Palette, PawPrint, Plug, Plus, Sun, Trash2, RefreshCw, FolderInput, Cpu } from 'lucide-react';
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
export function Settings({ snapshot, route, navigate, action, busy, mode, preferences, updatePreferences, storageError, connected = true }: { snapshot: Snapshot; route: string; navigate: (path: string) => void; action: Action; busy: boolean; mode: 'demo' | 'live'; preferences: Preferences; updatePreferences: (p: Partial<Preferences>) => void; storageError: string; connected?: boolean }) {
  const params = new URLSearchParams(route.split('?')[1]);
  const tab = params.get('tab') ?? 'pets';
  const profileId = params.get('ghost') ?? snapshot.profiles[0]?.id ?? '';
  const profile = snapshot.profiles.find(p => p.id === profileId) ?? snapshot.profiles[0];
  const changeTab = (next: string) => navigate(`/settings?tab=${next}${profile ? `&ghost=${encodeURIComponent(profile.id)}` : ''}`);
  return <div className="settings-page"><div className="settings-page-heading"><button className="icon-button" aria-label="작업실로 돌아가기" onClick={() => navigate(profile ? `/ghosts/${profile.id}` : '/')}><ArrowLeft size={18}/></button><h1>설정</h1></div><div className="settings-layout"><nav className="settings-nav" aria-label="설정 항목">{[{ id: 'appearance', label: '화면', icon: Palette }, { id: 'pets', label: '아바타', icon: PawPrint }, { id: 'models', label: '모델', icon: Cpu }, { id: 'connections', label: '연결', icon: Plug }].map(item => <button key={item.id} className={`nav-row ${tab === item.id ? 'selected' : ''}`} aria-current={tab === item.id ? 'page' : undefined} onClick={() => changeTab(item.id)}><item.icon size={17}/>{item.label}</button>)}</nav><div className={`settings-content ${tab === 'appearance' ? 'settings-content--appearance' : ''}`}>
    {storageError && <p className="form-error" role="alert">{storageError}</p>}
    {tab === 'appearance' && <><h2 className="sr-only">화면</h2><div className="setting-row"><div><strong>테마</strong></div><div className="theme-options">{[{ key: 'system', label: '시스템', Icon: Monitor }, { key: 'light', label: '밝게', Icon: Sun }, { key: 'dark', label: '어둡게', Icon: Moon }].map(v => <button key={v.key} aria-pressed={preferences.theme === v.key} onClick={() => updatePreferences({ theme: v.key as Preferences['theme'] })}><v.Icon size={17}/>{v.label}</button>)}</div></div><Toggle title="아바타 애니메이션" description="작업 중에 움직입니다. 시스템의 동작 줄이기 설정을 따릅니다." checked={preferences.animate} onChange={animate => updatePreferences({ animate })}/><p className="settings-footnote">표시 설정은 이 브라우저에 저장됩니다.</p></>}
    {tab === 'connections' && <><h2>연결</h2><div className="setting-row"><div><strong>Ghost 호스트</strong><p>{mode === 'live' ? 'Ghost와 아바타를 연결된 로컬 호스트에 저장합니다.' : '예시 작업실입니다. 아바타와 변경 사항은 이 브라우저에 저장됩니다.'}</p></div><span className="mode-badge">{mode === 'live' ? connected ? '호스트 연결됨' : '연결 확인 필요' : '예시 모드'}</span></div><div className="setting-row"><div><strong>외부 도구와 앱</strong><p>Ghost가 사용할 MCP 연결과 권한을 관리합니다.</p></div><button className="button secondary" onClick={() => navigate('/integrations')}>연동 관리</button></div></>}
    {tab === 'models' && <ModelSettings snapshot={snapshot} action={action} busy={busy} mode={mode} connected={connected}/>}
    {tab === 'pets' && <><h2>아바타</h2>
      <PetLibrary key={profile?.id ?? 'empty'} snapshot={snapshot} profileId={profile?.id} action={action} busy={busy} navigate={navigate} animate={preferences.animate} color={preferences.ghostColor} onColor={ghostColor => updatePreferences({ ghostColor })}/>
      <Toggle title="작업실에 펫 표시" description="펫을 누르면 선택한 Ghost와의 대화가 열립니다." checked={preferences.companion} onChange={companion => updatePreferences({ companion })}/>{preferences.companion && <label className="setting-row companion-choice"><span>표시할 Ghost</span><select aria-label="표시할 Ghost" value={snapshot.profiles.some(p => p.id === preferences.companionProfile) ? preferences.companionProfile : snapshot.profiles[0]?.id ?? ''} onChange={e => updatePreferences({ companionProfile: e.target.value })}>{snapshot.profiles.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>}
    </>}

  </div></div></div>;
}
function Toggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div><button type="button" className="setting-switch" role="switch" aria-label={title} aria-checked={checked} onClick={() => onChange(!checked)}><span/></button></div>;
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
  return <section className="pet-library" aria-label="아바타 보관함"><div className="pet-library-heading"><label>아바타를 바꿀 Ghost<select aria-label="아바타를 바꿀 Ghost" value={profile?.id ?? ''} disabled={busy || !profile} onChange={e => navigate(`/settings?tab=pets&ghost=${encodeURIComponent(e.target.value)}`)}>{snapshot.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}{!profile && <option value="">아직 Ghost가 없습니다</option>}</select></label><button className="button primary" disabled={busy} onClick={() => setImporting(true)}><FolderInput size={16}/>Codex 펫 가져오기</button></div>
    <div className="pet-selected-preview"><div className="pet-preview-stage">{selectedId === null ? <GhostCharacter size={146} state={motion} animate={animate}/> : source && <PetSprite source={source} version={selected?.sprite_version ?? 2} state={motion} size={146} animate={animate} follow/>}{imageError && <button className="button secondary" onClick={retry}><RefreshCw size={15}/>다시 불러오기</button>}</div><div className="pet-preview-copy"><h3>{selected?.name ?? '기본 Ghost'}</h3>{selected?.description && <p>{selected.description}</p>}<label className="pet-motion-picker">동작<select value={motion} onChange={e => setMotion(e.target.value as PetState)}>{STATES.filter(s => selectedId !== null || ['idle', 'running'].includes(s.key)).map(s => <option value={s.key} key={s.key}>{s.label}</option>)}</select></label><button className="button primary" disabled={busy || !profile || (profile.avatar_id ?? null) === selectedId || (selectedId !== null && !source)} onClick={() => void run(() => assign(selectedId))}>{(profile?.avatar_id ?? null) === selectedId ? <><Check size={15}/>사용 중</> : `${profile?.name ?? 'Ghost'}에 적용`}</button></div></div>
    {selectedId === null && <GhostColorPicker value={color} onChange={onColor}/>}
    <div className="pet-grid" aria-label="아바타 선택"><button className={`pet-choice ${selectedId === null ? 'selected' : ''}`} aria-pressed={selectedId === null} onClick={() => { setSelectedId(null); setMotion('idle'); setNotice(''); }}><DotAvatar tone={profile ? toneFor(profile.id) : 'mint'} size={72}/><span>기본 Ghost</span>{selectedId === null && <Check size={14}/>}</button>{snapshot.avatars.map(avatar => <AvatarChoice key={avatar.id} avatar={avatar} selected={selectedId === avatar.id} onSelect={() => { setSelectedId(avatar.id); setNotice(''); }}/>)}</div>
    <div className="pet-library-actions"><button className="text-button" disabled={!selected || !source} onClick={() => { if (source) { try { downloadPet(selected?.name ?? profile?.name ?? 'Ghost', selected?.description ?? '', selected?.sprite_version ?? 2, source); setNotice('Codex용 ZIP을 내보냈습니다.'); } catch (e) { setError(String(e)); } } }}><Download size={15}/>Codex용 내보내기</button>{selected?.design && <button className="text-button" disabled={busy} onClick={() => setEditor(selected)}><Copy size={15}/>복사해서 수정</button>}{selected && <button className="text-button pet-delete" disabled={busy || inUse.length > 0} title={inUse.length ? `${inUse.map(p => p.name).join(', ')}에서 사용 중` : '보관함에서 삭제'} onClick={() => setRemove(true)}><Trash2 size={15}/>삭제</button>}</div>
    {inUse.length > 0 && <p className="field-help">{inUse.map(p => p.name).join(', ')}에서 사용 중</p>}
    {(error || imageError) && <p className="form-error" role="alert">{error || imageError}</p>}{notice && <p className="pet-notice" role="status">{notice}</p>}
    <details className="pet-compatibility"><summary>직접 만들기와 내보내기</summary><button className="button secondary" disabled={busy} onClick={() => setEditor(true)}><Plus size={15}/>아바타 만들기</button><p>내보낸 ZIP의 압축을 풀고, 폴더 전체를 Codex의 펫 폴더에 넣으세요. 기본 위치는 <code>~/.codex/pets/</code>입니다. Codex의 설정 → 펫에서 펫 폴더를 열면 현재 사용하는 위치를 확인할 수 있습니다.</p><p>폴더 안의 <code>pet.json</code>과 <code>spritesheet.png</code> 또는 <code>spritesheet.webp</code>를 함께 유지하세요. 새로 만든 아바타는 Codex 펫 v2(9가지 동작·16방향 시선)로 내보냅니다. Codex 계정 보관함과 자동 동기화되지는 않습니다.</p></details>
    {importing && <CodexPetImport animate={animate} busy={busy} onClose={() => setImporting(false)} onSave={save}/>}
    {editor && <PetEditor name={profile?.name ?? '새 Ghost'} seed={editor === true ? undefined : editor} animate={animate} busy={busy} onClose={() => setEditor(null)} onSave={save}/>}
    {remove && selected && <Modal title="아바타 삭제" onClose={() => !busy && setRemove(false)}><div className="form-stack"><p>{selected.name}를 보관함에서 삭제할까요?</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => setRemove(false)}>취소</button><button className="button primary" disabled={busy} onClick={() => void run(async () => { await action({ type: 'workspace', action: { type: 'delete_avatar', id: selected.id } }); setSelectedId(null); setRemove(false); setNotice('아바타를 삭제했습니다.'); })}>삭제</button></div></div></Modal>}
  </section>;
}
function AvatarChoice({ avatar, selected, onSelect }: { avatar: Avatar; selected: boolean; onSelect: () => void }) {
  const { source, animate } = useAvatarSource(avatar.id);
  return <button className={`pet-choice ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onSelect}>{source ? <PetSprite source={source} version={avatar.sprite_version} size={72} animate={animate}/> : <span className="pet-choice-placeholder"/>}<span>{avatar.name}</span>{selected && <Check size={14}/>}</button>;
}
