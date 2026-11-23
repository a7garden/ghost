import { describe, expect, it } from 'vitest';
import type { HerdrPaneView, HerdrWorkspaceView } from '@ghost/contract';
import { recentCodingDirectories, startsCodingEntry } from './CodingModel';

const pane = (id: string, cwd: string, focused = false): HerdrPaneView => ({
  id, cwd, focused, workspaceId: 'w1', tabId: 'w1:t1', workspace: 'space', tab: 'tab', title: 'Agent', agent: 'omp', status: 'idle', owned: false,
});
const space = (panes: HerdrPaneView[], worktree: HerdrWorkspaceView['worktree'] = null): HerdrWorkspaceView => ({
  id: 'w1', label: 'space', status: 'idle', worktree, tabs: [{ id: 'w1:t1', label: 'tab', status: 'idle', panes }],
});

describe('Coding entry', () => {
  it('rearms from the browser route even if React has not yet left a pane', () => {
    const rendered = '/coding?herdr=w1%3Ap4';
    expect(startsCodingEntry(rendered, '/coding')).toBe(false); // Explicit back to the roster.
    expect(startsCodingEntry('/', '/coding')).toBe(true); // The Home hash arrived just before the Coding button.
    expect(startsCodingEntry('/ghosts/main', '/coding')).toBe(true);
    expect(startsCodingEntry('/', rendered)).toBe(false); // Preserve an explicit pane link.
    expect(startsCodingEntry('/', '/coding?new=1')).toBe(false);
  });
});

describe('recent Coding directories', () => {
  it('combines unique workspace directories and project paths, newest workspace activity first', () => {
    const paths = recentCodingDirectories([
      space([pane('w1:p1', '/repo/older', true), pane('w1:p2', '/repo/current/')]),
      space([pane('w1:p3', '/repo/current')]),
    ], [{ updatedAt: 800, paths: ['/repo/current', '/project/newer', 'relative'] }, { updatedAt: 30, paths: ['/project/older'] }], {
      'w1:p1': { openedAt: 500, changedAt: 300, status: 'idle' },
      'w1:p2': { openedAt: 400, changedAt: 130, status: 'idle' },
      'w1:p3': { openedAt: 300, changedAt: 600, status: 'idle' },
    });
    expect(paths).toEqual(['/repo/current', '/repo/older', '/project/newer', '/project/older']);
  });

  it('uses a known, unambiguous repo root for Herdr worktrees and keeps an unknown checkout verbatim', () => {
    const known = '/home/a/.herdr/worktrees/ghost/feature';
    const unknown = '/home/a/.herdr/worktrees/other/work';
    const spaces = [
      space([pane('w1:p1', `${known}/subdir`, true)], { path: known, branch: 'feature' }),
      space([pane('w1:p2', unknown)], { path: unknown, branch: 'work' }),
    ];
    expect(recentCodingDirectories(spaces, [{ updatedAt: 1, paths: ['/projects/ghost'] }], {})).toEqual(['/projects/ghost', unknown]);
    expect(recentCodingDirectories(spaces, [{ updatedAt: 1, paths: ['/projects/ghost', '/archive/ghost'] }], {}))
      .toEqual([known, unknown, '/projects/ghost', '/archive/ghost']);
  });

  it('caps the quick add at eight paths and uses the focus order when activity ties', () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/repo/${i}`);
    expect(recentCodingDirectories([space(paths.map((path, i) => pane(`w1:p${i}`, path, i === 9)))], [], {})).toEqual([paths[9], ...paths.slice(0, 7)]);
  });
});
