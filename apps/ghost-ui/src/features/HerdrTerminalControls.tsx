import { KeyboardOff, Type } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui';
import { extendedTerminalKeys, type TerminalModifiers } from './herdrMobileInput';
import { readCodingValue, writeCodingValue } from './herdrInboxModel';

const arrows = [
  { key: 'left', label: '←', name: '왼쪽 화살표' }, { key: 'up', label: '↑', name: '위쪽 화살표' },
  { key: 'down', label: '↓', name: '아래쪽 화살표' }, { key: 'right', label: '→', name: '오른쪽 화살표' },
] as const;
const acted = extendedTerminalKeys.filter(key => key.name === 'Shift+Tab' || key.name === 'Ctrl+D' || key.name === 'Ctrl+L');
const moved = extendedTerminalKeys.filter(key => key.name === 'Home' || key.name === 'End' || key.name === 'Page Up' || key.name === 'Page Down');
const symbols = ['|', '~', '/', '-'] as const;

/** One accessory strip beside the composer: the everyday keys lead, rarer moves and compositions trail. */
export function TerminalKeyRail({ compact, modifiers, onModifier, onKey, onText, onPageUp, onDismiss }: {
  compact: boolean; modifiers: TerminalModifiers; onModifier(key: keyof TerminalModifiers): void;
  onKey(key: string): void; onText(text: string): void; onPageUp(text: string): void; onDismiss(): void;
}) {
  return <div className="herdr-keypad" onPointerDown={event => {
    if ((event.target as HTMLElement).closest('button') && document.activeElement instanceof HTMLTextAreaElement) event.preventDefault();
  }}>
    <div className="herdr-keys" role="group" aria-label="터미널 키">
      <div className="herdr-keys-group" role="group" aria-label="이동">
        {arrows.map(key => <button key={key.key} type="button" className="herdr-key" aria-label={key.name}
          onClick={() => onKey(key.key)}>{key.label}</button>)}
      </div>
      <div className="herdr-keys-group" role="group" aria-label="동작">
        <button type="button" className="herdr-key" aria-label="중단 (Esc)" onClick={() => onKey('esc')}>Esc</button>
        <button type="button" className="herdr-key" onClick={() => onKey('tab')}>Tab</button>
        <button type="button" className="herdr-key" aria-label="Enter" onClick={() => onKey('enter')}>Enter</button>
        <button type="button" className="herdr-key" aria-label="Ctrl+C" onClick={() => onKey('ctrl+c')}>Ctrl+C</button>
        {acted.map(key => <button key={key.name} type="button" className="herdr-key" aria-label={key.name}
          onClick={() => onText(key.text)}>{key.label}</button>)}
      </div>
      <div className="herdr-keys-group" role="group" aria-label="조합">
        {(['ctrl', 'alt'] as const).map(key => <button key={key} type="button" className="herdr-key"
          aria-pressed={modifiers[key]} onClick={() => onModifier(key)}>{key === 'ctrl' ? 'Ctrl' : 'Alt'}</button>)}
        {symbols.map(key => <button key={key} type="button" className="herdr-key" onClick={() => onText(key)}>{key}</button>)}
      </div>
      <div className="herdr-keys-group" role="group" aria-label="추가 이동">
        {moved.map(key => <button key={key.name} type="button" className="herdr-key" aria-label={key.name}
          onClick={() => (key.name === 'Page Up' ? onPageUp : onText)(key.text)}>{key.label}</button>)}
      </div>
    </div>
    {compact && <button type="button" className="herdr-key herdr-keyboard-dismiss" aria-label="키보드 닫기" onClick={onDismiss}>
      <KeyboardOff aria-hidden="true"/>
    </button>}
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
