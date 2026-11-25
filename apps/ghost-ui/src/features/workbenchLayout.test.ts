import { describe, expect, it } from 'vitest';
import { close, emptyLayout, LAUNCH, MAX_PANES, prune, resize, show, split } from './workbenchLayout';

describe('workbench layout', () => {
  it('replaces the active pane, or activates the pane already showing the agent', () => {
    const two = split(show(emptyLayout, 'a'), 'b');
    expect(two).toEqual({ panes: ['a', 'b'], sizes: [0.5, 0.5], active: 1 });
    expect(show(two, 'a')).toEqual({ ...two, active: 0 });
    expect(show(two, 'c')).toEqual({ ...two, panes: ['a', 'c'] });
  });

  it('splits beside the active pane and reuses the neighbour at the limit', () => {
    let layout = split(split(show(emptyLayout, 'a'), 'b'), 'c');
    expect(layout.panes).toHaveLength(MAX_PANES);
    layout = { ...layout, active: 0 };
    layout = split(layout, 'd');
    expect(layout).toMatchObject({ panes: ['a', 'd', 'c'], active: 1 });
  });

  it('gives a closed pane’s width to the rest and keeps the active agent', () => {
    const layout = { panes: ['a', 'b', 'c'], sizes: [0.5, 0.25, 0.25], active: 2 };
    const next = close(layout, 0);
    expect(next.panes).toEqual(['b', 'c']);
    expect(next.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
    expect(next.panes[next.active]).toBe('c');
    expect(close({ panes: ['a'], sizes: [1], active: 0 }, 0)).toEqual(emptyLayout);
  });

  it('never resizes a pane below a usable width', () => {
    const layout = { panes: ['a', 'b'], sizes: [0.5, 0.5], active: 0 };
    const widened = resize(layout, 0, 0.9).sizes;
    expect(widened[0]).toBeCloseTo(0.8);
    expect(widened[1]).toBeCloseTo(0.2);
    expect(resize(layout, 0, -0.9).sizes[0]).toBeCloseTo(0.2);
    expect(resize(layout, 1, 0.1)).toBe(layout);
  });

  it('drops panes whose agent is gone but keeps the launch pad', () => {
    const layout = { panes: ['a', LAUNCH, 'gone'], sizes: [0.4, 0.3, 0.3], active: 2 };
    const next = prune(layout, id => id === 'a');
    expect(next.panes).toEqual(['a', LAUNCH]);
    expect(next.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });
});
