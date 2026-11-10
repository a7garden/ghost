import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { UpdateStatus } from '@ghost/contract';
import { HostClient } from '../../host/client';
import { isDesktopShell, shellUpdateCheck, shellUpdateInstall, type ShellUpdate } from '../../host/desktop';

/** An active phase moves on the host without a UI prompt; the UI follows it by polling. */
export const UPDATE_POLL_MS = 2_000;
/** The host owns hourly GitHub checks; the UI refreshes status without triggering more checks. */
export const UPDATE_REFRESH_MS = 10 * 60 * 1_000;

export function updatePollingPhase(phase: UpdateStatus['phase'] | undefined): boolean {
  return phase === 'downloading' || phase === 'waiting' || phase === 'installing';
}

/** What the monitor needs from the host; tests substitute fakes. */
export type UpdateApi = {
  update(): Promise<UpdateStatus>;
  checkUpdate(): Promise<UpdateStatus>;
  installUpdate(version: string): Promise<UpdateStatus>;
  cancelUpdate(): Promise<UpdateStatus>;
  updateSettings(patch: { autoCheck?: boolean; token?: string | null }): Promise<UpdateStatus>;
};

export type UpdateSnapshot = {
  status: UpdateStatus | null;
  /** The desktop shell update the host offers, when this is the desktop shell and the host offers one. */
  shell: ShellUpdate | null;
  /** A failed status fetch or action, outside an active phase; active phases tolerate a restarting host. */
  error: string | null;
  /** An action (check/install/cancel/save) is in flight. */
  pending: boolean;
};

/** Tauri bridges, injectable for tests. */
export type UpdateBridges = {
  desktop?: boolean;
  shellCheck?: () => Promise<ShellUpdate | null>;
  shellInstall?: () => Promise<void>;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The host's own update state, kept alive: one status fetch on start, an hourly
 * re-check, and a 2 s poll while a phase is active. During `installing` the host
 * restarts, so connection errors there are expected and polling simply continues;
 * the result shows once the host answers again.
 */
export class UpdateMonitor {
  private snapshot: UpdateSnapshot = { status: null, shell: null, error: null, pending: false };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined = undefined;
  private stopped = true;

  constructor(private readonly api: UpdateApi, private readonly bridges: UpdateBridges = {}) {}

  get = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(next: Partial<UpdateSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  start() {
    this.stopped = false;
    void this.refresh();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Fetch the status once; also refreshes the shell offer in the desktop shell. */
  refresh = async (): Promise<void> => {
    try {
      const status = await this.api.update();
      this.set({ status, error: null });
      void this.refreshShell(status);
    } catch (error) {
      // The host restarts while it installs; keep the last known phase and keep polling.
      if (!updatePollingPhase(this.snapshot.status?.phase)) this.set({ error: message(error) });
    }
    this.arm();
  };

  /** Ask the host to check GitHub now; resolves after the check finished. */
  check = async (): Promise<void> => {
    await this.act(api => api.checkUpdate());
  };

  /** Start installing a release the host offered; the owner starts every install. */
  install = async (version: string): Promise<void> => {
    await this.act(api => api.installUpdate(version));
  };

  /** Cancel a download or a waiting install; the host refuses during installing. */
  cancel = async (): Promise<void> => {
    await this.act(api => api.cancelUpdate());
  };

  /** Switch auto-checking or replace/remove the stored GitHub token. */
  save = async (patch: { autoCheck?: boolean; token?: string | null }): Promise<void> => {
    await this.act(api => api.updateSettings(patch));
  };

  /** Download, install and restart the desktop shell; the webview goes away on success. */
  installShell = async (): Promise<void> => {
    const install = this.bridges.shellInstall ?? shellUpdateInstall;
    this.set({ pending: true, error: null });
    try {
      await install();
    } catch (error) {
      this.set({ error: message(error) });
    }
    this.set({ pending: false });
    this.arm();
  };

  private act = async (run: (api: UpdateApi) => Promise<UpdateStatus>): Promise<void> => {
    this.set({ pending: true, error: null });
    try {
      const status = await run(this.api);
      this.set({ status, pending: false });
      void this.refreshShell(status);
    } catch (error) {
      this.set({ pending: false, error: message(error) });
    }
    this.arm();
  };

  /** One timer at a time: fast polls during an active phase, otherwise refresh status every 10 min. */
  private arm() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped) return;
    this.timer = setTimeout(
      () => void this.refresh(),
      updatePollingPhase(this.snapshot.status?.phase) ? UPDATE_POLL_MS : UPDATE_REFRESH_MS,
    );
  }

  private async refreshShell(status: UpdateStatus): Promise<void> {
    const desktop = this.bridges.desktop ?? isDesktopShell();
    const shellCheck = this.bridges.shellCheck ?? shellUpdateCheck;
    if (!desktop || !status.shell || updatePollingPhase(status.phase)) {
      if ((!desktop || !status.shell) && this.snapshot.shell) this.set({ shell: null });
      return;
    }
    try {
      this.set({ shell: await shellCheck() });
    } catch {
      this.set({ shell: null });
    }
  }
}

/** The update monitor of the host client; one owner keeps it alive app-wide. */
const NO_BRIDGES: UpdateBridges = {};

export function useUpdate(client: HostClient, bridges: UpdateBridges = NO_BRIDGES): UpdateMonitor {
  const monitor = useMemo(() => new UpdateMonitor(client, bridges), [client, bridges]);
  useSyncExternalStore(monitor.subscribe, monitor.get, monitor.get);
  useEffect(() => {
    monitor.start();
    return () => monitor.stop();
  }, [monitor]);
  return monitor;
}

/** One update worth asking about: the host release first, else the desktop shell. */
export type UpdateOffer = { kind: 'host' | 'shell'; version: string; notes: string };

export function updateOffer(status: UpdateStatus | null, shell: ShellUpdate | null): UpdateOffer | null {
  const latest = status?.latest;
  if (latest) return { kind: 'host', version: latest.version, notes: latest.notes };
  if (shell) return { kind: 'shell', version: shell.version, notes: shell.notes };
  return null;
}
