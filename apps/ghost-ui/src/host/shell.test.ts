import { describe, expect, it } from 'vitest';
import { isShellEvent, isShellInfo, isShellRequest, routeShellEvent, type ShellEvent } from './shell';

describe('native shell boundary', () => {
  it('requires an iOS identity, version and nonempty paired device id', () => {
    expect(isShellInfo(Object.freeze({ platform: 'ios', version: '1', deviceId: 'phone' }))).toBe(true);
    for (const value of [null, {}, { platform: 'mac', version: '1', deviceId: 'phone' }, { platform: 'ios', version: 1, deviceId: 'phone' }, { platform: 'ios', version: '1', deviceId: '' }]) expect(isShellInfo(value)).toBe(false);
  });
  it('accepts only supported requests and their discriminated payloads', () => {
    for (const type of ['ready', 'notifications.status', 'notifications.request', 'notifications.settings', 'disconnected', 'revoked']) expect(isShellRequest({ type })).toBe(true);
    expect(isShellRequest({ type: 'theme', scheme: 'dark' })).toBe(true);
    expect(isShellRequest({ type: 'haptic', style: 'selection' })).toBe(true);
    expect(isShellRequest({ type: 'app.install', url: 'itms-services://?action=download-manifest&url=https%3A%2F%2Fhost%2Fmanifest.plist' })).toBe(true);
    for (const value of [undefined, 'ready', { type: 'open' }, { type: 'theme', scheme: 'system' }, { type: 'haptic', style: 'heavy' }, { type: 'app.install' }, { type: 'app.install', url: 'https://host/install' }]) expect(isShellRequest(value)).toBe(false);
  });
  it('routes a mixed native event batch in order, discarding malformed or unknown events', () => {
    const delivered: ShellEvent[] = [];
    for (const event of [{ type: 'notification.open', notificationId: 'n1' }, { type: 'notification.open' }, null, { type: 'resume' }, { type: 'notification.open', notificationId: '' }, { type: 'resume.bad' }]) routeShellEvent(event, item => delivered.push(item));
    expect(delivered).toEqual([{ type: 'notification.open', notificationId: 'n1' }, { type: 'resume' }]);
    expect(isShellEvent({ type: 'notification.open', notificationId: 3 })).toBe(false);
  });
});
