import { useState, type ReactNode } from 'react';
import { Menu, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, CommandPalette, TitleBar, type CommandItem } from '../ui'

/**
 * The window: a quiet sidebar on the page tone, the destination on an inset sheet,
 * and a title bar that carries location, the activity island and command search.
 */
export function AppFrame({ desktop, macOSInset, location, island, sidebar, fill, commands, paletteOpen, onPaletteOpenChange, children }: {
  /** Inside the Tauri window: draw the draggable title bar above everything. */
  desktop: boolean;
  macOSInset: number;
  location: string;
  /** Live activity across Ghosts; renders nothing while the workspace is quiet. */
  island: ReactNode;
  sidebar: ReactNode;
  /** The page owns its height and scrolling (conversations, settings). */
  fill: boolean;
  commands: CommandItem[];
  paletteOpen: boolean;
  onPaletteOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const search = <button type="button" className="shell-search" aria-label="명령 검색" title="명령 검색 · ⌘K" onClick={() => onPaletteOpenChange(true)}>
    <Search aria-hidden="true"/><span className="shell-search__label">검색</span><kbd>⌘K</kbd>
  </button>;
  const menu = <button type="button" className="shell-icon-button min-[56rem]:hidden" aria-label="전체 메뉴" onClick={() => setMenuOpen(true)}><Menu aria-hidden="true"/></button>;
  const left = <>{menu}<span className="shell-location">{location}</span></>;
  return <div className="shell" data-fill={fill || undefined}>
    {desktop
      ? <TitleBar aria-label="Ghost" macOSInset={macOSInset} left={left} center={island} right={search}/>
      : <header className="ghost-titlebar shell-header">
        <div className="ghost-titlebar__slot ghost-titlebar__slot--left">{left}</div>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--center">{island}</div>
        <div className="ghost-titlebar__slot ghost-titlebar__slot--right">{search}</div>
      </header>}
    <div className="shell-body">
      <aside className="shell-sidebar" aria-label="작업실 탐색">{sidebar}</aside>
      <main id="main-content" tabIndex={-1} className="shell-sheet" data-fill={fill || undefined}>
        {children}
      </main>
    </div>
    <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
      <DialogContent closeLabel="닫기" aria-describedby={undefined} className="shell-menu max-h-[86dvh] w-[min(340px,calc(100vw-24px))] p-0"
        onClick={event => { if ((event.target as Element).closest('button[aria-current], .ghost-navigation-item, .presence-row__main')) setMenuOpen(false); }}>
        <DialogTitle className="sr-only">전체 메뉴</DialogTitle>
        <div className="flex max-h-[86dvh] flex-col">{sidebar}</div>
      </DialogContent>
    </Dialog>
    <CommandPalette items={commands} open={paletteOpen} onOpenChange={onPaletteOpenChange}
      strings={{ ariaLabel: '명령', searchPlaceholder: 'Ghost, 화면, 프로젝트 검색…', emptyTitle: '일치하는 항목이 없습니다', emptyHint: '다른 이름이나 단어로 검색해 주세요.', closeLabel: '닫기' }}/>
  </div>;
}
