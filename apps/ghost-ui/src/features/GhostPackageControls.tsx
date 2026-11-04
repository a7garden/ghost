import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, Check, ChevronDown, Home, Inbox, Layers, LayoutList, MessageCircle, PackagePlus, Palette, Plus } from 'lucide-react';
import { DotAvatar, GhostMark, type PortraitAppearance } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { useProfileAvatar } from '../pets/AvatarProvider';
import { GhostColorPicker } from '../pets/GhostColorPicker';
import { toneFor, type Profile } from '../client/types';
import { portraitColors, uploadPackage, type PackageInfo } from './PackageWorkspace';

export function GhostSwitcher({ profiles, selected, defaultGhostId, onSelect, onAdd, onImport, onPortrait }: {
  profiles: Profile[]; selected?: Profile; defaultGhostId?: string | null; onSelect(id: string): void;
  onAdd(): void; onImport(): void; onPortrait(): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openingKey = useRef<'current' | 'last' | null>(null);
  const menu = useId();
  useEffect(() => {
    if (!open) return;
    if (openingKey.current) {
      const items = menuRef.current?.querySelectorAll('button');
      const first = menuRef.current?.querySelector<HTMLButtonElement>('[aria-current]') ?? items?.[0];
      (openingKey.current === 'last' ? items?.[items.length - 1] : first)?.focus();
      openingKey.current = null;
    }
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  const close = () => { trigger.current?.focus(); setOpen(false); };
  const choose = (fn: () => void) => { close(); fn(); };
  return <div ref={root} className="ghost-switcher" data-tauri-drag-region="false"
    onBlur={e => { if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    onKeyDown={e => {
      if (open && e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        openingKey.current = e.key === 'ArrowUp' ? 'last' : 'current';
        setOpen(true);
        return;
      }
      const items = Array.from(menuRef.current?.querySelectorAll('button') ?? []);
      if (!items.length) return;
      e.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : index === -1 ? (e.key === 'ArrowUp' ? items.length - 1 : 0)
        : (index + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }}>
    <button ref={trigger} className="ghost-switcher-trigger" aria-label={selected ? `Ghost 전환 · ${selected.name}` : 'Ghost 전환'}
      aria-expanded={open} aria-controls={open ? menu : undefined} onClick={e => {
        if (!open && e.detail === 0) openingKey.current = 'current';
        setOpen(!open);
      }}>
      <span key={selected?.id ?? 'default'} className="ghost-switcher-identity">
        {selected ? <DotAvatar profileId={selected.id} tone={toneFor(selected.id)} size={28}/> : <GhostMark/>}
        <span>{selected?.name ?? 'Ghost'}</span>
        {selected && selected.id === defaultGhostId && <span className="ghost-default-badge">기본</span>}
      </span>
      <ChevronDown className="ghost-switcher-chevron" size={14}/>
    </button>
    {open && <div ref={menuRef} className="ghost-switcher-menu" id={menu}>
      <div className="ghost-switcher-list">{profiles.map(profile =>
        <button key={profile.id} className="nav-row" aria-current={selected?.id === profile.id ? 'true' : undefined} onClick={() => choose(() => onSelect(profile.id))}>
          <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={24}/><span>{profile.name}</span>
          {profile.id === defaultGhostId && <span className="ghost-default-badge">기본</span>}
          {selected?.id === profile.id && <Check className="ghost-switcher-check" size={14} aria-hidden="true"/>}
        </button>)}</div>
      <div className="ghost-switcher-actions">
        {selected && <button className="nav-row" onClick={() => choose(onPortrait)}><Palette size={16}/>초상화 색상</button>}
        <button className="nav-row" onClick={() => choose(onImport)}><PackagePlus size={16}/>패키지 추가…</button>
        <button className="nav-row" onClick={() => choose(onAdd)}><Plus size={16}/>새 Ghost 만들기</button>
      </div>
    </div>}
  </div>;
}

export function GhostDirectory({ profiles, defaultGhostId, onOpen, onAdd }: {
  profiles: Profile[]; defaultGhostId?: string | null; onOpen(id: string): void; onAdd(): void;
}) {
  return <div className="page-content ghost-directory">
    <div className="page-heading"><h1>Ghosts</h1><button className="button primary" onClick={onAdd}><Plus size={15}/>새 Ghost</button></div>
    {profiles.length === 0 ? <section className="empty-state large-empty"><GhostMark/><h2>아직 Ghost가 없습니다</h2><button className="button primary" onClick={onAdd}>새 Ghost 만들기<Plus size={15}/></button></section>
      : <div className="ghost-directory-list" aria-label="Ghost 목록">{profiles.map(profile => <article className="ghost-directory-row" key={profile.id}>
        <div className="ghost-directory-identity"><DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={42}/>
          <span><strong>{profile.name}{profile.id === defaultGhostId && <span className="ghost-default-badge">기본</span>}</strong><small>{profile.persona}</small></span>
        </div>
        <button className="button secondary" aria-label={`${profile.name} 대화 열기`} onClick={() => onOpen(profile.id)}>대화 열기<ArrowRight size={14}/></button>
      </article>)}</div>}
  </div>;
}

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

export function MobilePrimaryTabs({ selectedGhostId, hasViews, active, workPath, onNavigate, onChat, onWorkspace }: {
  selectedGhostId?: string; hasViews: boolean; active: 'home' | 'chat' | 'work' | 'inbox' | 'workspace' | undefined;
  workPath: string;
  onNavigate(path: string): void; onChat(): void; onWorkspace(): void;
}) {
  const count = 4 + Number(hasViews);
  const activeIndex = active === 'home' ? 0 : active === 'chat' ? 1 : active === 'work' ? 2 : active === 'inbox' ? 3 : 4;
  const style = { '--mobile-tab-count': count, '--mobile-tab-active': activeIndex } as CSSProperties;
  return <nav className="mobile-primary-tabs" style={style} data-active={Boolean(active)} aria-label="기본 메뉴">
    <button aria-current={active === 'home' ? 'page' : undefined} onClick={() => onNavigate('/')}><Home size={18}/><span>홈</span></button>
    <button aria-current={active === 'chat' ? 'page' : undefined} disabled={!selectedGhostId} onClick={onChat}><MessageCircle size={18}/><span>대화</span></button>
    <button aria-current={active === 'work' ? 'page' : undefined} onClick={() => onNavigate(workPath)}><LayoutList size={18}/><span>작업</span></button>
    <button aria-current={active === 'inbox' ? 'page' : undefined} onClick={() => onNavigate('/inbox')}><Inbox size={18}/><span>확인</span></button>
    {hasViews && <button aria-current={active === 'workspace' ? 'page' : undefined} onClick={onWorkspace}><Layers size={18}/><span>작업실</span></button>}
  </nav>;
}
