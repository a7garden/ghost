import { useId, useState } from 'react';
import type { PiPackage, PiPackageFlags, PiPackageOverrides } from '@ghost/contract';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useHost } from '../host/context';
import { Button, InlineError, Input, SettingsGroup } from '../ui';
import { codingError } from './CodingSessionModel';

const flags: { key: keyof PiPackageFlags; label: string }[] = [
  { key: 'extensions', label: '확장' }, { key: 'skills', label: '스킬' }, { key: 'prompts', label: '프롬프트 템플릿' },
];
const labels = ['끔', '켬'];

export function PiPackageRows({ items, disabled, session, change, remove }: {
  items: PiPackage[];
  disabled?: boolean;
  session?: Record<string, PiPackageOverrides>;
  change?(item: PiPackage, key: keyof PiPackageFlags, value: boolean | undefined): void;
  remove?(item: PiPackage): void;
}) {
  return items.length ? <ul className="pi-packages">
    {items.map(item => <li key={item.id} className="pi-package">
      <div className="pi-package__title"><strong>{item.name}</strong>{item.version && <span className="pi-meta">{item.version}</span>}
        {remove && <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`${item.name} 제거`} onClick={() => remove(item)}>제거</Button>}
      </div>
      <code className="pi-package__source">{item.source}</code>
      {item.error && <InlineError>{item.error}</InlineError>}
      {[[item.tools, '도구'], [item.commands, '명령'], [item.skills, '스킬'], [item.prompts, '템플릿']].map(([names, label]) =>
        Array.isArray(names) && names.length > 0 && <div className="pi-package__names" key={String(label)}><span>{label}</span><code>{names.join(', ')}</code></div>)}
      <div className="pi-package__flags">
        {flags.filter(({ key }) => item[key].length > 0).map(({ key, label }) => {
          const stored = session ? session[item.id]?.[key] : item.enabled[key];
          return <label key={key}>
            <span>{label}</span>
            {change ? <select aria-label={`${item.name} ${label}`} disabled={disabled} value={stored === undefined ? 'inherit' : String(stored)} onChange={event => {
              const next = event.target.value;
              change(item, key, next === 'inherit' ? undefined : next === 'true');
            }}>
              {session && <option value="inherit">기본 · {labels[Number(item.enabled[key])]}</option>}
              <option value="false">끔</option><option value="true">켬</option>
            </select> : <span className="pi-meta">{labels[Number(stored ?? item.enabled[key])]}</span>}
          </label>;
        })}
      </div>
    </li>)}
  </ul> : <p className="pi-meta">설치된 Pi 패키지가 없습니다.</p>;
}

export function PiConfigPackages({ items, canManage, setItems }: {
  items: PiPackage[]; canManage: boolean; setItems(items: PiPackage[]): void;
}) {
  const { client } = useHost();
  const id = useId();
  const [source, setSource] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<PiPackage | null>(null);

  async function apply(action: () => Promise<void>, message: string) {
    setPending(true);
    setError('');
    try { await action(); }
    catch (reason) { setError(codingError(reason, message)); }
    finally { setPending(false); }
  }

  return <SettingsGroup title="Pi 패키지" className="pi-settings" actions={canManage && <Button type="button" size="sm" variant="outline" aria-expanded={installOpen} disabled={pending}
    onClick={() => { setInstallOpen(!installOpen); setConfirm(false); setError(''); }}>{installOpen ? '설치 닫기' : '패키지 설치'}</Button>}>
    {installOpen && <form className="pi-install" onSubmit={event => {
      event.preventDefault();
      if (!source.trim() || !confirm || pending) return;
      void apply(async () => {
        const item = await client.installPiPackage({ source: source.trim(), confirmed: true });
        setItems([...items, item]);
        setSource(''); setConfirm(false); setInstallOpen(false);
      }, '패키지를 설치하지 못했습니다.');
    }}>
      <label htmlFor={id}>로컬 경로, Git URL 또는 npm 패키지</label>
      <Input id={id} value={source} onChange={event => { setSource(event.target.value); setConfirm(false); }} required maxLength={4096} disabled={pending} autoComplete="off"/>
      <label className="pi-install__confirm">
        <input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} disabled={pending}/>
        <span>설치 스크립트와 확장은 Host의 전체 권한으로 실행될 수 있습니다.</span>
      </label>
      <Button type="submit" size="sm" disabled={!source.trim() || !confirm || pending}>{pending ? '설치 중…' : '설치'}</Button>
    </form>}
    {error && <InlineError>{error}</InlineError>}
    <PiPackageRows items={items} disabled={pending} remove={canManage ? setRemoving : undefined}
      change={canManage ? (item, key, value) => {
        if (value === undefined) return;
        void apply(async () => {
          const saved = await client.savePiPackage(item.id, { ...item.enabled, [key]: value });
          setItems(items.map(row => row.id === saved.id ? saved : row));
        }, '패키지 설정을 저장하지 못했습니다.');
      } : undefined}/>
    {items.some(item => item.extensions.length || item.skills.length || item.prompts.length) && <p className="pi-meta">패키지 변경은 다음 요청부터 적용됩니다.</p>}
    {removing && <ConfirmDialog title={`${removing.name} 제거`} confirmLabel="제거" onClose={() => setRemoving(null)} onConfirm={async () => {
      await client.removePiPackage(removing.id);
      setItems(items.filter(item => item.id !== removing.id));
    }}>설치한 리소스와 이 패키지의 세션별 설정을 제거합니다.</ConfirmDialog>}
  </SettingsGroup>;
}
