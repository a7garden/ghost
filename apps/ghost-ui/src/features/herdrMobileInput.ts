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

export function shellCommand(draft: string): string {
  return `${draft}\r`;
}

export const extendedTerminalKeys = [
  { label: '⇧Tab', name: 'Shift+Tab', text: '\x1b[Z' },
  { label: 'PgUp', name: 'Page Up', text: '\x1b[5~' },
  { label: 'PgDn', name: 'Page Down', text: '\x1b[6~' },
  { label: 'Home', name: 'Home', text: '\x1b[H' },
  { label: 'End', name: 'End', text: '\x1b[F' },
  { label: 'Ctrl+D', name: 'Ctrl+D', text: '\x04' },
  { label: 'Ctrl+L', name: 'Ctrl+L', text: '\x0c' },
] as const;
