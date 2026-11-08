import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { HostClient } from './client';
import { HostStore } from './store';

export type HostContextValue = {
  /** Live host state store: snapshot + event stream. */
  store: HostStore;
  /** The only way the UI talks to the host. */
  client: HostClient;
};

const HostContext = createContext<HostContextValue | null>(null);

export function HostProvider({ children, client }: { children: ReactNode; client?: HostClient }) {
  const value = useMemo<HostContextValue>(() => {
    const resolved = client ?? new HostClient();
    return { client: resolved, store: new HostStore(resolved) };
  }, [client]);

  useEffect(() => {
    value.store.start();
    return () => value.store.stop();
  }, [value]);

  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useHost(): HostContextValue {
  const value = useContext(HostContext);
  if (!value) throw new Error('useHost must be used inside <HostProvider>');
  return value;
}

/** The host when one is provided; static renders and previews have none. */
export function useOptionalHost(): HostContextValue | null {
  return useContext(HostContext);
}
