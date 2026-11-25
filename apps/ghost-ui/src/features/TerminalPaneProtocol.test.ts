import { expect, it } from 'vitest';
import { TerminalWire, terminalInput } from './TerminalPaneProtocol';

const size = { cols: 80, rows: 24 };
const ready = (offset: number, reset: boolean) => JSON.stringify({ type: 'ready', offset, reset, ...size });
const done = JSON.stringify({ type: 'replay-end' });
const output = new TextEncoder().encode('한글').buffer;

it('paints binary frames in order, resumes at the byte cursor and exits only after replay', () => {
  const calls: unknown[] = [];
  const wire = new TerminalWire({
    ready: (dimensions, reset) => calls.push({ dimensions, reset }),
    bytes: bytes => calls.push(new TextDecoder().decode(bytes)),
    live: () => calls.push('live'),
    exit: code => calls.push({ code }),
  });
  expect(wire.receive(output)).toBe(false);
  expect(wire.receive(ready(11, true))).toBe(true);
  expect(wire.receive(output)).toBe(true);
  expect(wire.receive(done)).toBe(true);
  expect(wire.offset).toBe(17);
  wire.reconnect();
  expect(wire.receive(ready(18, false))).toBe(false);
  expect(wire.receive(ready(17, false))).toBe(true);
  expect(wire.receive(done)).toBe(true);
  expect(wire.receive(JSON.stringify({ type: 'exit', code: 7 }))).toBe(true);
  expect(wire.receive(output)).toBe(false);
  expect(calls).toEqual([{ dimensions: size, reset: true }, '한글', 'live', { dimensions: size, reset: false }, 'live', { code: 7 }]);
});

it('rejects malformed or out-of-order controls and allows the Host to reset a stale cursor', () => {
  const resetFlags: boolean[] = [];
  const wire = new TerminalWire({ ready: (_size, reset) => resetFlags.push(reset), bytes() {}, live() {}, exit() {} });
  expect(wire.receive('not json')).toBe(false);
  expect(wire.receive('{"type":"ready","offset":-1,"reset":true,"cols":80,"rows":24}')).toBe(false);
  expect(wire.receive(done)).toBe(false);
  expect(wire.receive(ready(0, true))).toBe(true);
  expect(wire.receive(ready(10, true))).toBe(false);
  expect(wire.receive(JSON.stringify({ type: 'exit', code: null }))).toBe(false);
  wire.reconnect();
  expect(wire.receive(ready(512, true))).toBe(true);
  expect(wire.offset).toBe(512);
  expect(resetFlags).toEqual([true, true]);
});

it('chunks paste without splitting a surrogate pair, preserves binary input, and leaves nothing queued', () => {
  const prefix = 'a'.repeat(65_535);
  expect([...terminalInput(`${prefix}🖥\rtail`)]).toEqual([{ type: 'input', data: prefix }, { type: 'input', data: '🖥\rtail' }]);
  expect([...terminalInput('\u008f\x03', true)]).toEqual([{ type: 'input', data: '\u008f\x03', binary: true }]);
  expect([...terminalInput('')]).toEqual([]);
});
