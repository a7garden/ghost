import { createContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Ellipsis, Home, Inbox, Menu, MessageCircle, PanelLeft, PanelsTopLeft, Search, Settings, Bot } from 'lucide-react';
import { CommandPalette, Dialog, DialogContent, DialogTitle, Popover, PopoverContent, PopoverTrigger, TitleBar, type CommandItem } from '../ui';
import { useCompact } from '../ui/adaptive';
import { routeLabels } from '../uiText';
import { shortcut } from '../ui/keys';

export const CompactTitleSlot = createContext<HTMLDivElement | null>(null);
const SIDEBAR_KEY = 'ghost.sidebar';
const NARROW_QUERY = '(max-width: 1099.98px)';
function subscribeNarrow(listener: () => void) {
  const media = matchMedia(NARROW_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

/**
 * The window: a quiet sidebar on the page tone, the destination on an inset sheet,
 * and a title bar that carries location, the activity island and command search.
 */
export function AppFrame({ desktop, macOSInset, location, island, duty, callTray, sidebar, fill, commands, paletteOpen, onPaletteOpenChange, section, attentionCount, navigate, hideDock, children }: {
  /** Inside the Tauri window: draw the draggable title bar above everything. */
  desktop: boolean;
  macOSInset: number;
  /** Where the owner is: back/forward and the page's trail. */
  location: ReactNode;
  /** Live activity across Ghosts; renders nothing while the workspace is quiet. */
  island: ReactNode;
  /** 출근 · 퇴근 원버튼. */
  duty?: ReactNode;
  callTray?: ReactNode;
  sidebar: ReactNode;
  /** The page owns its height and scrolling (conversations, settings). */
  fill: boolean;
  commands: CommandItem[];
  paletteOpen: boolean;
  onPaletteOpenChange(open: boolean): void;
  section: string;
  attentionCount: number;
  navigate(path: string): void;
  hideDock: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = useCompact();
  const focusedCoding = compact && section === 'coding' && hideDock;
  const focusedChat = compact && section === 'ghosts';
  const [titleSlot, setTitleSlot] = useState<HTMLDivElement | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const narrow = useSyncExternalStore(subscribeNarrow, () => matchMedia(NARROW_QUERY).matches, () => false);
  const [preference, setPreference] = useState<'shown' | 'hidden' | null>(() => {
    try { const stored = localStorage.getItem(SIDEBAR_KEY); return stored === 'hidden' || stored === 'shown' ? stored : null; } catch { return null; }
  });
  // Without an explicit choice the coding workbench, which brings its own rail, folds the app sidebar on narrow windows.
  const sidebarHidden = preference ? preference === 'hidden' : section === 'coding' && !compact && narrow;
  const hiddenNow = useRef(sidebarHidden);
  hiddenNow.current = sidebarHidden;
  const toggleSidebar = () => {
    const next = hiddenNow.current ? 'shown' : 'hidden';
    try { localStorage.setItem(SIDEBAR_KEY, next); } catch { /* The choice still holds for this visit. */ }
    setPreference(next);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key !== '\\') return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const search = <button type="button" className="shell-search" aria-label="명령 검색" title={`명령 검색 · ${shortcut('K')}`} onClick={() => onPaletteOpenChange(true)}>
    <Search aria-hidden="true"/><span className="shell-search__label">검색</span><kbd>{shortcut('K')}</kbd>
  </button>;
  // 2026.11.11 : 탭 다섯 개(홈 · 확인할 일 · 맡긴 일 · 작업실 · 설정)가 많다는 의견으로 셋으로 줄였다.
  // 맡긴 일은 홈의 「진행 중」 · 「맡긴 일 전체」에서, 설정은 위쪽 톱니에서 연다. 하위 화면은 자기 갈래의 탭을 켠다.
  const destinations = [
    { id: 'home', path: '/', label: routeLabels.home, icon: Home, sections: ['home', 'work', 'goals'] },
    { id: 'conversations', path: '/conversations', label: routeLabels.conversations, icon: MessageCircle, sections: ['conversations', 'workspace', 'ghosts', 'scopes'] },
    { id: 'inbox', path: '/inbox', label: routeLabels.inbox, icon: Inbox, sections: ['inbox'] },
    { id: 'coding', path: '/coding', label: routeLabels.coding, icon: Bot, sections: ['coding'] },
  ];
  const settings = !desktop && <button type="button" className="shell-icon-button min-[56rem]:hidden" aria-label={routeLabels.settings} title={routeLabels.settings}
    aria-current={section === 'settings' ? 'page' : undefined} onClick={() => navigate('/settings')}><Settings aria-hidden="true"/></button>;
  const right = <span className="flex items-center gap-2">{duty}{search}{settings}</span>;
  const sidebarToggle = <button type="button" className="shell-icon-button max-[56rem]:hidden" aria-label={sidebarHidden ? '사이드바 펼치기' : '사이드바 접기'}
    aria-expanded={!sidebarHidden} title={`${sidebarHidden ? '사이드바 펼치기' : '사이드바 접기'} · ${shortcut('\\')}`} onClick={toggleSidebar}><PanelLeft aria-hidden="true"/></button>;
  const left = <>{desktop && <button type="button" className="shell-icon-button min-[56rem]:hidden" aria-label="전체 메뉴" onClick={() => setMenuOpen(true)}><Menu aria-hidden="true"/></button>}{sidebarToggle}{location}</>;
  return <div className="shell" data-fill={fill || undefined}>
    {desktop
      ? <TitleBar aria-label="Ghost" macOSInset={macOSInset} left={left} center={island} right={right}/>
      : <header className="ghost-titlebar shell-header" data-focused-coding={focusedCoding || undefined} data-focused-chat={focusedChat || undefined}>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--left">{left}</div>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--center">{focusedChat ? <div ref={setTitleSlot} className="chat-title-tools"/> : island}</div>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--right">{focusedCoding || focusedChat
          ? <Popover open={toolsOpen} onOpenChange={setToolsOpen}>
            <PopoverTrigger asChild><button type="button" className="shell-icon-button" aria-label="작업실 메뉴"><Ellipsis aria-hidden="true"/></button></PopoverTrigger>
            <PopoverContent aria-label="작업실 메뉴" className="coding-shell-menu">
              {focusedChat && island}
              {duty}
              {focusedChat && <button type="button" onClick={() => { setToolsOpen(false); navigate('/workspace'); }}><PanelsTopLeft/>작업실</button>}
              <button type="button" onClick={() => { setToolsOpen(false); onPaletteOpenChange(true); }}><Search/>명령 검색</button>
              <button type="button" onClick={() => { setToolsOpen(false); navigate('/settings'); }}><Settings/>설정</button>
            </PopoverContent>
          </Popover> : right}</div>
      </header>}
    {callTray}
    <div className="shell-body" data-sidebar={sidebarHidden ? 'hidden' : undefined}>
      <aside className="shell-sidebar" aria-label="작업실 탐색">{sidebar}</aside>
      <main id="main-content" tabIndex={-1} className="shell-sheet" data-fill={fill || undefined}>
        <CompactTitleSlot.Provider value={titleSlot}>{children}</CompactTitleSlot.Provider>
      </main>
    </div>
    {!desktop && <nav className="compact-dock" aria-label="주요 화면" data-hidden={hideDock || undefined}>
      {destinations.map(item => <button key={item.id} type="button" aria-current={item.sections.includes(section) ? 'page' : undefined} onClick={() => navigate(item.path)}>
        <span className="compact-dock__icon">
          <item.icon size={21} aria-hidden="true"/>
          {item.id === 'inbox' && attentionCount > 0 && <span className="compact-dock__badge">{attentionCount}<span className="sr-only">개 확인 요청</span></span>}
        </span>
        <span>{item.label}</span>
      </button>)}
    </nav>}
    {desktop && <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
      <DialogContent closeLabel="닫기" aria-describedby={undefined} className="shell-menu max-h-[86dvh] w-[min(340px,calc(100vw-24px))] p-0"
        onClick={event => { if ((event.target as Element).closest('button[aria-current], .ghost-navigation-item, .presence-row__main')) setMenuOpen(false); }}>
        <DialogTitle className="sr-only">전체 메뉴</DialogTitle>
        <div className="flex max-h-[86dvh] flex-col">{sidebar}</div>
      </DialogContent>
    </Dialog>}
    <CommandPalette items={commands} open={paletteOpen} onOpenChange={onPaletteOpenChange}
      strings={{ ariaLabel: '명령', searchPlaceholder: 'Ghost, 화면, 맡긴 일, 확인할 일 검색…', emptyTitle: '일치하는 항목이 없습니다', emptyHint: '다른 이름이나 단어로 검색해 주세요.', closeLabel: '닫기' }}/>
  </div>;
}
