import type { Call } from '@ghost/contract';
import { isLiveCall } from '../features/call/call-state';
import { useHost } from './context';
import { useHostState } from './store';

const EMPTY_CALLS: readonly Call[] = [];

export function useCalls(): readonly Call[] {
  const { store } = useHost();
  return useHostState(store).state?.calls ?? EMPTY_CALLS;
}

export function useActiveCall(): Call | undefined {
  return useCalls().find(isLiveCall);
}
