import { test } from '@playwright/test';
import { screenshot, openScreen, type Screen } from './visual';

/**
 * Seven screens × 1440x900 / 390x844 × light / dark. Baselines live under
 * `e2e/__screenshots__/`; `bun run test:visual:update` regenerates them.
 */

const screens: Screen[] = [
  { name: 'home', route: () => '/', waits: () => ['진행 중', '최근 끝난 일'] },
  { name: 'inbox', route: () => '/inbox', waits: () => ['어떤 항목부터 조사할까요?', '회의 메모 요약'] },
  { name: 'work', route: () => '/work', waits: () => ['회의 메모 요약', '끝난 일'] },
  { name: 'work-detail', route: state => `/work/${encodeURIComponent(state.workDoneId)}`, waits: () => ['주간 보고 초안'] },
  { name: 'conversation', route: state => `/ghosts/${encodeURIComponent(state.defaultGhostId)}`, waits: () => ['맡긴 일에서 볼 수 있어요'] },
  { name: 'team', route: () => '/settings?tab=team', waits: () => ['연구원', '기록가', '새 Ghost'] },
  { name: 'projects', route: state => `/spaces/${encodeURIComponent(state.spaceId)}`, waits: () => ['비행 기록 노트', '회의 정리'] },
];

const viewports = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
];

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of viewports) {
    test.describe(`${theme}-${viewport.label}`, () => {
      test.use({ colorScheme: theme, viewport: { width: viewport.width, height: viewport.height } });
      for (const screen of screens) {
        test(`${screen.name}`, async ({ page }) => {
          await openScreen(page, screen, theme);
          await screenshot(page, `${screen.name}-${theme}-${viewport.label}.png`);
        });
      }
    });
  }
}
