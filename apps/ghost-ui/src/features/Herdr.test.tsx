import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HerdrPaneView, HerdrWorkspaceView } from '@ghost/contract';
import { HerdrPaneBody } from './Herdr';
import { HerdrDiffText } from './HerdrChanges';
import { HerdrPaneHeader } from './HerdrPaneHeader';
import { findHerdrPane, herdrNodeActions, HerdrRoster } from './HerdrRoster';
import { herdrAgentOptions, workspaceInput } from './HerdrStart';
import { codeRunPane, codeRunReceiptRun, herdrPanePath, parseHerdrPane, parseHerdrSession } from './herdrDisplay';
import { decodeHerdrFrame, HerdrInputQueue } from './herdrTerminalProtocol';

const pane: HerdrPaneView = {
  id: 'w1:pA', workspaceId: 'w1', tabId: 'w1:t1', workspace: 'ghost', tab: 'login', agent: 'Claude Code',
  status: 'blocked', cwd: '/work/tree', title: '로그인 고치기', focused: true, owned: false,
};

describe('herdr address', () => {
  it('round-trips a pane id through the query, colon and all', () => {
    const path = herdrPanePath(pane.id);
    expect(path).toBe('/coding?herdr=w1%3ApA');
    expect(parseHerdrPane(new URL(path, 'https://example.test').searchParams.get('herdr'))).toBe('w1:pA');
  });

  it('carries the session a pane id belongs to, and never one it cannot be', () => {
    const path = herdrPanePath(pane.id, 'work-laptop');
    expect(path).toBe('/coding?herdr=w1%3ApA&herdrSession=work-laptop');
    const params = new URL(path, 'https://example.test').searchParams;
    expect(parseHerdrSession(params.get('herdrSession'))).toBe('work-laptop');
    expect(parseHerdrSession(null)).toBeNull();
    for (const invalid of ['', 'w1:pA', 'has space', '../escape']) expect(parseHerdrSession(invalid)).toBeNull();
  });

  it.each([null, '', 'w1', 'w1%3ApA', 'default/w1:pA', 'w1:pA:1', 'w1:pA&new=1'])('rejects an invalid pane address: %s', invalid => {
    expect(parseHerdrPane(invalid)).toBeNull();
  });

  it('links only a valid pane explicitly returned in a tool result', () => {
    expect(codeRunPane('{"pane":"w1:pA","status":"blocked"}')).toBe('w1:pA');
    for (const result of [null, 'not JSON', 'null', '{"id":"w1:pA"}', '{"pane":"https://example.test"}']) {
      expect(codeRunPane(result)).toBeNull();
    }
  });

  it('reads the run an asynchronous code_run receipt names, and nothing else', () => {
    expect(codeRunReceiptRun('{"runId":"run-7","turn":2}')).toBe('run-7');
    for (const result of [null, 'not JSON', 'null', '{}', '{"runId":""}', '{"runId":7}']) {
      expect(codeRunReceiptRun(result)).toBeNull();
    }
  });
});

const shell = { ...pane, id: 'w1:pB', title: 'zsh', agent: null, status: 'unknown' } satisfies HerdrPaneView;
const workspaces: HerdrWorkspaceView[] = [{
  id: 'w1', label: 'ghost', status: 'blocked', worktree: { path: '/work/tree', branch: 'fix/login' },
  tabs: [{ id: 'w1:t1', label: 'login', status: 'blocked', panes: [pane, shell] }],
}];

describe('herdr roster', () => {
  it('finds a pane in nested tabs by id, including a plain shell', () => {
    expect(findHerdrPane(workspaces, shell.id)).toBe(shell);
    expect(findHerdrPane(workspaces, 'w1:pC')).toBeUndefined();
  });

  it('offers only the available operations at each level', () => {
    const forNode = (target: 'workspace' | 'tab' | 'pane', shell = false) =>
      herdrNodeActions({ id: 'id', label: 'name', target }, { splitPane: 'w1:pA', shell });
    expect(forNode('workspace').map(action => action.kind)).toEqual(['tab', 'rename', 'close']);
    expect(forNode('tab')).toMatchObject([{ direction: 'right', pane: 'w1:pA' }, { direction: 'down', pane: 'w1:pA' }, { kind: 'rename' }, { kind: 'close' }]);
    expect(forNode('pane').map(action => action.kind)).toEqual(['close']);
    expect(forNode('pane', true).map(action => action.kind)).toEqual(['agent', 'close']);
  });

  it('names the group, shows the agent state and marks only the selected link', () => {
    const markup = renderToStaticMarkup(<HerdrRoster workspaces={workspaces} selected={pane.id} onAction={() => {}}/>);
    expect(markup).toContain('<h2>ghost</h2>');
    expect(markup).toContain('fix/login');
    expect(markup).toContain('탭 · login');
    expect(markup).toContain('zsh');
    expect(markup).toContain('입력 필요');
    expect(markup).toContain('href="#/coding?herdr=w1%3ApA" aria-current="page"');
    expect(markup.match(/aria-current=/g)).toHaveLength(1);
  });
});

describe('herdr pane', () => {
  const body = (status: HerdrPaneView['status'], pending?: boolean, compact = false, agent = pane.agent) => renderToStaticMarkup(<HerdrPaneBody
    pane={{ ...pane, status, agent }} pending={pending} compact={compact} mode="live" onMode={() => {}}
    screen={<HerdrDiffText value={'@@ -0 +1 @@\n+<b>$ bun test</b>'} wrap={false}/>} onPrompt={async () => true} onKey={() => {}}/>);

  it('escapes diffs as text and keeps the pane context', () => {
    const markup = body('blocked');
    expect(markup).toContain('data-kind="addition">+&lt;b&gt;$ bun test&lt;/b&gt;');
    expect(markup).not.toContain('<b>$ bun test');
    expect(markup).not.toContain('contenteditable');
    expect(markup).toContain('/work/tree');
    expect(markup).toContain('Claude Code');
  });

  it.each([['blocked', true], ['working', true], ['done', false], ['idle', false], ['unknown', false]] as const)
  ('renders the right composer and key controls for %s', (status, disabled) => {
    const markup = body(status);
    expect(markup).toContain('aria-label="중단 (Esc)"');
    expect(markup.includes('aria-label="터미널 키"')).toBe(status === 'blocked');
    expect(markup.match(/<textarea[^>]+>/)?.[0].includes('disabled=""')).toBe(disabled);
  });

  it('groups the touch keys into one accessory strip that leads with the everyday keys', () => {
    const markup = body('idle', false, true, null);
    const keys = markup.slice(markup.indexOf('aria-label="터미널 키"'), markup.indexOf('aria-label="셸 명령"'));
    for (const group of ['이동', '동작', '조합', '추가 이동']) expect(keys).toContain(`aria-label="${group}"`);
    expect(keys.indexOf('>←</button>')).toBeLessThan(keys.indexOf('aria-label="중단 (Esc)"'));
    expect(keys.indexOf('aria-label="중단 (Esc)"')).toBeLessThan(keys.indexOf('aria-label="Home"'));
    for (const label of ['Esc', 'Tab', '↑', '↓', '←', '→', 'Enter', 'Ctrl+C']) expect(keys).toContain(`>${label}</button>`);
    expect(keys).toContain('class="herdr-key"');
    expect(markup).toContain('aria-label="키보드 닫기"');
    expect(markup).toContain('aria-label="Shift+Tab"');
    expect(markup).toContain('aria-label="셸 명령"');
    expect(markup).not.toContain('후속 지시');
    expect(body('idle', true).match(/<textarea[^>]+>/)?.[0]).toContain('disabled=""');
  });
});

describe('the coding agent\'s 맡긴 일 link', () => {
  const header = (codingWorkId?: string) => renderToStaticMarkup(<HerdrPaneHeader
    pane={{ ...pane, ...(codingWorkId ? { codingWorkId } : {}) }} mode="live" onMode={() => {}}
    compact={false} chat={false} changes={false} fontSize={13} onFontSize={() => {}}/>);

  it('links a pane a coding run owns to the 맡긴 일 that owns it', () => {
    const markup = header('work-1');
    expect(markup).toContain('href="#/work/work-1"');
    expect(markup).toContain('>맡긴 일</a>');
  });

  it('shows no Work link on a pane no coding run owns', () => {
    expect(header()).not.toContain('#/work/');
  });
});

it('starts with the chosen agent, multiline task and a branch only when using a worktree', () => {
  const fields = new FormData();
  fields.set('cwd', ' /Projects/ghost ');
  fields.set('task', ' 첫 줄\n둘째 줄 ');
  expect(workspaceInput(fields, 'pi', { worktree: true, label: ' 새 작업 ', branch: ' fix/login ' })).toEqual({
    agent: 'pi', cwd: '/Projects/ghost', label: '새 작업', task: '첫 줄\n둘째 줄', worktree: true, branch: 'fix/login',
  });
  expect(workspaceInput(fields, undefined, { worktree: false, label: '새 작업', branch: 'fix/login' })).toEqual({
    cwd: '/Projects/ghost', label: '새 작업', worktree: false,
  });
});

it('offers only installed herdr agent kinds, labelled, without unavailable fillers', () => {
  expect(herdrAgentOptions(['claude', 'pi'])).toEqual([
    { value: 'claude', label: 'Claude Code' }, { value: 'pi', label: 'Pi' },
  ]);
});

it('decodes base64 into exact ANSI and UTF-8 bytes, without treating the bytes as Latin-1 text', () => {
  const sample = '\x1b[32m안녕\x1b[0m\r\n';
  expect(new TextDecoder().decode(decodeHerdrFrame(Buffer.from(sample).toString('base64')))).toBe(sample);
});

it('coalesces waiting text without reordering control keys or a submitted prompt', async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const sent: unknown[] = [];
  const queue = new HerdrInputQueue(async data => {
    sent.push(data);
    if (sent.length === 1) await promise;
  }, error => { throw error; });
  queue.text('a');
  queue.text('\x1b[B');
  queue.text('\r');
  queue.key('ctrl+c');
  queue.text('b');
  queue.text('c');
  const prompt = queue.afterInput(async () => { sent.push('prompt'); return true; });
  expect(sent).toEqual([{ text: 'a' }]);
  resolve();
  await expect(prompt).resolves.toBe(true);
  expect(sent).toEqual([{ text: 'a' }, { text: '\x1b[B\r' }, { keys: ['ctrl+c'] }, { text: 'bc' }, 'prompt']);
});

it('does not send a queued Enter after ambiguous failure, or pending input after closing', async () => {
  const { promise, reject } = Promise.withResolvers<void>();
  const { promise: reported, resolve: report } = Promise.withResolvers<unknown>();
  const sent: unknown[] = [];
  const queue = new HerdrInputQueue(async data => { sent.push(data); await promise; }, report);
  queue.text('command');
  queue.key('enter');
  reject(new Error('lost'));
  await expect(reported).resolves.toMatchObject({ message: 'lost' });
  expect(sent).toEqual([{ text: 'command' }]);
  queue.close();
  queue.key('enter');
  await expect(queue.afterInput(async () => true)).resolves.toBe(false);
  expect(sent).toHaveLength(1);
});
