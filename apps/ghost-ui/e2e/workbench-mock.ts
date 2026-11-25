import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { serveWorkbench } from '../../ghost-host/src/workbench/http';
import { Workbench } from '../../ghost-host/src/workbench/service';
import { CommandError } from '../../ghost-host/src/core/errors';
import { sampleSession } from './coding-session-mock';

/** Intercept the browser API with the real Workbench router and an in-memory ledger. */
export async function mockWorkbench(page: Page, creates: { repo?: string; cwd?: string }[] = []) {
  let serialized: string | undefined;
  const service = new Workbench({
    setting: (_key, fallback) => serialized === undefined ? fallback : JSON.parse(serialized),
    putSetting: (_key, value) => { serialized = JSON.stringify(value); },
    tx: edit => edit(),
  }, { get: id => id === sampleSession.id ? sampleSession : id === 'new-1' && creates[0] ? { ...sampleSession, id } : null }, tmpdir());
  await page.route('**/api/workbench/**', async route => {
    const request = route.request();
    const json = request.postData();
    try {
      const path = new URL(request.url()).pathname;
      const result = await serveWorkbench(service, { kind: 'owner' }, new Request(request.url(), { method: request.method(), body: json }), path);
      await route.fulfill({ json: result });
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      const status = error.code === 'conflict' ? 409 : error.code === 'not_found' ? 404 : 400;
      await route.fulfill({ status, json: { ok: false, error: { code: error.code, message: error.message } } });
    }
  });
  return { service };
}
