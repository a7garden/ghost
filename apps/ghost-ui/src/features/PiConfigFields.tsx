import { useId, type ReactNode } from 'react';
import type { PiSettings } from '@ghost/contract';
import { Input, SettingsRow, Switch } from '../ui';

function Count({ label, value, change, max }: { label: string; value: number; change(value: number): void; max?: number }) {
  const id = useId();
  return <SettingsRow label={label} htmlFor={id}>
    <Input id={id} type="number" min={0} max={max ?? Number.MAX_SAFE_INTEGER} step={1} required value={Number.isNaN(value) ? '' : value}
      onChange={event => change(event.target.valueAsNumber)}/>
  </SettingsRow>;
}

function Toggle({ label, checked, change, description }: { label: string; checked: boolean; change?(value: boolean): void; description?: string }) {
  const id = useId();
  return <SettingsRow label={label} htmlFor={id} description={description}><Switch id={id} checked={checked} disabled={!change} onCheckedChange={change}/></SettingsRow>;
}

type Editor<T> = { value: T; change(value: T): void };

export function PiCompactionFields({ value, change }: Editor<PiSettings['compaction']>) {
  return <>
    <Toggle label="자동 압축" checked={value.enabled} change={enabled => change({ ...value, enabled })}/>
    <Count label="압축 시작 여유 (토큰)" value={value.reserveTokens} change={reserveTokens => change({ ...value, reserveTokens })}/>
    <Count label="유지할 최근 맥락 (토큰)" value={value.keepRecentTokens} change={keepRecentTokens => change({ ...value, keepRecentTokens })}/>
  </>;
}

export function PiRetryFields({ value, change }: Editor<PiSettings['retry']>) {
  return <>
    <Toggle label="자동 재시도" checked={value.enabled} change={enabled => change({ ...value, enabled })}/>
    <Count label="최대 재시도" max={100} value={value.maxRetries} change={maxRetries => change({ ...value, maxRetries })}/>
    <Count label="첫 재시도 대기 (ms)" value={value.baseDelayMs} change={baseDelayMs => change({ ...value, baseDelayMs })}/>
  </>;
}

export function PiDeliveryField({ label, value, change }: Editor<PiSettings['steeringMode']> & { label: string }) {
  const id = useId();
  return <SettingsRow label={label} htmlFor={id}>
    <select id={id} value={value} onChange={event => change(event.target.value === 'all' ? 'all' : 'one-at-a-time')}>
      <option value="one-at-a-time">한 번에 하나</option><option value="all">한꺼번에</option>
    </select>
  </SettingsRow>;
}

export function PiImageField({ value = false, change }: { value?: boolean; change?(value: boolean): void }) {
  return <Toggle label="이미지 자동 축소" checked={value} change={change}
    description={!change ? '이 Host에서는 이미지를 자동 축소할 수 없습니다.' : undefined}/>;
}

export const PI_BASE_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'ask_owner_choices', 'subagent'];

export function PiToolFields({ value, change, tools }: Editor<PiSettings['toolAllowlist']> & { tools: string[] }) {
  return <>
    <Toggle label="허용 목록 지정" checked={value !== null} change={enabled => change(enabled ? tools : null)}/>
    {value !== null && <div className="pi-tools" role="group" aria-label="허용할 도구">
      {[...new Set([...tools, ...value])].map(tool => <label key={tool}>
        <input type="checkbox" checked={value.includes(tool)} onChange={event => change(event.target.checked ? [...value, tool] : value.filter(name => name !== tool))}/>
        <code>{tool}</code>
      </label>)}
    </div>}
    <p className="pi-meta">도구 변경은 다음 요청부터 적용됩니다.</p>
  </>;
}

export function PiDisclosure({ label, value, children }: { label: string; value?: ReactNode; children: ReactNode }) {
  return <details className="pi-disclosure"><summary>
    <span>{label}</span>{value !== undefined && <span className="settings-list__value">{value}</span>}
  </summary>{children}</details>;
}
