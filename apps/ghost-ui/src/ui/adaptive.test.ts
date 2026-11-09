import type { KeyboardEvent } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { blurTouchSearchOnEnter } from './adaptive';

afterEach(() => vi.unstubAllGlobals());

it('dismisses only a coarse-pointer search submitted with Enter', () => {
  let coarse = false;
  vi.stubGlobal('matchMedia', () => ({ matches: coarse }));
  const blur = vi.fn();
  const event = { key: 'Enter', currentTarget: { blur } } as unknown as KeyboardEvent<HTMLInputElement>;
  blurTouchSearchOnEnter(event);
  expect(blur).not.toHaveBeenCalled();
  coarse = true;
  blurTouchSearchOnEnter({ ...event, key: 'Escape' });
  expect(blur).not.toHaveBeenCalled();
  blurTouchSearchOnEnter(event);
  expect(blur).toHaveBeenCalledOnce();
});
