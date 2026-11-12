import type { ConnectionConfig } from '@ghost/contract';
import { Button } from '../ui';
import { Choice, TextField } from './InfrastructureFields';

type Paths = NonNullable<Extract<ConnectionConfig, { kind: 'api' }>['readPaths']>;
export function ReadPaths({ value, onChange }: { value: Paths; onChange(value: Paths): void }) {
  return <fieldset className="infra-list"><legend>읽기로 표시할 API 경로</legend>
    {value.map((item, index) => <div className="infra-attachment" key={index}>
      <div className="infra-columns"><Choice label={`경로 ${index + 1} 메서드`} value={item.method} onChange={method => onChange(value.map((entry, at) => at === index ? { ...entry, method: method as Paths[number]['method'] } : entry))} options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(method => ({ value: method, label: method }))}/>
        <TextField label={`경로 ${index + 1}`} required value={item.path} onChange={path => onChange(value.map((entry, at) => at === index ? { ...entry, path } : entry))} placeholder="/search"/></div>
      <div className="infra-actions"><Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, at) => at !== index))}>경로 삭제</Button></div>
    </div>)}
    <Button type="button" variant="outline" disabled={value.length >= 128} onClick={() => onChange([...value, { method: 'POST', path: '' }])}>읽기 경로 추가</Button>
  </fieldset>;
}
