import { useState, type ReactNode } from 'react';
import { Menu, Search } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle, GCommandPalette, GTitleBar, type GCommandItem } from '@garden/ui';

/**
 * Ghost's own frame: one fixed sidebar beside one main region, with a title bar that
 * names the location and opens command search. Garden supplies the controls only.
 */
export function AppFrame({ desktop, macOSInset, location, sidebar, fill, commands, paletteOpen, onPaletteOpenChange, children }: {
  /** Inside the Tauri window: draw the draggable title bar above everything. */
  desktop: boolean;
  macOSInset: number;
  location: string;
  sidebar: ReactNode;
  /** The page owns its height and scrolling (conversations, settings). */
  fill: boolean;
  commands: GCommandItem[];
  paletteOpen: boolean;
  onPaletteOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const search = <Button variant="ghost" size="icon" aria-label="명령 검색" title="명령 검색 · ⌘K" onClick={() => onPaletteOpenChange(true)}><Search/></Button>;
  const menu = <Button variant="ghost" size="icon" className="min-[56rem]:hidden" aria-label="전체 메뉴" onClick={() => setMenuOpen(true)}><Menu/></Button>;
  const place = <span className="truncate text-ui font-medium text-ink">{location}</span>;
  return <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
    {desktop
      ? <GTitleBar aria-label="Ghost" macOSInset={macOSInset} left={menu} center={place} right={search}/>
      : <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">{menu}<div className="min-w-0 flex-1">{place}</div>{search}</header>}
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r border-line bg-page min-[56rem]:flex" aria-label="작업실 탐색">{sidebar}</aside>
      <main id="main-content" tabIndex={-1} className={fill ? 'flex min-h-0 min-w-0 flex-1 flex-col outline-none [&>*]:min-h-0 [&>*]:shrink-0 [&>*:last-child]:flex-1' : 'min-h-0 min-w-0 flex-1 overflow-y-auto px-[clamp(16px,3vw,40px)] py-8 outline-none'}>
        {children}
      </main>
    </div>
    <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
      <DialogContent closeLabel="닫기" aria-describedby={undefined} className="max-h-[80dvh] w-[min(340px,calc(100vw-32px))] p-0"
        onClick={event => { if ((event.target as Element).closest('button[aria-current], .g-navigation-item')) setMenuOpen(false); }}>
        <DialogTitle className="sr-only">전체 메뉴</DialogTitle>
        <div className="flex max-h-[80dvh] flex-col">{sidebar}</div>
      </DialogContent>
    </Dialog>
    <GCommandPalette items={commands} open={paletteOpen} onOpenChange={onPaletteOpenChange}
      strings={{ ariaLabel: '명령', searchPlaceholder: '명령 검색…', emptyTitle: '일치하는 항목이 없습니다', emptyHint: '다른 이름이나 단어로 검색해 주세요.', closeLabel: '닫기' }}/>
  </div>;
}
