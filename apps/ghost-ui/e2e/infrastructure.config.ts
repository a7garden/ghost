import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'infrastructure-live.spec.ts', outputDir: '../test-results/infrastructure',
  workers: 1, timeout: 120_000, expect: { timeout: 15_000 }, reporter: [['list']],
  use: { channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
});
