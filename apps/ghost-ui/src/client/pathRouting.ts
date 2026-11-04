// 경로 URL(예: "/spaces/notes")을 이 앱이 실제 탐색에 쓰는 해시 라우트(→ "#/spaces/notes")로
// 변환한다. 공유되거나 새로 고친 경로 링크가 기본 화면 대신 의도한 화면으로 열리게 한다.
const sections: Record<string, true> = { ghosts: true, spaces: true, inbox: true, work: true, together: true, integrations: true, settings: true, host: true, providers: true };

export function pathToHash(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '');
  if (path === '' || path === '/') return null;
  const [route, query] = path.split('?');
  const segments = route.split('/').filter(Boolean);
  const [section] = segments;
  // App resolves the retired planner link once the Host's Work mode is known.
  if (section === 'planner') return '/planner';
  if (!section || !sections[section]) return null;
  return `/${segments.join('/')}${query ? `?${query}` : ''}`;
}
