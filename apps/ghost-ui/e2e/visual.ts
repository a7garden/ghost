import { expect, type Page } from '@playwright/test';
import { readRunState, type VisualRunState } from './run-state';

/**
 * Screen-opening helpers shared by the visual spec. Every screen freezes the
 * browser clock (`page.clock.setFixedTime`) at the seeding end so `Date.now()`
 * is constant, and covers the nondeterministic regions: `<time>` elements
 * (relative-time text) and host wake lines, whose text depends on run timing.
 * A returned Work renders as its outcome line, whose id stays behind a hover.
 * The verdict stamp's absolute timestamp is a plain span with proportional
 * digits, so it is hidden outright instead of masked.
 */

const MASK_SELECTORS = ['time', '.transcript-event'];

/** Test-side style that removes text no mask can cover deterministically. */
const STABILITY_CSS = '.verdict span { visibility: hidden !important; }';

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
  await screen.prepare?.(page);
  await page.goto(`${state.baseUrl}/#${screen.route(state)}`);
  for (const text of screen.waits(state)) {
    await expect(page.getByText(text).filter({ visible: true }).first()).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: STABILITY_CSS });
  await page.waitForTimeout(250);
  return state;
}

export async function screenshot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(name, {
    mask: MASK_SELECTORS.map(selector => page.locator(selector)),
    animations: 'disabled',
    caret: 'hide',
    threshold: 0.2,
  });
}
