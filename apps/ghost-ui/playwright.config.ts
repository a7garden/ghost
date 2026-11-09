import { defineConfig } from '@playwright/test';

/**
 * Visual regression suite. One project on the system Google Chrome
 * (`channel: 'chrome'` — no browser download), single worker so the isolated
 * host and the screenshots stay deterministic. Global setup builds the runtime:
 * an isolated host from source, the mock provider, and seeded data.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  forbidOnly: true,
  workers: 1,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
  projects: [
    { name: 'desktop', testIgnore: /iphone\.spec\.ts/ },
    { name: 'iphone', testMatch: /iphone\.spec\.ts/, use: {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    } },
  ],
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
});
