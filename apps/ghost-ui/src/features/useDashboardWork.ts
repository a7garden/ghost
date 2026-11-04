import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot as LifetimeSnapshot } from '../../../../contracts/lifetime/bindings.ts';
import type { Snapshot } from '../client/types';
import { createLifetimeControlTransport, type AuthenticatedControlAction } from '../lifetime/controlTransport';
import { defaultRegistryGhostId, parseRegistryResponse } from '../lifetime/conversation';
import { createEnvelope } from '../lifetime/protocol';

interface Observation {
  scope: string;
  snapshot?: LifetimeSnapshot;
  error: string;
  observedAt: number | null;
}

export function useDashboardWork({ workspace, mode, read, enabled, loadRoster }: {
  workspace: Snapshot | null;
  mode: 'live' | 'demo';
  read: AuthenticatedControlAction;
  enabled: boolean;
  loadRoster: boolean;
}) {
  const epoch = workspace?.lifetime_authority?.authority_epoch;
  const scope = enabled && mode === 'live' && workspace && epoch !== undefined
    ? JSON.stringify([workspace.workspace_id, epoch]) : null;
  const [observation, setObservation] = useState<Observation>();
  const [roster, setRoster] = useState<{ scope: string; defaultGhostId: string | null }>();
  const inFlight = useRef<Promise<LifetimeSnapshot> | null>(null);
  const refreshRequest = useRef<{ scope: string; run: () => void } | null>(null);

  useEffect(() => {
    if (scope === null || epoch === undefined) {
      setObservation(undefined);
      return;
    }

    let active = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setObservation(previous => previous?.scope === scope ? previous : undefined);

    const poll = async () => {
      if (!active || polling) return;
      clearTimeout(timer);
      polling = true;
      try {
        // A new workspace or epoch waits for the previous read to settle, then reads with its own authority.
        if (inFlight.current) await inFlight.current.catch(() => undefined);
        if (!active) return;
        const transport = createLifetimeControlTransport(read, { actor_ref: 'owner', authority_epoch: epoch });
        const request = transport.snapshot();
        inFlight.current = request;
        try {
          const snapshot = await request;
          if (active) setObservation({ scope, snapshot, error: '', observedAt: Date.now() });
        } finally {
          if (inFlight.current === request) inFlight.current = null;
        }
      } catch (reason) {
        const error = reason instanceof Error && reason.message ? reason.message : '작업 현황을 불러오지 못했습니다.';
        if (active) setObservation(previous => ({
          scope,
          snapshot: previous?.scope === scope ? previous.snapshot : undefined,
          error,
          observedAt: previous?.scope === scope ? previous.observedAt : null,
        }));
      } finally {
        polling = false;
        if (active) timer = setTimeout(poll, document.hidden ? 15_000 : 5_000);
      }
    };

    const run = () => { void poll(); };
    const onVisibilityChange = () => { if (!document.hidden) run(); };
    refreshRequest.current = { scope, run };
    document.addEventListener('visibilitychange', onVisibilityChange);
    run();
    return () => {
      active = false;
      clearTimeout(timer);
      refreshRequest.current = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [scope, epoch, read]);

  useEffect(() => {
    setRoster(undefined);
    if (!loadRoster || scope === null || epoch === undefined) return;

    let active = true;
    const identity = { actor_ref: 'owner', authority_epoch: epoch };
    const readDefault = async () => {
      const transport = createLifetimeControlTransport(read, identity);
      const envelope = await createEnvelope({ method: 'registry.inspect' }, identity);
      const response = await transport.request(envelope);
      if (active) setRoster({ scope, defaultGhostId: defaultRegistryGhostId(parseRegistryResponse(response)) });
    };
    void readDefault().catch(() => { /* The badge requires a verified registry response. */ });
    return () => { active = false; };
  }, [scope, epoch, read, loadRoster]);

  const refresh = useCallback(() => {
    if (refreshRequest.current?.scope === scope) refreshRequest.current.run();
  }, [scope]);
  const current = observation?.scope === scope ? observation : undefined;
  return {
    snapshot: current?.snapshot,
    defaultGhostId: roster?.scope === scope ? roster?.defaultGhostId : undefined,
    error: current?.error ?? '',
    loading: scope !== null && current === undefined,
    observedAt: current?.observedAt ?? null,
    refresh,
  };
}
