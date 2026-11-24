export type TerminalModifiers = { ctrl: boolean; alt: boolean };
export const noModifiers: TerminalModifiers = { ctrl: false, alt: false };

/** Sticky modifiers affect one printable key, never a paste, IME composition or pre-encoded escape sequence. */
export function modifiedTerminalKey(value: string, { ctrl, alt }: TerminalModifiers): string | null {
  if ((!ctrl && !alt) || !/^[\x20-\x7e]$/.test(value)) return null;
  let key = value;
  if (ctrl) {
    if (/^[a-z@\[\\\]\^_]$/i.test(value)) key = String.fromCharCode(value.toUpperCase().charCodeAt(0) & 0x1f);
    else if (value === ' ') key = '\x00';
    else if (value === '?') key = '\x7f';
    else return null;
  }
  return alt ? `\x1b${key}` : key;
}

export const extendedTerminalKeys = [
  { label: 'Home', name: 'Home', text: '\x1b[H' },
  { label: 'End', name: 'End', text: '\x1b[F' },
  { label: 'PgUp', name: 'Page Up', text: '\x1b[5~' },
  { label: 'PgDn', name: 'Page Down', text: '\x1b[6~' },
  { label: '⇧Tab', name: 'Shift+Tab', text: '\x1b[Z' },
  { label: 'Ctrl+D', name: 'Ctrl+D', text: '\x04' },
  { label: 'Ctrl+L', name: 'Ctrl+L', text: '\x0c' },
] as const;

const controls: Record<string, string> = { esc: '\x1b', tab: '\t', enter: '\r', 'ctrl+c': '\x03' };
const arrows: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

export function controlRailKey(key: string, applicationCursorKeys: boolean): string | undefined {
  return controls[key] ?? (arrows[key] ? `\x1b${applicationCursorKeys ? 'O' : '['}${arrows[key]}` : undefined);
}

export function isHistoryPageKey(key: string, shift: boolean, scrolled: boolean): boolean {
  return scrolled ? key === 'PageUp' || key === 'PageDown' : shift && key === 'PageUp';
}
