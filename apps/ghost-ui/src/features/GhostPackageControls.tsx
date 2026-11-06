import { useState } from 'react';
import { Button, FormField, Input, InlineError, SelectField } from '@garden/ui';
import { DotAvatar, type PortraitAppearance } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { useProfileAvatar } from '../pets/AvatarProvider';
import { GhostColorPicker } from '../pets/GhostColorPicker';
import { toneFor, type Profile } from '../client/types';
import { portraitColors, uploadPackage, type PackageInfo } from './PackageWorkspace';
import { ghostDisplayName } from './profileSummary';

export function PackageImport({ workspace, profiles, selected, onClose, onInstalled }: {
  workspace: string; profiles: Profile[]; selected: string;
  onClose(): void; onInstalled(profile: string): void;
}) {
  const [file, setFile] = useState<File>();
  const [info, setInfo] = useState<PackageInfo>();
  const [profile, setProfile] = useState(selected);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Modal title="패키지 추가" onClose={() => { if (!busy) onClose(); }}>
    <form className="grid gap-4" onSubmit={async event => {
      event.preventDefault();
      if (!file || !info || !profile || busy) return;
      setBusy(true);
      setError('');
      try { await uploadPackage(file, { workspace, profile, digest: info.digest }); onInstalled(profile); }
      catch (failure) { setError((failure as Error).message); setBusy(false); }
    }}>
      <FormField label=".ghost 파일">
        {control => <Input {...control} type="file" accept=".ghost,application/zip" disabled={busy} onChange={async event => {
          const next = event.currentTarget.files?.[0];
          setFile(next); setInfo(undefined); setError('');
          if (!next) return;
          setBusy(true);
          try { setInfo(await uploadPackage(next)); }
          catch (failure) { setError((failure as Error).message); }
          finally { setBusy(false); }
        }}/>}
      </FormField>
      {info && <>
        <div className="grid gap-0.5">
          <strong className="text-ui text-ink">{info.name}</strong>
          <span className="text-caption text-ink-2">{info.id} · {info.version}</span>
          <span className="text-caption text-ink-2">{info.ui?.views.map(view => view.label).join(' · ') || '기본 대화'}</span>
        </div>
        <SelectField label="연결할 Ghost" value={profile} onValueChange={setProfile} disabled={busy}
          options={profiles.map(item => ({ value: item.id, label: ghostDisplayName(item.name) }))}/>
      </>}
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy || !info || !profile}>패키지 연결</Button>
    </form>
  </Modal>;
}

const boldColors = [
  { name: '빨강', color: '#e92b37' }, { name: '주황', color: '#ff7a18' }, { name: '노랑', color: '#ffd600' },
  { name: '초록', color: '#008a45' }, { name: '파랑', color: '#0058ef' }, { name: '보라', color: '#7135db' },
];
const neutralColors = [{ name: '검정', color: '#191919' }, { name: '흰색', color: '#ffffff' }];
const bodyColors = [...neutralColors, ...boldColors];
const backgroundColors = [
  ...boldColors,
  { name: '하늘', color: portraitColors.sky }, { name: '민트', color: portraitColors.mint },
  { name: '라일락', color: portraitColors.lilac }, { name: '복숭아', color: portraitColors.peach },
  { name: '모래', color: portraitColors.sand }, { name: '슬레이트', color: portraitColors.slate },
  ...neutralColors,
];

export function PortraitPicker({ profile, appearance, choices, defaults, onSelect, onClose }: {
  profile: Profile; appearance?: PortraitAppearance; choices: PortraitAppearance; defaults: Required<PortraitAppearance>;
  onSelect(part: keyof PortraitAppearance, color?: string): void; onClose(): void;
}) {
  const { isDefault } = useProfileAvatar(profile.id);
  return <Modal title="초상화 색상" focusClose onClose={onClose}>
    <div className="grid gap-5">
      <div className="grid justify-items-center gap-2">
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={96}/>
        <span className="text-ui font-medium text-ink">{ghostDisplayName(profile.name)}</span>
      </div>
      {isDefault && <GhostColorPicker label="본체 색" resetLabel="자동" presets={bodyColors} value={choices.body ?? 'auto'}
        fallback={appearance?.body ?? defaults.body} onChange={color => onSelect('body', color === 'auto' ? undefined : color)}/>}
      <GhostColorPicker label="배경색" resetLabel="기본" presets={backgroundColors} value={choices.background ?? 'auto'}
        fallback={appearance?.background ?? defaults.background} onChange={color => onSelect('background', color === 'auto' ? undefined : color)}/>
    </div>
  </Modal>;
}
