import { useState, type CSSProperties } from 'react';
import { Folder, Home, Layers, MessageCircle } from 'lucide-react';
import { DotAvatar, type PortraitAppearance } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { useProfileAvatar } from '../pets/AvatarProvider';
import { GhostColorPicker } from '../pets/GhostColorPicker';
import { toneFor, type Profile } from '../client/types';
import { portraitColors, uploadPackage, type PackageInfo } from './PackageWorkspace';

export function PackageImport({ workspace, profiles, selected, onClose, onInstalled }: {
  workspace: string; profiles: Profile[]; selected: string;
  onClose(): void; onInstalled(profile: string): void;
}) {
  const [file, setFile] = useState<File>();
  const [info, setInfo] = useState<PackageInfo>();
  const [profile, setProfile] = useState(selected);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="패키지 추가" onClose={() => { if (!busy) onClose(); }}>
    <form className="form-stack" onSubmit={async event => {
      event.preventDefault();
      if (!file || !info || !profile || busy) return;
      setBusy(true);
      setError('');
      try { await uploadPackage(file, { workspace, profile, digest: info.digest }); onInstalled(profile); }
      catch (failure) { setError((failure as Error).message); setBusy(false); }
    }}>
      <label>.ghost 파일<input type="file" accept=".ghost,application/zip" disabled={busy} onChange={async event => {
        const next = event.currentTarget.files?.[0];
        setFile(next); setInfo(undefined); setError('');
        if (!next) return;
        setBusy(true);
        try { setInfo(await uploadPackage(next)); }
        catch (failure) { setError((failure as Error).message); }
        finally { setBusy(false); }
      }}/></label>
      {info && <>
        <div><strong>{info.name}</strong><p className="muted">{info.id} · {info.version}</p></div>
        <p>{info.ui?.views.map(view => view.label).join(' · ') || '기본 대화'}</p>
        <label>연결할 Ghost<select value={profile} onChange={e => setProfile(e.target.value)} disabled={busy}>
          {profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
      </>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <button type="submit" className="button primary" disabled={busy || !info || !profile}>패키지 연결</button>
    </form>
  </Modal>;
}

const boldColors = [
  { name: '빨강', color: '#e92b37' }, { name: '주황', color: '#ff7a18' }, { name: '노랑', color: '#ffd600' },
  { name: '초록', color: '#008a45' }, { name: '파랑', color: '#0058ef' }, { name: '보라', color: '#7135db' },
];
const neutralColors = [{ name: '검정', color: '#191919' }, { name: '흰색', color: '#ffffff' }];
const bodyColors = [...neutralColors, ...boldColors];
const backgroundColors = [
  ...boldColors,
  { name: '하늘', color: portraitColors.sky }, { name: '민트', color: portraitColors.mint },
  { name: '라일락', color: portraitColors.lilac }, { name: '복숭아', color: portraitColors.peach },
  { name: '모래', color: portraitColors.sand }, { name: '슬레이트', color: portraitColors.slate },
  ...neutralColors,
];

export function PortraitPicker({ profile, appearance, choices, defaults, onSelect, onClose }: {
  profile: Profile; appearance?: PortraitAppearance; choices: PortraitAppearance; defaults: Required<PortraitAppearance>;
  onSelect(part: keyof PortraitAppearance, color?: string): void; onClose(): void;
}) {
  const { isDefault } = useProfileAvatar(profile.id);
  return <Modal title="초상화 색상" className="portrait-modal" focusClose onClose={onClose}>
    <div className="portrait-picker">
      <div className="portrait-preview">
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={96}/>
        <span>{profile.name}</span>
      </div>
      {isDefault && <GhostColorPicker label="본체 색" resetLabel="자동" presets={bodyColors} value={choices.body ?? 'auto'}
        fallback={appearance?.body ?? defaults.body} onChange={color => onSelect('body', color === 'auto' ? undefined : color)}/>}
      <GhostColorPicker label="배경색" resetLabel="기본" presets={backgroundColors} value={choices.background ?? 'auto'}
        fallback={appearance?.background ?? defaults.background} onChange={color => onSelect('background', color === 'auto' ? undefined : color)}/>
    </div>
  </Modal>;
}

export function MobilePrimaryTabs({ canChat, hasViews, active, onNavigate, onChat, onWorkspace }: {
  canChat: boolean; hasViews: boolean; active: 'home' | 'chat' | 'projects' | 'workspace' | undefined;
  onNavigate(path: string): void; onChat(): void; onWorkspace(): void;
}) {
  const count = 3 + Number(hasViews);
  const activeIndex = active === 'home' ? 0 : active === 'chat' ? 1 : active === 'projects' ? 2 : 3;
  const style = { '--mobile-tab-count': count, '--mobile-tab-active': activeIndex } as CSSProperties;
  return <nav className="mobile-primary-tabs" style={style} data-active={Boolean(active)} aria-label="기본 메뉴">
    <button aria-current={active === 'home' ? 'page' : undefined} onClick={() => onNavigate('/')}><Home size={18}/><span>홈</span></button>
    <button aria-current={active === 'chat' ? 'page' : undefined} disabled={!canChat} onClick={onChat}><MessageCircle size={18}/><span>대화</span></button>
    <button aria-current={active === 'projects' ? 'page' : undefined} onClick={() => onNavigate('/spaces')}><Folder size={18}/><span>프로젝트</span></button>
    {hasViews && <button aria-current={active === 'workspace' ? 'page' : undefined} onClick={onWorkspace}><Layers size={18}/><span>작업실</span></button>}
  </nav>;
}
