import { describe, expect, it } from 'vitest';
import { dismissVersion, isVersionDismissed, loadDismissedVersions } from './dismissed';

const storage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
};

describe('dismissed update versions', () => {
  it('starts empty and ignores malformed or non-string data', () => {
    expect(loadDismissedVersions(storage())).toEqual([]);
    expect(loadDismissedVersions(storage({ 'ghost-ui:update-dismissed': '{oops' }))).toEqual([]);
    expect(loadDismissedVersions(storage({ 'ghost-ui:update-dismissed': JSON.stringify(['2.1.0', 2, null]) }))).toEqual(['2.1.0']);
  });

  it('dismisses per version and keeps each dismissal across repeated offers', () => {
    const store = storage();
    dismissVersion('2.1.0', store);
    dismissVersion('2.1.0', store);
    dismissVersion('0.2.0', store);
    const dismissed = loadDismissedVersions(store);
    expect(dismissed).toEqual(['2.1.0', '0.2.0']);
    expect(isVersionDismissed('2.1.0', dismissed)).toBe(true);
    expect(isVersionDismissed('0.2.0', dismissed)).toBe(true);
    expect(isVersionDismissed('2.2.0', dismissed)).toBe(false);
  });
});
