import { useState } from 'react';
import * as KeyPopover from '@radix-ui/react-popover';
import { Ellipsis, KeyboardOff, Type } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { extendedTerminalKeys, type TerminalModifiers } from './terminalKeys';

const primary = [
  ['esc', 'Esc', '중단 (Esc)'], ['tab', 'Tab', 'Tab'], ['up', '↑', '위쪽 화살표'],
  ['down', '↓', '아래쪽 화살표'], ['enter', 'Enter', 'Enter'],
] as const;
const lateral = [['left', '←', '왼쪽 화살표'], ['right', '→', '오른쪽 화살표']] as const;
const symbols = ['|', '~', '/', '-'] as const;

export function TerminalKeyRail({ modifiers, onModifier, onKey, onText, onPageUp, onDismiss }: {
  modifiers: TerminalModifiers; onModifier(key: keyof TerminalModifiers): void;
  onKey(key: string): void; onText(text: string): void; onPageUp(text: string): void; onDismiss(): void;
}) {
  const [open, setOpen] = useState(false);
  const chord = [modifiers.ctrl && 'Ctrl', modifiers.alt && 'Alt'].filter(Boolean).join('+');
  return <div className="terminal-keypad" role="group" aria-label="터미널 키" onPointerDown={event => {
    if ((event.target as HTMLElement).closest('button') && document.activeElement instanceof HTMLTextAreaElement) event.preventDefault();
  }}>
    {primary.map(([key, label, name]) => <button type="button" key={key} className="terminal-key" aria-label={name}
      onClick={() => onKey(key)}>{label}</button>)}
    {/* A nonmodal keypad keeps the software keyboard and terminal geometry intact. */}
    <KeyPopover.Root open={open} onOpenChange={setOpen}>
      <KeyPopover.Trigger asChild><button type="button" className="terminal-key terminal-more" aria-label="추가 키"
        aria-description={chord ? `${chord} 조합 대기` : undefined} data-armed={chord ? '' : undefined}>
        {chord || <Ellipsis size={18} aria-hidden="true"/>}
      </button></KeyPopover.Trigger>
      <KeyPopover.Content className="terminal-key-palette" aria-label="추가 키" side="top" align="end" sideOffset={6} collisionPadding={8}
        onOpenAutoFocus={event => { if (document.activeElement instanceof HTMLTextAreaElement) event.preventDefault(); }}
        onCloseAutoFocus={event => { if (document.activeElement instanceof HTMLTextAreaElement) event.preventDefault(); }}
        onClick={event => { if ((event.target as Element).closest('button')) setOpen(false); }}>
        {lateral.map(([key, label, name]) => <button key={key} type="button" className="terminal-key" aria-label={name}
          onClick={() => onKey(key)}>{label}</button>)}
        {extendedTerminalKeys.map(key => <button key={key.name} type="button" className="terminal-key" aria-label={key.name}
          onClick={() => (key.name === 'Page Up' ? onPageUp : onText)(key.text)}>{key.label}</button>)}
        <button type="button" className="terminal-key" onClick={() => onKey('ctrl+c')}>Ctrl+C</button>
        {(['ctrl', 'alt'] as const).map(key => <button key={key} type="button" className="terminal-key" aria-pressed={modifiers[key]}
          onClick={() => onModifier(key)}>{key === 'ctrl' ? 'Ctrl' : 'Alt'}</button>)}
        {symbols.map(key => <button key={key} type="button" className="terminal-key" onClick={() => onText(key)}>{key}</button>)}
        <button type="button" className="terminal-key terminal-keyboard-dismiss" onClick={onDismiss}>
          <KeyboardOff size={16} aria-hidden="true"/>키보드 닫기
        </button>
      </KeyPopover.Content>
    </KeyPopover.Root>
  </div>;
}

const terminalSizes = [11, 13, 15, 17] as const;
const terminalSizeKey = 'ghost.coding.terminal-font-size';
export function readTerminalSize(): number {
  try {
    const saved = localStorage.getItem(terminalSizeKey);
    return terminalSizes.find(size => String(size) === saved) ?? 13;
  }
  catch { return 13; }
}
export function TerminalTextSize({ size, onSize }: { size: number; onSize(size: number): void }) {
  const index = terminalSizes.findIndex(value => value === size);
  function change(step: number) {
    const next = terminalSizes[index + step];
    if (next === undefined) return;
    onSize(next);
    try { localStorage.setItem(terminalSizeKey, String(next)); }
    catch { /* Storage can be unavailable. */ }
  }
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label="터미널 글자 크기" title="글자 크기"><Type aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent className="terminal-type-menu" align="end" collisionPadding={12} aria-label="터미널 글자 크기">
      <Button type="button" variant="ghost" aria-label="글자 작게" disabled={index <= 0} onClick={() => change(-1)}>A−</Button>
      <output>{size}px</output>
      <Button type="button" variant="ghost" aria-label="글자 크게" disabled={index >= terminalSizes.length - 1} onClick={() => change(1)}>A+</Button>
    </PopoverContent>
  </Popover>;
}
