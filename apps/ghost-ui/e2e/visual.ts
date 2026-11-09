import { expect, type Page } from '@playwright/test';
import { readRunState, type VisualRunState } from './run-state';

/**
 * Screen-opening helpers shared by the visual spec. Every screen freezes the
 * browser clock (`page.clock.setFixedTime`) at the seeding end so `Date.now()`
 * is constant, and covers the nondeterministic regions: `<time>` elements
 * (relative-time text), host wake lines and the project's actual temporary folder
 * breadcrumb (`title` holds the full path; rendered text abbreviates it).
 * A returned Work renders as its outcome line, whose id stays behind a hover.
 * The verdict stamp's absolute timestamp is a plain span with proportional
 * digits, so it is hidden outright instead of masked.
 */

const MASK_SELECTORS = ['time', '.transcript-event', '.place__crumb[title]'];

/** Test-side style that removes text no mask can cover deterministically. */
const STABILITY_CSS = `
  .verdict span { visibility: hidden !important; }
  /* Mask geometry must not depend on TMPDIR's random path length. Test-only. */
  .place__crumb[title] { width: 240px !important; max-width: 100%; overflow: hidden; }
  /* A Ghost's next self-directed look is a live clock time; fix its masked width. Test-only. */
  .ghost-settings-row time { display: inline-block; width: 160px; vertical-align: bottom; overflow: hidden; }
  /* The auto-color swatch hashes a newly seeded Ghost id; keep its geometry, not that random hue. */
  .look-swatch[data-auto] { background: conic-gradient(#5b7fd4 0 50%, var(--ghost-hover2) 50%) !important; }
  /* Finish the width/translation entrance before text can acquire a fractional compositor layer. */
  .thread-panel, .thread-panel > * { animation: none !important; }
`;

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
  await expect(page).toHaveScreenshot(name, {
    mask: MASK_SELECTORS.map(selector => page.locator(selector)),
    animations: 'disabled',
    caret: 'hide',
    threshold: 0.2,
  });
}
