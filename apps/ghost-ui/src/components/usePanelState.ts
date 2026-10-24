import { useCallback, useEffect, useState } from 'react';

// Panel preferences are local UI state; failure to store one must not block work.
function read(key: string): boolean {
  try { return localStorage.getItem(key) === 'true'; } catch { return false; }
}

export function usePanelState(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => read(key));
  useEffect(() => setOpen(read(key)), [key]);
  const change = useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(key, String(next)); } catch { /* Optional preference. */ }
  }, [key]);
  return [open, change];
}
