import { afterEach, beforeEach, it, vi } from 'vitest';
import { expect } from 'vitest';
import type { UpdateStatus } from '@ghost/contract';
import { UPDATE_POLL_MS, UPDATE_REFRESH_MS, UpdateMonitor, updateOffer, type UpdateApi } from './useUpdate';

const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  enabled: true,
  disabledReason: null,
  hasCredential: true,
  current: { version: '2.0.0', commit: 'abc1234' },
  autoCheck: true,
  phase: 'idle',
  latest: null,
  shell: null,
  checkedAt: 1,
  nextCheckAt: null,
  error: null,
  lastResult: null,
  ...patch,
});

const activeStatus = (phase: 'downloading' | 'waiting' | 'installing') => status({ phase });

const fakeApi = (): UpdateApi => ({
  update: vi.fn().mockResolvedValue(status()),
  checkUpdate: vi.fn().mockResolvedValue(status()),
  installUpdate: vi.fn().mockResolvedValue(status()),
  cancelUpdate: vi.fn().mockResolvedValue(status()),
  updateSettings: vi.fn().mockResolvedValue(status()),
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('polls active phases every 2 s and refreshes idle status every 10 min without checking GitHub', async () => {
  const api = fakeApi();
  api.update
    .mockResolvedValueOnce(activeStatus('downloading'))
    .mockResolvedValueOnce(activeStatus('downloading'))
    .mockResolvedValue(status());
  const monitor = new UpdateMonitor(api);
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.update).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS - 1);
  expect(api.update).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.update).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
  expect(api.update).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(UPDATE_REFRESH_MS - 1);
  expect(api.update).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.update).toHaveBeenCalledTimes(4);
  expect(api.checkUpdate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(UPDATE_REFRESH_MS);
  expect(api.update).toHaveBeenCalledTimes(5);
  expect(api.checkUpdate).not.toHaveBeenCalled();
  monitor.stop();
});

it('keeps polling through connection errors while installing and shows the result after reconnect', async () => {
  const api = fakeApi();
  api.update
    .mockResolvedValueOnce(activeStatus('installing'))
    .mockRejectedValueOnce(new Error('Ghost 호스트에 연결할 수 없습니다.'))
    .mockResolvedValue(status({ lastResult: { outcome: 'installed', from: '2.0.0', to: '2.1.0', at: 2 } }));
  const monitor = new UpdateMonitor(api);
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.get().status?.phase).toBe('installing');
  await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
  expect(api.update).toHaveBeenCalledTimes(2);
  expect(monitor.get().error).toBeNull();
  expect(monitor.get().status?.phase).toBe('installing');
  await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
  expect(api.update).toHaveBeenCalledTimes(3);
  expect(monitor.get().status?.phase).toBe('idle');
  expect(monitor.get().status?.lastResult).toEqual({ outcome: 'installed', from: '2.0.0', to: '2.1.0', at: 2 });
  monitor.stop();
});

it('surfaces connection errors only when no phase is active', async () => {
  const api = fakeApi();
  api.update.mockRejectedValue(new Error('Ghost 호스트에 연결할 수 없습니다.'));
  const monitor = new UpdateMonitor(api);
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(monitor.get().error).toBe('Ghost 호스트에 연결할 수 없습니다.');
  expect(monitor.get().status).toBeNull();
  monitor.stop();
});

it('refreshes idle status every 10 min regardless of auto-check or enabled state, never checking on a timer', async () => {
  const manual = fakeApi();
  manual.update.mockResolvedValue(status({ autoCheck: false }));
  const manualMonitor = new UpdateMonitor(manual);
  manualMonitor.start();
  await vi.advanceTimersByTimeAsync(UPDATE_REFRESH_MS);
  expect(manual.update).toHaveBeenCalledTimes(2);
  expect(manual.checkUpdate).not.toHaveBeenCalled();
  manualMonitor.stop();

  const development = fakeApi();
  development.update.mockResolvedValue(status({ enabled: false, disabledReason: 'development' }));
  const developmentMonitor = new UpdateMonitor(development);
  developmentMonitor.start();
  await vi.advanceTimersByTimeAsync(UPDATE_REFRESH_MS);
  expect(development.update).toHaveBeenCalledTimes(2);
  expect(development.checkUpdate).not.toHaveBeenCalled();
  developmentMonitor.stop();
});

it('asks the desktop shell for its update while the host offers one', async () => {
  const shellCheck = vi.fn().mockResolvedValue({ version: '0.2.0', notes: '앱 개선' });
  const api = fakeApi();
  api.update.mockResolvedValue(status({ shell: { version: '0.2.0', notes: '앱 개선' } }));
  const monitor = new UpdateMonitor(api, { desktop: true, shellCheck });
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(shellCheck).toHaveBeenCalledTimes(1);
  expect(monitor.get().shell).toEqual({ version: '0.2.0', notes: '앱 개선' });
  api.update.mockResolvedValue(status());
  await monitor.refresh();
  expect(monitor.get().shell).toBeNull();
  monitor.stop();
});

it('does not check the desktop shell during an active Host phase', async () => {
  const shellCheck = vi.fn().mockResolvedValue({ version: '0.2.0', notes: '' });
  const api = fakeApi();
  api.update.mockResolvedValue(activeStatus('downloading'));
  const monitor = new UpdateMonitor(api, { desktop: true, shellCheck });
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(shellCheck).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(UPDATE_POLL_MS);
  expect(shellCheck).not.toHaveBeenCalled();
  monitor.stop();
});

it('never asks the shell outside the desktop shell', async () => {
  const shellCheck = vi.fn().mockResolvedValue({ version: '0.2.0', notes: '' });
  const api = fakeApi();
  api.update.mockResolvedValue(status({ shell: { version: '0.2.0', notes: '' } }));
  const monitor = new UpdateMonitor(api, { shellCheck });
  monitor.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(shellCheck).not.toHaveBeenCalled();
  expect(monitor.get().shell).toBeNull();
  monitor.stop();
});

it('applies action results and reports action failures', async () => {
  const api = fakeApi();
  api.installUpdate.mockResolvedValue(status({ phase: 'downloading', latest: { version: '2.1.0', commit: 'def5678', notes: '', publishedAt: '2026-11-10T12:00:00Z' } }));
  const monitor = new UpdateMonitor(api);
  await monitor.install('2.1.0');
  expect(api.installUpdate).toHaveBeenCalledWith('2.1.0');
  expect(monitor.get().status?.phase).toBe('downloading');
  api.installUpdate.mockRejectedValueOnce(new Error('다른 설치가 진행 중입니다.'));
  await monitor.install('2.1.0');
  expect(monitor.get().error).toBe('다른 설치가 진행 중입니다.');
  await monitor.cancel();
  expect(api.cancelUpdate).toHaveBeenCalledTimes(1);
  expect(monitor.get().error).toBeNull();
  api.updateSettings.mockResolvedValue(status({ autoCheck: false }));
  await monitor.save({ autoCheck: false });
  expect(api.updateSettings).toHaveBeenCalledWith({ autoCheck: false });
  expect(monitor.get().status?.autoCheck).toBe(false);
});

it('installs the shell update through the bridge and surfaces its failures', async () => {
  const shellInstall = vi.fn().mockRejectedValue(new Error('앱 업데이트에 실패했습니다.'));
  const monitor = new UpdateMonitor(fakeApi(), { desktop: true, shellInstall });
  await monitor.installShell();
  expect(shellInstall).toHaveBeenCalledTimes(1);
  expect(monitor.get().error).toBe('앱 업데이트에 실패했습니다.');
});

it('offers the host release first, else the desktop shell', () => {
  const shell = { version: '0.2.0', notes: '' };
  const latest = { version: '2.1.0', commit: 'def5678', notes: 'n', publishedAt: '2026-11-10T12:00:00Z' };
  expect(updateOffer(status({ latest }), shell)).toEqual({ kind: 'host', version: '2.1.0', notes: 'n' });
  expect(updateOffer(status(), shell)).toEqual({ kind: 'shell', version: '0.2.0', notes: '' });
  expect(updateOffer(status(), null)).toBeNull();
  expect(updateOffer(null, shell)).toEqual({ kind: 'shell', version: '0.2.0', notes: '' });
});
