import { createServer } from 'node:http';
import { test, expect, type Page } from '@playwright/test';
import type { ActivityConfig, Command, State } from '@ghost/contract';
import { readRunState } from './run-state';

async function send(page: Page, command: Command): Promise<Record<string, unknown>> {
  return page.evaluate(async command => {
    const response = await fetch('/api/commands', {
      method: 'POST', headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), command }),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
    return body.result;
  }, command);
}

async function storedState(page: Page): Promise<State & Required<Pick<State, 'activities' | 'connections'>>> {
  return page.evaluate(async () => {
    const response = await fetch('/api/state', { headers: { authorization: `Bearer ${window.__GHOST_TOKEN__}` } });
    return response.json();
  });
}

const policy: ActivityConfig['policy'] = {
  maxRunsPerDay: 10, maxConcurrent: 1, runTimeoutSeconds: 45,
  allowSelfCheck: true, minCheckSeconds: 91, externalActions: 'deny', delivery: 'changes',
};

const activityConfig = (ghostId: string, source: ActivityConfig['source']): ActivityConfig => ({
  ghostId, name: 'Precise activity', prompt: 'Read and summarize only.', acceptanceCriteria: 'Leave a summary.',
  execution: { kind: 'container' }, tools: ['read'], source, policy,
});

test.describe('Connection and activity edits', () => {
  const connections: string[] = [];
  const activities: string[] = [];
  const ghosts: string[] = [];

  test.beforeEach(async ({ page }) => {
    connections.length = activities.length = ghosts.length = 0;
    await page.goto(`${readRunState().baseUrl}/#/settings?tab=connections`);
    await expect(page.getByRole('button', { name: '연결 추가', exact: true })).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.unroute('**/api/commands');
    for (const activityId of activities) await send(page, { type: 'activity.delete', activityId });
    for (const connectionId of connections) await send(page, { type: 'connection.delete', connectionId });
    for (const ghostId of ghosts) {
      await send(page, { type: 'ghost.update', ghostId, state: 'retired' });
      await send(page, { type: 'ghost.delete', ghostId });
    }
  });

  test('keeps every entered account field after a failed save and allows an explicit retry', async ({ page }) => {
    await page.getByRole('button', { name: '연결 추가', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '연결 추가', exact: true });
    await dialog.getByRole('radio', { name: '메일', exact: true }).click();
    const fields = [
      ['이름', 'Retry mail account'], ['IMAP 서버', 'imap.example.test'], ['포트', '1993'],
      ['사용자 이름', 'owner@example.test'], ['메일함', 'Priority'],
      ['SMTP 서버', 'smtp.example.test'], ['SMTP 포트', '2465'],
    ] as const;
    for (const [label, value] of fields) await dialog.getByRole(label.endsWith('포트') ? 'spinbutton' : 'textbox', { name: label, exact: true }).fill(value);
    const implicitTLS = dialog.getByRole('switch', { name: 'SMTP 암시적 TLS', exact: true });
    if (await implicitTLS.getAttribute('aria-checked') !== 'true') await implicitTLS.click();
    await dialog.getByLabel('앱 비밀번호', { exact: true }).fill('synthetic-retry-secret');
    let attempts = 0;
    await page.route('**/api/commands', async route => {
      if (route.request().postDataJSON()?.command?.type === 'connection.upsert') {
        attempts++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          ok: false, error: { code: 'unavailable', message: 'Synthetic save unavailable' },
        }) });
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: '연결 추가', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Synthetic save unavailable');
    for (const [label, value] of fields) await expect(dialog.getByRole(label.endsWith('포트') ? 'spinbutton' : 'textbox', { name: label, exact: true })).toHaveValue(value);
    await expect(dialog.getByLabel('앱 비밀번호', { exact: true })).toHaveValue('synthetic-retry-secret');
    await expect(implicitTLS).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('button', { name: '연결 추가', exact: true })).toBeEnabled();
    expect(attempts).toBe(1);
    expect((await storedState(page)).connections.some(item => item.name === 'Retry mail account')).toBe(false);

    await page.unroute('**/api/commands');
    await dialog.getByRole('button', { name: '연결 추가', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await storedState(page)).connections.find(item => item.name === 'Retry mail account');
    expect(saved).toBeDefined();
    connections.push(saved!.id);
    expect(saved).toMatchObject({ hasCredential: true, config: {
      kind: 'mail', host: 'imap.example.test', port: 1993, username: 'owner@example.test', mailbox: 'Priority',
      smtpHost: 'smtp.example.test', smtpPort: 2465, smtpSecure: true,
    } });
  });

  test('saves an endpoint change on a disconnected account without restoring a credential', async ({ page }) => {
    const created = await send(page, { type: 'connection.upsert', name: 'Disconnected account',
      config: { kind: 'github', baseUrl: 'https://api.github.com' } });
    const connectionId = String(created.connectionId);
    connections.push(connectionId);
    await page.getByRole('button', { name: 'Disconnected account 편집', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '연결 편집', exact: true });
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('Changed disconnected account');
    await dialog.getByRole('textbox', { name: 'API 주소', exact: true }).fill('https://github.example.test/api');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await storedState(page)).connections.find(item => item.id === connectionId)).toMatchObject({
      name: 'Changed disconnected account', config: { kind: 'github', baseUrl: 'https://github.example.test/api' },
      hasCredential: false, credentialVersion: null,
    });
  });

  for (const spec of [
    { kind: 'every' as const, seconds: 7 * 86400 + 1, startAt: Date.UTC(2099, 1, 3, 14, 25, 37, 123) },
    { kind: 'at' as const, at: Date.UTC(2099, 1, 3, 14, 25, 37, 123) },
  ]) test(`name-only ${spec.kind} edit preserves exact cadence, next occurrence and limits`, async ({ page }) => {
    const ghostId = String((await send(page, { type: 'ghost.create', name: 'Precise schedule Ghost', persona: '', tools: ['read'] })).ghostId);
    ghosts.push(ghostId);
    const config = activityConfig(ghostId, { kind: 'schedule', spec });
    const activityId = String((await send(page, { type: 'activity.create', config })).activityId);
    activities.push(activityId);
    const before = (await storedState(page)).activities.find(item => item.id === activityId)!;
    await page.goto(`${readRunState().baseUrl}/#/settings?tab=activities`);
    await page.getByRole('button', { name: 'Precise activity 편집', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '활동 편집', exact: true });
    await expect(dialog.getByRole('combobox', { name: 'Ghost', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('Renamed precise schedule');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await storedState(page)).activities.find(item => item.id === activityId)!;
    expect(saved).toMatchObject({ name: 'Renamed precise schedule', ghostId, source: config.source, policy, nextAt: before.nextAt });
  });

  test('a name-only source edit retains its real consumed cursor and second-precision poll interval', async ({ page }) => {
    // The Host, not the browser, consumes this finite synthetic Gitea baseline.
    const source = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      const firstPage = url.pathname === '/api/v1/repos/garden/ghost/pulls' && url.searchParams.get('page') === '1';
      response.end(JSON.stringify(firstPage ? [{
        number: 1, title: 'Existing baseline PR', body: '', state: 'open', draft: false,
        updated_at: '2026-11-01T12:34:56.000Z', head: { sha: 'head' }, base: { ref: 'release', sha: 'base' },
        labels: [{ name: 'review' }],
      }] : []));
    });
    const listening = Promise.withResolvers<void>();
    source.once('error', listening.reject);
    source.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    try {
      const address = source.address();
      if (!address || typeof address === 'string') throw new Error('source server did not bind');
      const connectionId = String((await send(page, { type: 'connection.upsert', name: 'Cursor account', credential: 'synthetic-source-secret',
        config: { kind: 'gitea', baseUrl: `http://127.0.0.1:${address.port}/api/v1` } })).connectionId);
      connections.push(connectionId);
      const ghostId = String((await send(page, { type: 'ghost.create', name: 'Cursor Ghost', persona: '', tools: ['read'] })).ghostId);
      ghosts.push(ghostId);
      const config = activityConfig(ghostId, { kind: 'pull_request', connectionId, repository: 'garden/ghost',
        baseBranch: 'release', labels: ['review'], includeDrafts: false, includeExisting: false, pollSeconds: 90 });
      const activityId = String((await send(page, { type: 'activity.create', config })).activityId);
      activities.push(activityId);
      await expect.poll(async () => (await storedState(page)).activities.find(item => item.id === activityId)?.cursor ?? null).not.toBeNull();
      await send(page, { type: 'activity.pause', activityId, paused: true });
      const before = (await storedState(page)).activities.find(item => item.id === activityId)!;
      expect(JSON.parse(before.cursor!).seen).toHaveProperty('1');
      await page.goto(`${readRunState().baseUrl}/#/settings?tab=activities`);
      await page.getByRole('button', { name: 'Precise activity 편집', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '활동 편집', exact: true });
      await dialog.getByRole('textbox', { name: '이름', exact: true }).fill('Renamed source');
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const saved = (await storedState(page)).activities.find(item => item.id === activityId)!;
      expect(saved).toMatchObject({ name: 'Renamed source', source: config.source, policy,
        cursor: before.cursor, lastCheckedAt: before.lastCheckedAt, nextAt: before.nextAt, paused: true });
    } finally {
      const closed = Promise.withResolvers<void>();
      source.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  });
});
