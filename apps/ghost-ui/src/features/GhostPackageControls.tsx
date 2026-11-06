import { useState } from 'react';
import { Button, FormField, Input, InlineError, SelectField } from '@garden/ui';
import { DotAvatar } from '../components/DotAvatar';
import { Modal } from '../components/Modal';
import { toneFor, type Profile } from '../client/types';
import { uploadPackage, type PackageInfo } from './PackageWorkspace';
import { PortraitColors, type PortraitColorProps } from './GhostDesign';
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
          options={profiles.map(item => ({ value: item.id, label: ghostDisplayName(item) }))}/>
      </>}
      {error && <InlineError>{error}</InlineError>}
      <Button type="submit" className="justify-self-end" disabled={busy || !info || !profile}>패키지 연결</Button>
    </form>
  </Modal>;
}

export function PortraitPicker({ profile, onClose, ...colors }: PortraitColorProps & { profile: Profile; onClose(): void }) {
  return <Modal title="초상화 색상" focusClose onClose={onClose}>
    <div className="grid gap-5">
      <div className="grid justify-items-center gap-2">
        <DotAvatar profileId={profile.id} tone={toneFor(profile.id)} size={96}/>
        <span className="text-ui font-medium text-ink">{ghostDisplayName(profile)}</span>
      </div>
      <PortraitColors profileId={profile.id} {...colors}/>
    </div>
  </Modal>;
}
