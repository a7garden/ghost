import type { State, Work } from '@ghost/contract';
import { routeLabels, uiTerms } from '../uiText';

/** One step of where a page sits; `path` is null for the page itself. */
export interface Crumb { label: string; path: string | null }

const settingsTabs: Record<string, string> = {
  team: 'Ghost', models: '모델', vault: '금고', devices: '기기', schedules: uiTerms.schedules,
  activities: uiTerms.activities, connections: uiTerms.connections,
  host: routeLabels.host, desktop: '데스크톱 아바타', appearance: '화면',
};

/** A Work and the Works above it, root first. Stops at a missing or cyclic parent. */
function lineage(state: State, workId: string): Work[] {
  const chain: Work[] = [];
  const seen = new Set<string>();
  for (let work = state.works.find(item => item.id === workId); work && !seen.has(work.id); work = work.parentId ? state.works.find(item => item.id === work!.parentId) : undefined) {
    seen.add(work.id);
    chain.unshift(work);
  }
  return chain;
}

/**
 * The title bar's breadcrumb for a route: the destination, then the thing inside it, then what is
 * open inside that (a thread and the threads it was delegated from). Home is the sidebar's first
 * row, so trails start at the section, not at 홈.
 */
export function crumbsFor(route: string, state: State | null): Crumb[] {
  const [path = '', query = ''] = route.split('?');
  const params = new URLSearchParams(query);
  const [, section = '', rawId] = path.split('/');
  const id = rawId ? decodeURIComponent(rawId) : null;
  switch (section) {
    case '':
      return [{ label: routeLabels.home, path: null }];
    case 'conversations':
      return [{ label: routeLabels.conversations, path: null }];
    case 'workspace':
      return [{ label: '대화', path: null }];
    case 'inbox':
      return [{ label: uiTerms.inbox, path: null }];
    case 'mail':
      return [{ label: routeLabels.mail, path: null }];
    case 'goals':
      return [{ label: uiTerms.goals, path: null }];
    case 'work': {
      if (!id) return [{ label: uiTerms.work, path: null }];
      const chain = state ? lineage(state, id) : [];
      if (!chain.length) return [{ label: uiTerms.work, path: null }];
      return [
        { label: uiTerms.work, path: '/work' },
        ...chain.map((work, index) => ({ label: work.title, path: index === chain.length - 1 ? null : `/work/${encodeURIComponent(work.id)}` })),
      ];
    }
    case 'ghosts': {
      const ghost = state?.ghosts.find(item => item.id === id);
      const conversationId = params.get('conversation');
      const base = `/ghosts/${encodeURIComponent(id ?? '')}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ''}`;
      const threadId = params.get('thread');
      const conversation = conversationId && conversationId !== ghost?.directConversationId ? state?.conversations.find(item => item.id === conversationId) : undefined;
      const thread = threadId && state ? lineage(state, threadId) : [];
      const crumbs: Crumb[] = [{ label: ghost?.name ?? routeLabels.ghosts, path: conversation || thread.length ? `/ghosts/${encodeURIComponent(id ?? '')}` : null }];
      if (conversation) crumbs.push({ label: conversation.title || '이전 대화', path: thread.length ? base : null });
      thread.forEach((work, index) => crumbs.push({
        label: work.title,
        path: index === thread.length - 1 ? null : `${base}${base.includes('?') ? '&' : '?'}thread=${encodeURIComponent(work.id)}`,
      }));
      return crumbs;
    }
    case 'scopes': {
      const space = id ? state?.scopes.find(item => item.id === id) : undefined;
      return space ? [{ label: routeLabels.scopes, path: '/scopes' }, { label: space.name, path: null }] : [{ label: routeLabels.scopes, path: null }];
    }
    case 'settings': {
      const tab = params.get('tab');
      const ghost = tab === 'team' && params.get('ghost') ? state?.ghosts.find(item => item.id === params.get('ghost')) : undefined;
      if (!tab || !settingsTabs[tab]) return [{ label: uiTerms.settings, path: null }];
      return [
        { label: uiTerms.settings, path: '/settings' },
        { label: settingsTabs[tab]!, path: ghost ? `/settings?tab=${tab}` : null },
        ...(ghost ? [{ label: ghost.name, path: null }] : []),
      ];
    }
    default:
      return [{ label: '찾을 수 없는 화면', path: null }];
  }
}
