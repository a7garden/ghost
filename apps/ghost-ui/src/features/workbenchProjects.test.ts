import { describe, expect, it } from 'vitest';
import type { CodingSession, Scope } from '@ghost/contract';
import { projectAgents } from './workbenchProjects';

const scope = (id: string, paths: string[]) => ({ id, name: id, paths }) as Scope;
const session = (id: string, fields: Partial<CodingSession> = {}) => ({
  id, title: id, state: 'idle', cwd: '/tmp', repo: null, branch: null, ghostId: null, workId: null, updatedAt: 1, ...fields,
}) as CodingSession;

describe('project agents', () => {
  const scopes = [scope('app', ['/work/app']), scope('site', ['/work/site'])];

  it('keeps listed agents in order and moves an agent of a deleted project to 프로젝트 없음', () => {
    const sessions = new Map([['a', session('a')], ['b', session('b')]]);
    const rows = projectAgents([{ sessionId: 'a', scopeId: 'app' }, { sessionId: 'b', scopeId: 'gone' }], sessions, new Map(), scopes);
    expect(rows.map(row => [row.sessionId, row.scopeId, row.listed])).toEqual([['a', 'app', true], ['b', null, true]]);
  });

  it('places a Ghost’s session by its Work, else by the folder it works in', () => {
    const sessions = new Map([
      ['by-work', session('by-work', { ghostId: 'g1', workId: 'w1', cwd: '/elsewhere', updatedAt: 3 })],
      ['by-path', session('by-path', { ghostId: 'g2', repo: '/work/site', cwd: '/state/worktree', updatedAt: 2 })],
      ['loose', session('loose', { ghostId: 'g2', cwd: '/nowhere', updatedAt: 1 })],
      ['owner', session('owner')],
    ]);
    const rows = projectAgents([], sessions, new Map([['w1', { scopeId: 'app' }]]), scopes);
    expect(rows.map(row => [row.sessionId, row.scopeId, row.ghostId])).toEqual([['by-work', 'app', 'g1'], ['by-path', 'site', 'g2'], ['loose', null, 'g2']]);
  });

  it('does not list a Ghost session twice once the owner pinned it', () => {
    const sessions = new Map([['g', session('g', { ghostId: 'g1' })]]);
    const rows = projectAgents([{ sessionId: 'g', scopeId: 'site' }], sessions, new Map(), scopes);
    expect(rows).toEqual([{ sessionId: 'g', scopeId: 'site', ghostId: 'g1', listed: true }]);
  });
});
