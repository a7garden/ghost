import { FolderPlus, LayoutList, MessageCircle, Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Ghost } from '@ghost/contract';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui';
import { newProjectPath } from '../features/ghostRoutes';
import { uiTerms } from '../uiText';

export function RosterGhostMenu({ ghost, onOpen, navigate, children }: {
  ghost: Ghost;
  onOpen(): void;
  navigate(path: string): void;
  children: ReactNode;
}) {
  const id = encodeURIComponent(ghost.id);
  return <ContextMenu>
    <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
    <ContextMenuContent aria-label={`${ghost.name} 메뉴`}>
      <ContextMenuItem icon={<MessageCircle/>} onSelect={onOpen}>대화 열기</ContextMenuItem>
      <ContextMenuItem icon={<FolderPlus/>} onSelect={() => navigate(newProjectPath(ghost.id))}>새 프로젝트</ContextMenuItem>
      <ContextMenuItem icon={<LayoutList/>} onSelect={() => navigate(`/work?ghost=${id}`)}>{uiTerms.work}</ContextMenuItem>
      <ContextMenuItem icon={<Settings2/>} onSelect={() => navigate(`/settings?tab=team&ghost=${id}`)}>{uiTerms.ghostSettings}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}
