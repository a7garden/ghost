// Shortcut labels follow the platform: the production app runs on macOS, development also on Windows.
// Showing ⌘ on Windows sends the owner looking for a key that does not exist.
const platform = typeof navigator === 'undefined' ? '' : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '');

export const isMac = /mac|iphone|ipad/i.test(platform);

/** The primary modifier as the owner's keyboard prints it. */
export const modKey = isMac ? '⌘' : 'Ctrl';

/** A shortcut label for titles and hints, e.g. `shortcut('K')` → "⌘K" or "Ctrl+K". */
export function shortcut(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}
