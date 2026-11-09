import { expect, it, vi } from 'vitest';
import { AlertWriter, toggleAlert, type DeviceAlerts } from './deviceAlerts';
const initial: DeviceAlerts = { mutedKinds: [], mutedGhostIds: [] };

it('toggles one alert scope without mutating or losing the other scope', () => {
  const alerts = { mutedKinds: ['work_failed'] as const, mutedGhostIds: ['g1'] };
  const next = toggleAlert({ mutedKinds: [...alerts.mutedKinds], mutedGhostIds: alerts.mutedGhostIds }, { kind: 'decision' });
  expect(next).toEqual({ mutedKinds: ['work_failed', 'decision'], mutedGhostIds: ['g1'] });
  expect(toggleAlert(next, { kind: 'decision' })).toEqual(alerts);
  expect(toggleAlert(next, { ghostId: 'g1' }).mutedGhostIds).toEqual([]);
  expect(alerts.mutedGhostIds).toEqual(['g1']);
});

it('publishes rapid gestures immediately but persists them one at a time', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const save = vi.fn().mockImplementationOnce(() => gates[0].promise).mockImplementationOnce(() => gates[1].promise);
  const publish = vi.fn();
  const writer = new AlertWriter(initial, save, publish, vi.fn());
  const first = writer.toggle({ kind: 'decision' });
  const second = writer.toggle({ ghostId: 'g1' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenLastCalledWith({ mutedKinds: ['decision'], mutedGhostIds: ['g1'] });
  gates[0].resolve(); await first;
  expect(save).toHaveBeenNthCalledWith(2, { mutedKinds: ['decision'], mutedGhostIds: ['g1'] });
  gates[1].resolve(); await second;
});

it('reverts a failed write and rebases later gestures instead of replaying the failed snapshot', async () => {
  const gate = Promise.withResolvers<void>();
  const save = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
  const publish = vi.fn(), fail = vi.fn();
  const writer = new AlertWriter(initial, save, publish, fail);
  const first = writer.toggle({ kind: 'decision' });
  const second = writer.toggle({ kind: 'work_failed' });
  gate.reject(new Error('offline')); await first; await second;
  expect(fail).toHaveBeenCalledOnce();
  expect(save).toHaveBeenLastCalledWith({ mutedKinds: ['work_failed'], mutedGhostIds: [] });
  expect(publish).toHaveBeenLastCalledWith({ mutedKinds: ['work_failed'], mutedGhostIds: [] });
});
