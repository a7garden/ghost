import { useHost } from '../host/context';
import { useHostState } from '../host/store';
import { Choice } from './InfrastructureFields';

export function WorkModelFields({ slot, retrySlot, onSlot, onRetry }: { slot: string; retrySlot: string; onSlot(value: string): void; onRetry(value: string): void }) {
  const { store } = useHost();
  const { state } = useHostState(store);
  const slots = Object.keys(state?.settings.slots ?? {}).map(name => ({ value: name, label: name }));
  if (!slots.length && !slot && !retrySlot) return null;
  return <div className="infra-columns">
    <Choice label="모델 자리" value={slot} onChange={onSlot} options={[{ value: '', label: 'Ghost 기본값' }, ...slots]}/>
    <Choice label="실패 후 재시도 자리" value={retrySlot} onChange={onRetry} options={[{ value: '', label: '지정 안 함' }, ...slots]}/>
  </div>;
}
