import { expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readRunState, type VisualRunState } from './run-state';

/** Freeze the browser clock at seed completion; suppress live values only in captures. */
const RUN_ID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

/** Motion and geometry fixed by the visual harness. */
const STABILITY_CSS = `
  /* Keep the project path chip independent of TMPDIR. */
  .place__crumb[title] { width: 240px !important; max-width: 100%; overflow: hidden; }
  /* A Ghost's next self-directed look is a live clock time. */
  .ghost-settings-row time { display: inline-block; width: 160px; vertical-align: bottom; overflow: hidden; }
  /* The auto-color swatch hashes a newly seeded Ghost id; keep its geometry, not that random hue. */
  .look-swatch[data-auto] { background: conic-gradient(#5b7fd4 0 50%, var(--ghost-hover2) 50%) !important; }
  /* Finish the width/translation entrance before text can acquire a fractional compositor layer. */
  .thread-panel, .thread-panel > * { animation: none !important; }
`;

const CAPTURE_STYLE = fileURLToPath(new URL('./capture.css', import.meta.url));

export type Theme = 'light' | 'dark';

export interface Screen {
  name: string;
  route: (state: VisualRunState) => string;
  /** Text that must be visible before the shot; proves the data has rendered. */
  waits: (state: VisualRunState) => string[];
  /** Network shaping before the app loads: mocked vault API, injected decisions. */
  prepare?: (page: Page) => Promise<void>;
}

export async function openScreen(page: Page, screen: Screen, theme: Theme): Promise<VisualRunState> {
  const state = readRunState();
  await page.addInitScript(preferences => {
    localStorage.setItem('ghost-ui:preferences', JSON.stringify(preferences));
  }, { theme, animate: false, companion: false, companionProfile: '' });
  await page.clock.setFixedTime(new Date(state.fixedNow));
  // Next-message suggestions come from a live model call that lands a moment after load; captures never show them.
  await page.route('**/api/suggestions*', route => route.fulfill({ json: { suggestions: [] } }));
  await screen.prepare?.(page);
  await page.goto(`${state.baseUrl}/#${screen.route(state)}`);
  for (const text of screen.waits(state)) {
    await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  // Install in the main document directly: addStyleTag's global CSP listener mistakes
  // an opaque presentation iframe's concurrent CSP diagnostics for a main-page failure.
  await page.evaluate(css => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
  }, STABILITY_CSS);
  await page.waitForTimeout(250);
  return state;
}

export async function screenshot(page: Page, name: string): Promise<void> {
  await page.locator('.feed__body').filter({ hasText: RUN_ID }).evaluateAll((rows, runId) => {
    for (const row of rows) row.setAttribute('data-visual-text', row.textContent!.replace(runId, '작업 ID'));
  }, RUN_ID);
  // The work's isolated checkout has a new temporary directory on each run.
  await page.locator('.work-aside__environment').filter({ hasText: /ghost-visual-regression-[^/]+\/primary\/projects/ })
    .evaluateAll(rows => { for (const row of rows) row.setAttribute('data-visual-text', '이 Mac · /Projects/ghost'); });
  await page.getByRole('region', { name: '모델 설정' }).getByText(/^http:\/\/127\.0\.0\.1:\d+\/v1$/, { exact: true })
    .evaluateAll(rows => { for (const row of rows) row.setAttribute('data-visual-text', 'http://127.0.0.1:8080/v1'); });
  // The Host version changes with every release; a baseline must not.
  await page.locator('[id$="-tab-update-value"], #settings-index-update-value').evaluateAll(rows => {
    for (const row of rows) row.setAttribute('data-visual-text', row.textContent!.replace(/\d+\.\d+\.\d+/, '0.0.0'));
  });
  await page.getByText(/버전 \d+\.\d+\.\d+/).evaluateAll(rows => {
    for (const row of rows) if (!row.children.length) row.setAttribute('data-visual-text', row.textContent!.replace(/\d+\.\d+\.\d+/, '0.0.0'));
  });
  await expect.soft(page).toHaveScreenshot(name, {
    stylePath: CAPTURE_STYLE,
    animations: 'disabled',
    caret: 'hide',
    threshold: 0.2,
  });
}
