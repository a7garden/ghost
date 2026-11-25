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
    await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=connections`);
    await expect(page.getByRole('textbox', { name: '서비스 검색', exact: true })).toBeVisible();
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
    // A domain the Host cannot resolve leaves the owner to type the servers, so every field is in play.
    await page.route('**/api/connect/mail*', route => route.fulfill({ json: {
      email: 'owner@example.test', domain: 'example.test', provider: null, imap: null, smtp: null, auth: 'password', setupUrl: null, note: null, source: 'none',
    } }));
    await page.getByRole('button', { name: '다른 메일 계정 연결', exact: true }).click();
    const setup = page.getByRole('region', { name: '이메일 연결', exact: true });
    await setup.getByRole('textbox', { name: '이메일 주소', exact: true }).fill('owner@example.test');
    await expect(setup.getByRole('textbox', { name: 'IMAP 서버', exact: true })).toBeVisible();
    const fields = [
      ['IMAP 서버', 'imap.example.test'], ['IMAP 포트', '1993'], ['메일함', 'Priority'],
      ['SMTP 서버', 'smtp.example.test'], ['SMTP 포트', '2465'],
    ] as const;
    for (const [label, value] of fields) await setup.getByRole(label.endsWith('포트') ? 'spinbutton' : 'textbox', { name: label, exact: true }).fill(value);
    const implicitTLS = setup.getByRole('switch', { name: 'SMTP 암시적 TLS', exact: true });
    if (await implicitTLS.getAttribute('aria-checked') !== 'true') await implicitTLS.click();
    await setup.getByLabel('비밀번호', { exact: true }).fill('synthetic-retry-secret');
    let attempts = 0;
    await page.route('**/api/commands', async route => {
      if (route.request().postDataJSON()?.command?.type === 'connection.upsert') {
        attempts++;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
          ok: false, error: { code: 'unavailable', message: 'Synthetic save unavailable' },
        }) });
      } else await route.continue();
    });
    await setup.getByRole('button', { name: '연결하고 확인', exact: true }).click();
    await expect(setup.getByRole('alert')).toContainText('Synthetic save unavailable');
    for (const [label, value] of fields) await expect(setup.getByRole(label.endsWith('포트') ? 'spinbutton' : 'textbox', { name: label, exact: true })).toHaveValue(value);
    await expect(setup.getByLabel('비밀번호', { exact: true })).toHaveValue('synthetic-retry-secret');
    await expect(implicitTLS).toHaveAttribute('aria-checked', 'true');
    await expect(setup.getByRole('button', { name: '연결하고 확인', exact: true })).toBeEnabled();
    expect(attempts).toBe(1);
    expect((await storedState(page)).connections.some(item => item.config.kind === 'mail' && item.config.username === 'owner@example.test')).toBe(false);

    await page.unroute('**/api/commands');
    await setup.getByRole('button', { name: '연결하고 확인', exact: true }).click();
    await expect(setup).toHaveCount(0);
    const saved = (await storedState(page)).connections.find(item => item.config.kind === 'mail' && item.config.username === 'owner@example.test');
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
    const setup = page.getByRole('region', { name: 'Disconnected account 편집', exact: true });
    await setup.getByRole('textbox', { name: '이름', exact: true }).fill('Changed disconnected account');
    await setup.getByRole('button', { name: '고급 설정', exact: true }).click();
    await setup.getByRole('textbox', { name: 'API 주소', exact: true }).fill('https://github.example.test/api');
    await setup.getByRole('button', { name: '저장하고 확인', exact: true }).click();
    await expect(setup).toHaveCount(0);
    expect((await storedState(page)).connections.find(item => item.id === connectionId)).toMatchObject({
      name: 'Changed disconnected account', config: { kind: 'github', baseUrl: 'https://github.example.test/api' },
      hasCredential: false, credentialVersion: null,
    });
  });

  test('offers only Work-capable tools including documents, browser and vault', async ({ page }) => {
    const ghostId = String((await send(page, { type: 'ghost.create', name: 'Capability Ghost', persona: '',
      tools: ['read', 'browser_open', 'vault_list', 'document_read', 'activity_propose', 'work_create'] })).ghostId);
    ghosts.push(ghostId);
    await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=activities`);
    await page.getByRole('button', { name: '활동 만들기', exact: true }).click();
    const editor = page.getByRole('form', { name: '활동 만들기', exact: true });
    await editor.getByRole('combobox', { name: 'Ghost', exact: true }).selectOption(ghostId);
    const toolSummary = editor.locator('summary').filter({ hasText: '도구 1개 · 파일 읽기' });
    const tools = editor.getByRole('group', { name: '활동 도구', exact: true });
    await expect(tools).toBeHidden();
    await toolSummary.click();
    await expect(tools.getByRole('checkbox')).toHaveCount(4);
    for (const name of ['파일 읽기', '문서 읽기', '브라우저 열기', '금고 목록']) {
      await expect(tools.getByRole('checkbox', { name, exact: true })).toBeVisible();
    }
    const search = tools.getByRole('searchbox', { name: '활동 도구 검색', exact: true });
    await search.fill('없는 도구');
    await expect(tools.getByRole('status')).toHaveText('검색에 맞는 도구가 없습니다.');
    await search.fill('금고');
    await search.press('Enter');
    await expect(tools.getByRole('checkbox')).toHaveCount(1);
    await tools.getByRole('checkbox', { name: '금고 목록', exact: true }).check();
    await expect(toolSummary).toHaveCount(0);
    await editor.locator('summary').filter({ hasText: '도구 2개 · 파일 읽기, 금고 목록' }).click();
    await expect(tools).toBeHidden();
    await expect(editor.getByRole('combobox', { name: '이 활동의 PR 댓글·메일 회신', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: '취소', exact: true }).click();
  });

  test('browses the Mac working folder without leaving the activity rule', async ({ page }) => {
    const ghostId = String((await send(page, { type: 'ghost.create', name: 'Folder capability Ghost', persona: '',
      tools: ['read'], hostExecution: true })).ghostId);
    ghosts.push(ghostId);
    await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=activities`);
    await page.getByRole('button', { name: '활동 만들기', exact: true }).click();
    const editor = page.getByRole('form', { name: '활동 만들기', exact: true });
    await editor.getByRole('combobox', { name: 'Ghost', exact: true }).selectOption(ghostId);
    await editor.getByRole('textbox', { name: '이름', exact: true }).fill('폴더를 고르는 활동');
    await editor.getByRole('combobox', { name: '실행 환경', exact: true }).selectOption('host');
    await editor.getByRole('button', { name: /^작업 폴더:/ }).click();
    const folder = editor.getByRole('group', { name: '작업 폴더', exact: true });
    await expect(folder.getByRole('list', { name: '하위 폴더' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await folder.getByRole('button', { name: '이 폴더 선택', exact: true }).click();
    await expect(editor.getByRole('button', { name: /^작업 폴더: \// })).toBeFocused();
    await expect(editor.getByRole('textbox', { name: '이름', exact: true })).toHaveValue('폴더를 고르는 활동');
    await editor.getByRole('button', { name: /^작업 폴더:/ }).click();
    await folder.getByRole('button', { name: '폴더 선택 취소', exact: true }).click();
    await expect(folder).toHaveCount(0);
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: '취소', exact: true }).click();
  });

  test('creates and edits a scheduled conversation wake in the timeline', async ({ page }) => {
    const original = '반복 작업 타임라인 확인';
    const revised = '반복 작업 타임라인 수정';
    const starts = '2099-01-01T09:30';
    const startAt = await page.evaluate(value => new Date(value).getTime(), starts);
    try {
      await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=schedules`);
      await page.getByRole('button', { name: '반복 작업 예약', exact: true }).click();
      const create = page.getByRole('form', { name: '반복 작업 예약', exact: true });
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await create.getByRole('combobox', { name: '실행 방식', exact: true }).selectOption('every');
      await create.getByLabel('시작 시각', { exact: true }).fill(starts);
      const minutes = create.getByRole('spinbutton', { name: '반복 간격 (분)', exact: true });
      await minutes.fill('0');
      const prompt = create.getByRole('textbox', { name: '실행할 내용', exact: true });
      await prompt.fill(original);
      await create.getByRole('button', { name: '예약', exact: true }).click();
      await expect(create.getByRole('alert')).toContainText('1분 이상');
      await expect(prompt).toHaveValue(original);
      await expect(create.getByLabel('시작 시각', { exact: true })).toHaveValue(starts);
      await minutes.fill('35');
      await prompt.press('Control+Enter');
      await expect(create).toHaveCount(0);
      const row = page.getByRole('article').filter({ hasText: original });
      await expect(row).toContainText('35분마다');
      await row.getByRole('button', { name: '반복 작업 편집', exact: true }).click();
      const edit = page.getByRole('form', { name: '반복 작업 편집', exact: true });
      await expect(edit.getByLabel('시작 시각', { exact: true })).toHaveValue(starts);
      await edit.getByRole('textbox', { name: '실행할 내용', exact: true }).fill(revised);
      await edit.getByRole('button', { name: '저장', exact: true }).click();
      await expect(edit).toHaveCount(0);
      await expect(page.getByRole('article').filter({ hasText: revised })).toContainText('35분마다');
      expect((await storedState(page)).schedules.find(schedule => schedule.prompt === revised)?.spec)
        .toEqual({ kind: 'every', seconds: 2100, startAt });
    } finally {
      const saved = (await storedState(page)).schedules.find(schedule => schedule.prompt === original || schedule.prompt === revised);
      if (saved) await send(page, { type: 'schedule.delete', scheduleId: saved.id });
    }
  });

  test('retains real skipped source history after deleting its activity and reloading', async ({ page }) => {
    let polls = 0;
    const source = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'token synthetic-archive-token') {
        response.writeHead(401).end(JSON.stringify({ message: 'Missing source credential' }));
      } else if (url.pathname === '/api/v1/repos/garden/ghost/pulls') {
        polls++;
        response.end('[]');
      } else response.writeHead(404).end(JSON.stringify({ message: 'Unknown source endpoint' }));
    });
    const listening = Promise.withResolvers<void>();
    source.once('error', listening.reject);
    source.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    try {
      const address = source.address();
      if (!address || typeof address === 'string') throw new Error('source server did not bind');
      const connectionId = String((await send(page, { type: 'connection.upsert', name: 'Archive source account',
        credential: 'synthetic-archive-token', config: { kind: 'gitea', baseUrl: `http://127.0.0.1:${address.port}/api/v1` } })).connectionId);
      connections.push(connectionId);
      const ghostId = String((await send(page, { type: 'ghost.create', name: 'Archive Ghost', persona: '', tools: ['read'] })).ghostId);
      ghosts.push(ghostId);
      const config = { ...activityConfig(ghostId, {
        kind: 'pull_request', connectionId, repository: 'garden/ghost', baseBranch: null, labels: [],
        includeDrafts: false, includeExisting: true, pollSeconds: 86400,
      }), name: 'Archive source activity' };
      const activityId = String((await send(page, { type: 'activity.create', config })).activityId);
      activities.push(activityId);
      await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=activities`);
      await page.getByRole('button', { name: 'Archive source activity 지금 실행', exact: true }).click();
      await expect.poll(async () => (await storedState(page)).activityRuns.some(run =>
        run.activityId === activityId && run.state === 'skipped')).toBe(true);
      const run = (await storedState(page)).activityRuns.find(run => run.activityId === activityId && run.state === 'skipped')!;
      expect(polls).toBeGreaterThan(0);
      expect(run.workId).toBeNull();
      expect(run.reason).toBe('No matching source item; no model was started.');
      await page.getByRole('button', { name: 'Archive source activity 삭제', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '활동 삭제', exact: true });
      await dialog.getByRole('button', { name: '삭제', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      activities.splice(activities.indexOf(activityId), 1);
      await page.reload();
      const history = page.getByRole('region', { name: '삭제된 활동 실행 기록', exact: true });
      await expect(history).toContainText(run.reason!);
      await expect(history).toContainText('건너뜀');
      await expect(history.locator('li').filter({ hasText: run.reason! }).getByRole('button', { name: '맡긴 일 열기', exact: true })).toHaveCount(0);
      const fresh = await storedState(page);
      expect(fresh.activities.some(activity => activity.id === activityId)).toBe(false);
      expect(fresh.activityRuns.find(item => item.id === run.id)).toMatchObject({ activityId, state: 'skipped', workId: null });
    } finally {
      const closed = Promise.withResolvers<void>();
      source.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    }
  });

  test('pages Work history and keeps a failed older-page request visible for retry', async ({ page }) => {
    const seeded = readRunState('activities');
    let olderAttempts = 0;
    await page.route('**/api/conversations/*?*', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('before') === 'older-history-fixture') {
        olderAttempts++;
        if (olderAttempts === 1) {
          await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Synthetic history unavailable' } } });
          return;
        }
        await route.fulfill({ json: {
          messages: [{
            id: 'older-history-message-fixture', conversationId: url.pathname.split('/').at(-1),
            role: 'note', origin: null, text: 'Synthetic older Work history',
            toolCalls: [], tool: null, attachments: [], createdAt: seeded.fixedNow - 3600_000,
          }], before: null, live: null,
        } });
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), before: 'older-history-fixture' } });
    });
    await page.goto(`${seeded.baseUrl}/#/work/${encodeURIComponent(seeded.workDoneId)}`);
    await page.getByRole('button', { name: '작업 대화', exact: true }).click();
    const transcript = page.locator('.work-transcript');
    await transcript.getByRole('button', { name: '이전 메시지', exact: true }).click();
    await expect(transcript.getByRole('alert')).toContainText('Synthetic history unavailable');
    await transcript.getByRole('button', { name: '이전 메시지', exact: true }).click();
    await expect(transcript).toContainText('Synthetic older Work history');
    await expect(transcript.getByRole('alert')).toHaveCount(0);
    await expect(transcript.getByRole('button', { name: '이전 메시지', exact: true })).toHaveCount(0);
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
    await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=activities`);
    await page.getByRole('button', { name: 'Precise activity 편집', exact: true }).click();
    const editor = page.getByRole('form', { name: '활동 편집', exact: true });
    await expect(editor.getByRole('combobox', { name: 'Ghost', exact: true })).toBeDisabled();
    await editor.getByRole('textbox', { name: '이름', exact: true }).fill('Renamed precise schedule');
    await editor.getByRole('button', { name: '저장', exact: true }).click();
    await expect(editor).toHaveCount(0);
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
      await page.goto(`${readRunState('activities').baseUrl}/#/settings?tab=activities`);
      await page.getByRole('button', { name: 'Precise activity 편집', exact: true }).click();
      const editor = page.getByRole('form', { name: '활동 편집', exact: true });
      await editor.getByRole('textbox', { name: '이름', exact: true }).fill('Renamed source');
      await editor.getByRole('button', { name: '저장', exact: true }).click();
      await expect(editor).toHaveCount(0);
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
