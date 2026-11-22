import { KeyboardOff, Type } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { extendedTerminalKeys, type TerminalModifiers } from './herdrMobileInput';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';

const keys = [
  { key: 'up', label: '↑', name: '위쪽 화살표' }, { key: 'down', label: '↓', name: '아래쪽 화살표' },
  { key: 'left', label: '←', name: '왼쪽 화살표' }, { key: 'right', label: '→', name: '오른쪽 화살표' },
  { key: 'enter', label: 'Enter', name: 'Enter' }, { key: 'ctrl+c', label: 'Ctrl+C', name: 'Ctrl+C' },
] as const;
const symbols = ['|', '~', '/', '-'] as const;

export function TerminalKeyRail({ compact, modifiers, onModifier, onKey, onText, onPageUp, onDismiss }: {
  compact: boolean; modifiers: TerminalModifiers; onModifier(key: keyof TerminalModifiers): void;
  onKey(key: string): void; onText(text: string): void; onPageUp(text: string): void; onDismiss(): void;
}) {
  return <div className="herdr-keypad" onPointerDown={event => {
    if ((event.target as HTMLElement).closest('button') && document.activeElement instanceof HTMLTextAreaElement) event.preventDefault();
  }}>
    <div className="herdr-keys" role="group" aria-label="터미널 키">
      <Button type="button" variant="outline" size="sm" aria-label="중단 (Esc)" onClick={() => onKey('esc')}>Esc</Button>
      <Button type="button" variant="outline" size="sm" onClick={() => onKey('tab')}>Tab</Button>
      {(['ctrl', 'alt'] as const).map(key => <Button key={key} type="button" variant="outline" size="sm" aria-pressed={modifiers[key]}
        className={modifiers[key] ? 'bg-signal-tint text-signal-ink hover:bg-signal-tint hover:text-signal-ink' : undefined}
        onClick={() => onModifier(key)}>{key === 'ctrl' ? 'Ctrl' : 'Alt'}</Button>)}
      {keys.map(key => <Button key={key.key} type="button" variant="outline" size="sm" aria-label={key.name} onClick={() => onKey(key.key)}>{key.label}</Button>)}
      {extendedTerminalKeys.map(key => <Button key={key.name} type="button" variant="outline" size="sm"
        aria-label={key.name} onClick={() => (key.name === 'Page Up' ? onPageUp : onText)(key.text)}>{key.label}</Button>)}
      {symbols.map(key => <Button key={key} type="button" variant="outline" size="sm" onClick={() => onText(key)}>{key}</Button>)}
    </div>
    {compact && <Button type="button" variant="ghost" size="icon" className="herdr-keyboard-dismiss" aria-label="키보드 닫기" onClick={onDismiss}>
      <KeyboardOff aria-hidden="true"/>
    </Button>}
  </div>;
}

const terminalSizes = [11, 13, 15, 17] as const;
const terminalSizeKey = 'terminal-font-size';
export const readTerminalSize = () => terminalSizes.find(size => String(size) === readCodingValue(terminalSizeKey)) ?? 13;
export function TerminalTextSize({ size, onSize }: { size: number; onSize(size: number): void }) {
  const index = terminalSizes.findIndex(value => value === size);
  function change(step: number) {
    const next = terminalSizes[index + step];
    if (next !== undefined) { onSize(next); writeCodingValue(terminalSizeKey, String(next)); }
  }
  return <Popover>
    <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon" aria-label="터미널 글자 크기"><Type aria-hidden="true"/></Button></PopoverTrigger>
    <PopoverContent className="herdr-type-menu" aria-label="터미널 글자 크기">
      <Button type="button" variant="ghost" aria-label="글자 작게" disabled={index <= 0} onClick={() => change(-1)}>A−</Button>
      <output>{size}px</output>
      <Button type="button" variant="ghost" aria-label="글자 크게" disabled={index >= terminalSizes.length - 1} onClick={() => change(1)}>A+</Button>
    </PopoverContent>
  </Popover>;
}
