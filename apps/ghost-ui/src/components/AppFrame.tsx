import { useState, type ReactNode } from 'react';
import { BriefcaseBusiness, Home, Inbox, Menu, PanelsTopLeft, Search, Settings } from 'lucide-react';
import { CommandPalette, Dialog, DialogContent, DialogTitle, TitleBar, type CommandItem } from '../ui'
import { routeLabels } from '../uiText';
import { shortcut } from '../ui/keys';

/**
 * The window: a quiet sidebar on the page tone, the destination on an inset sheet,
 * and a title bar that carries location, the activity island and command search.
 */
export function AppFrame({ desktop, macOSInset, location, island, duty, sidebar, fill, commands, paletteOpen, onPaletteOpenChange, section, attentionCount, navigate, hideDock, children }: {
  /** Inside the Tauri window: draw the draggable title bar above everything. */
  desktop: boolean;
  macOSInset: number;
  /** Where the owner is: back/forward and the page's trail. */
  location: ReactNode;
  /** Live activity across Ghosts; renders nothing while the workspace is quiet. */
  island: ReactNode;
  /** 출근 · 퇴근 원버튼. */
  duty?: ReactNode;
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
  const search = <button type="button" className="shell-search" aria-label="명령 검색" title={`명령 검색 · ${shortcut('K')}`} onClick={() => onPaletteOpenChange(true)}>
    <Search aria-hidden="true"/><span className="shell-search__label">검색</span><kbd>{shortcut('K')}</kbd>
  </button>;
  const destinations = [
    { id: 'home', path: '/', label: routeLabels.home, icon: Home },
    { id: 'inbox', path: '/inbox', label: routeLabels.inbox, icon: Inbox },
    { id: 'work', path: '/work', label: routeLabels.work, icon: BriefcaseBusiness },
    { id: 'workspace', path: '/workspace', label: '작업실', icon: PanelsTopLeft },
    { id: 'settings', path: '/settings', label: routeLabels.settings, icon: Settings },
  ];
  const right = <span className="flex items-center gap-2">{duty}{search}</span>;
  const left = <>{desktop && <button type="button" className="shell-icon-button min-[56rem]:hidden" aria-label="전체 메뉴" onClick={() => setMenuOpen(true)}><Menu aria-hidden="true"/></button>}{location}</>;
  return <div className="shell" data-fill={fill || undefined}>
    {desktop
      ? <TitleBar aria-label="Ghost" macOSInset={macOSInset} left={left} center={island} right={right}/>
      : <header className="ghost-titlebar shell-header">
        <div className="ghost-titlebar__slot ghost-titlebar__slot--left">{left}</div>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--center">{island}</div>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--right">{right}</div>
      </header>}
    <div className="shell-body">
      <aside className="shell-sidebar" aria-label="작업실 탐색">{sidebar}</aside>
      <main id="main-content" tabIndex={-1} className="shell-sheet" data-fill={fill || undefined}>
        {children}
      </main>
    </div>
    {!desktop && <nav className="compact-dock" aria-label="주요 화면" data-hidden={hideDock || undefined}>
      {destinations.map(item => <button key={item.id} type="button" aria-current={section === item.id ? 'page' : undefined} onClick={() => navigate(item.path)}>
        <span className="compact-dock__icon"><item.icon size={21} aria-hidden="true"/>{item.id === 'inbox' && attentionCount > 0 && <span className="compact-dock__badge">{attentionCount}<span className="sr-only">개 확인 요청</span></span>}</span>
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
