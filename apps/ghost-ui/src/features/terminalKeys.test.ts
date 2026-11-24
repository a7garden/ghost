import { expect, it } from 'vitest';
import { controlRailKey, isHistoryPageKey, modifiedTerminalKey } from './terminalKeys';

it('reserves Shift+PageUp while live and both page keys in history', () => {
  expect(isHistoryPageKey('PageUp', true, false)).toBe(true);
  expect(isHistoryPageKey('PageUp', false, false)).toBe(false);
  expect(isHistoryPageKey('PageDown', true, false)).toBe(false);
  expect(isHistoryPageKey('PageDown', false, true)).toBe(true);
  expect(isHistoryPageKey('PageUp', false, true)).toBe(true);
  expect(isHistoryPageKey('ArrowUp', true, true)).toBe(false);
});

it('uses terminal cursor mode for rail bytes', () => {
  expect(controlRailKey('up', true)).toBe('\x1bOA');
  expect(controlRailKey('up', false)).toBe('\x1b[A');
  expect(controlRailKey('ctrl+c', true)).toBe('\x03');
});

it('maps one sticky printable terminal key without consuming Korean or pasted strings', () => {
  expect(modifiedTerminalKey('d', { ctrl: true, alt: false })).toBe('\x04');
  expect(modifiedTerminalKey('[', { ctrl: true, alt: false })).toBe('\x1b');
  expect(modifiedTerminalKey('k', { ctrl: false, alt: true })).toBe('\x1bk');
  expect(modifiedTerminalKey('C', { ctrl: true, alt: true })).toBe('\x1b\x03');
  for (const text of ['가', 'pwd', '\x1b[A', 'ArrowUp', '😀']) expect(modifiedTerminalKey(text, { ctrl: true, alt: true })).toBeNull();
});
