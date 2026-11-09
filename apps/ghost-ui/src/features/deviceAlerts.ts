import type { Device, NotificationKind } from '@ghost/contract';
export type DeviceAlerts = Device['alerts'];
export type AlertToggle = { kind: NotificationKind } | { ghostId: string };
export function toggleAlert(alerts: DeviceAlerts, toggle: AlertToggle): DeviceAlerts {
  if ('kind' in toggle) return { ...alerts, mutedKinds: alerts.mutedKinds.includes(toggle.kind) ? alerts.mutedKinds.filter(kind => kind !== toggle.kind) : [...alerts.mutedKinds, toggle.kind] };
  return { ...alerts, mutedGhostIds: alerts.mutedGhostIds.includes(toggle.ghostId) ? alerts.mutedGhostIds.filter(id => id !== toggle.ghostId) : [...alerts.mutedGhostIds, toggle.ghostId] };
}

/** Rebase pending gestures on the last confirmed value after a failed write, never send in parallel. */
export class AlertWriter {
  private confirmed: DeviceAlerts;
  private queue: { toggle: AlertToggle; done(): void }[] = [];
  private running = false;
  constructor(initial: DeviceAlerts, private save: (alerts: DeviceAlerts) => Promise<unknown>, private publish: (alerts: DeviceAlerts) => void, private fail: (reason: unknown) => void) { this.confirmed = initial; }
  sync(alerts: DeviceAlerts) { if (!this.running && !this.queue.length) { this.confirmed = alerts; this.publish(alerts); } }
  toggle(toggle: AlertToggle): Promise<void> {
    // The UI targets ES2022 (including older iOS webviews), before Promise.withResolvers.
    const done = new Promise<void>(resolve => this.queue.push({ toggle, done: resolve }));
    this.publish(this.queue.reduce((alerts, item) => toggleAlert(alerts, item.toggle), this.confirmed));
    void this.drain();
    return done;
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const item = this.queue[0];
      const next = toggleAlert(this.confirmed, item.toggle);
      try { await this.save(next); this.confirmed = next; }
      catch (reason) { this.fail(reason); }
      this.queue.shift();
      this.publish(this.queue.reduce((alerts, pending) => toggleAlert(alerts, pending.toggle), this.confirmed));
      item.done();
    }
    this.running = false;
  }
}
