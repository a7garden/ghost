import type { DotState } from '../client/types';
import { stateLabel } from '../client/types';
export function Status({ state, label }: { state: DotState; label?: string }) { return <span className={`status status-${state}`}><i aria-hidden="true" />{label ?? stateLabel[state]}</span>; }
