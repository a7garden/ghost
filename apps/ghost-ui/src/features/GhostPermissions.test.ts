import { describe, expect, it } from 'vitest';
import { DEFAULT_BROWSER_PERMISSIONS, DEFAULT_GHOST_PERMISSIONS } from '@ghost/contract';
import { addDomain, addLogin, addMount, allGranted, defaultsKeepingLists, grantedChanges, isShadeItemId, parseResource, permissionsCommand, vaultExposed, widened } from './GhostPermissions';

const ITEM = '0193a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const login = { itemId: ITEM, origin: 'https://shop.example', title: 'Shop' };

describe('ghost permissions', () => {
  it('opens everything at once but leaves the mounted folders alone', () => {
    const withMount = addMount(DEFAULT_GHOST_PERMISSIONS, '/Users/me/app', false);
    expect(allGranted(withMount)).toEqual({
      sandbox: { network: true, mounts: [{ path: '/Users/me/app', writable: false }], cpus: 2, memoryGiB: 2 },
      host: { approval: 'never', interpreters: true, privileged: true },
      documents: { autoWrite: true },
      effects: { unknown: 'continue' },
    });
  });

  it('adds a folder once, ignoring a trailing slash and blanks', () => {
    const once = addMount(DEFAULT_GHOST_PERMISSIONS, '/Users/me/app/', true);
    expect(once.sandbox.mounts).toEqual([{ path: '/Users/me/app', writable: true }]);
    expect(addMount(once, '/Users/me/app', false)).toBe(once);
    expect(addMount(once, '   ', true)).toBe(once);
  });

  it('knows when anything is wider than the defaults', () => {
    expect(widened(DEFAULT_GHOST_PERMISSIONS)).toBe(false);
    expect(widened({ ...DEFAULT_GHOST_PERMISSIONS, documents: { autoWrite: true } })).toBe(true);
  });

  it('browser: a stored default is not wider, and opening everything leaves paying clicks and logins alone', () => {
    expect(widened({ ...DEFAULT_GHOST_PERMISSIONS, browser: DEFAULT_BROWSER_PERMISSIONS })).toBe(false);
    expect(widened({ ...DEFAULT_GHOST_PERMISSIONS, browser: { ...DEFAULT_BROWSER_PERMISSIONS, commit: 'never' } })).toBe(true);
    const granted = { ...DEFAULT_GHOST_PERMISSIONS, browser: { commit: 'always' as const, domains: ['shop.example'], logins: [login] } };
    expect(allGranted(granted).browser).toEqual(granted.browser);
    expect(defaultsKeepingLists({ ...granted, browser: { ...granted.browser, commit: 'never' } }).browser).toEqual(granted.browser);
  });

  it('adds a domain from a hostname or a pasted URL, once', () => {
    const one = addDomain(DEFAULT_BROWSER_PERMISSIONS, 'https://Shop.Example/cart?x=1');
    expect(one.domains).toEqual(['shop.example']);
    expect(addDomain(one, '*.shop.example')).toBe(one);
    expect(addDomain(one, 'localhost')).toBe(one);
    expect(addDomain(one, 'not a host')).toBe(one);
  });

  it('adds a Shade login only with an item id and an https site', () => {
    expect(addLogin(DEFAULT_BROWSER_PERMISSIONS, ITEM.toUpperCase(), 'shop.example/login', '')?.logins).toEqual([{ itemId: ITEM, origin: 'https://shop.example', title: 'shop.example' }]);
    expect(addLogin(DEFAULT_BROWSER_PERMISSIONS, 'not-an-id', 'https://shop.example', 'Shop')).toBeNull();
    expect(addLogin(DEFAULT_BROWSER_PERMISSIONS, ITEM, 'http://shop.example', 'Shop')).toBeNull();
  });

  it('warns when a Ghost with vault logins may also run shells without approval', () => {
    const withLogin = { ...DEFAULT_GHOST_PERMISSIONS, browser: { ...DEFAULT_BROWSER_PERMISSIONS, logins: [login] } };
    expect(vaultExposed(withLogin)).toBe(false);
    expect(vaultExposed({ ...withLogin, host: { approval: 'never', interpreters: true, privileged: false } })).toBe(true);
  });

  it('saves the whole profile with the owner-only command', () => {
    expect(permissionsCommand('g1', DEFAULT_GHOST_PERMISSIONS)).toEqual({ type: 'ghost.permissions_update', ghostId: 'g1', permissions: DEFAULT_GHOST_PERMISSIONS });
  });
});

describe('ghost permission inputs', () => {
  it('lists what 모두 허용 newly opens and nothing once everything is open', () => {
    expect(grantedChanges(DEFAULT_GHOST_PERMISSIONS)).toHaveLength(6);
    expect(grantedChanges(allGranted(DEFAULT_GHOST_PERMISSIONS))).toEqual([]);
  });

  it('commits a resource only as a whole number inside its range', () => {
    expect(parseResource(' 4 ', 1, 16)).toEqual({ value: 4 });
    expect(parseResource('', 1, 16)).toHaveProperty('error');
    expect(parseResource('2.5', 1, 16)).toHaveProperty('error');
    expect(parseResource('0', 1, 16)).toHaveProperty('error');
    expect(parseResource('17', 1, 16)).toHaveProperty('error');
  });

  it('recognises a Shade item id by its UUID shape', () => {
    expect(isShadeItemId(ITEM.toUpperCase())).toBe(true);
    expect(isShadeItemId('0193a1b2-c3d4')).toBe(false);
  });
});
