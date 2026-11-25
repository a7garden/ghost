import type { Page } from '@playwright/test';
import type { Scope } from '@ghost/contract';
import { serveWorkbench } from '../../ghost-host/src/workbench/http';
import { Workbench } from '../../ghost-host/src/workbench/service';
import { CommandError } from '../../ghost-host/src/core/errors';
import { sampleSession } from './coding-session-mock';

/** Intercept the browser API with the real Workbench router and an in-memory ledger; any project id is accepted. */
export async function mockWorkbench(page: Page, creates: unknown[] = []) {
  let serialized: string | undefined;
  const projects = new Set<string>();
  const session = (id: string) => {
    if (id === sampleSession.id) return sampleSession;
    const created = /^new-(\d+)$/.exec(id);
    return created && creates.length >= Number(created[1]) ? { ...sampleSession, id } : null;
  };
  const service = new Workbench({
    setting: (_key, fallback) => serialized === undefined ? fallback : JSON.parse(serialized),
    putSetting: (_key, value) => { serialized = JSON.stringify(value); },
    tx: edit => edit(),
    // Any project id the test names exists from then on, as the visual Host's projects do.
    scope: id => { projects.add(id); return ({ id, paths: [] }) as unknown as Scope; },
    scopes: () => [...projects].map(id => ({ id, paths: [] }) as unknown as Scope),
  }, { get: session, list: () => [sampleSession] });
  await page.route(/\/api\/workbench(?:[/?]|$)/, async route => {
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
