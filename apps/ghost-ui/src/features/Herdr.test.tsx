import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HerdrPaneView } from '@ghost/contract';
import { groupHerdrPanes, HerdrPaneBody, HerdrRoster } from './Herdr';
import { codingStartInput } from './HerdrStart';
import { codeRunPane, herdrPanePath, parseHerdrPane } from './herdrDisplay';

const pane: HerdrPaneView = {
  id: 'w1:pA', workspace: 'ghost', tab: 'login', agent: 'Claude Code', status: 'blocked', cwd: '/work/tree', title: '로그인 고치기',
};

describe('herdr address', () => {
  it('round-trips a pane id through the query, colon and all', () => {
    const path = herdrPanePath(pane.id);
    expect(path).toBe('/coding?herdr=w1%3ApA');
    expect(parseHerdrPane(new URL(path, 'https://example.test').searchParams.get('herdr'))).toBe('w1:pA');
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
});

describe('herdr roster', () => {
  it('groups interleaved panes by workspace id in sidebar order, even when labels match', () => {
    const anotherWorkspace = { ...pane, id: 'w2:pA' };
    const anotherPane = { ...pane, id: 'w1:pB' };
    expect(groupHerdrPanes([pane, anotherWorkspace, anotherPane])).toEqual([
      { id: 'w1', workspace: 'ghost', panes: [pane, anotherPane] },
      { id: 'w2', workspace: 'ghost', panes: [anotherWorkspace] },
    ]);
    expect(groupHerdrPanes([])).toEqual([]);
  });

  it('names the group, shows the agent state and marks only the selected link', () => {
    const markup = renderToStaticMarkup(<HerdrRoster panes={[pane, { ...pane, id: 'w1:pB', status: 'working' }]} selected={pane.id}/>);
    expect(markup).toContain('<h2>ghost</h2>');
    expect(markup).toContain('입력 필요');
    expect(markup).toContain('작업 중');
    expect(markup).toContain('href="#/coding?herdr=w1%3ApA" aria-current="page"');
    expect(markup.match(/aria-current=/g)).toHaveLength(1);
  });
});

describe('herdr pane', () => {
  const body = (status: HerdrPaneView['status'], pending?: boolean) => renderToStaticMarkup(<HerdrPaneBody
    pane={{ ...pane, status }} pending={pending} text={'<b>$ bun test</b>\n3 pass'} onPrompt={async () => true} onKey={() => {}}/>);

  it('escapes terminal text and exposes the pane context, not an editable terminal', () => {
    const markup = body('blocked');
    expect(markup).toMatch(/<pre[^>]*aria-label="터미널 출력"[^>]*>&lt;b&gt;\$ bun test&lt;\/b&gt;\n3 pass<\/pre>/);
    expect(markup).not.toContain('<b>$ bun test');
    expect(markup).not.toContain('contenteditable');
    expect(markup).toContain('/work/tree');
    expect(markup).toContain('Claude Code');
  });

  it.each([['blocked', true], ['working', true], ['done', false], ['idle', false], ['unknown', false]] as const)
  ('renders the right composer and key controls for %s', (status, disabled) => {
    const markup = body(status);
    expect(markup).toContain('aria-label="중단 (Esc)"');
    expect(markup.includes('aria-label="승인 응답 키"')).toBe(status === 'blocked');
    expect(markup.match(/<textarea[^>]+>/)?.[0].includes('disabled=""')).toBe(disabled);
  });

  it('provides the approval keys, but disables them and the composer during an input request', () => {
    const markup = body('blocked', true);
    const keys = markup.match(/aria-label="승인 응답 키">(.*?)<\/div>/)?.[1] ?? '';
    expect(keys.match(/disabled=""/g)).toHaveLength(8);
    for (const label of ['Enter', '↑', '↓', 'Y', 'N', '1', '2', '3']) expect(keys).toContain(`>${label}</button>`);
    expect(body('idle', true).match(/<textarea[^>]+>/)?.[0]).toContain('disabled=""');
  });
});

it('starts with the chosen agent, multiline task and a branch only when using a worktree', () => {
  const fields = new FormData();
  fields.set('repo', ' /Projects/ghost ');
  fields.set('task', ' 첫 줄\n둘째 줄 ');
  fields.set('worktree', 'on');
  fields.set('branch', ' fix/login ');
  expect(codingStartInput(fields, 'claude')).toEqual({
    agent: 'claude', repo: '/Projects/ghost', task: '첫 줄\n둘째 줄', worktree: true, branch: 'fix/login',
  });
  fields.delete('worktree');
  expect(codingStartInput(fields, 'claude')).toEqual({
    agent: 'claude', repo: '/Projects/ghost', task: '첫 줄\n둘째 줄', worktree: false,
  });
});
