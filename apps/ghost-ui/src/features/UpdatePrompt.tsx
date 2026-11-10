import { useState, useSyncExternalStore } from 'react';
import { Download } from 'lucide-react';
import { Banner, Button } from '../ui';
import { dismissVersion, isVersionDismissed, loadDismissedVersions } from './update/dismissed';
import { updateOffer, updatePollingPhase, type UpdateMonitor } from './update/useUpdate';

/**
 * 앱 전체 업데이트 안내: a pending host release, or in the desktop shell a pending app.
 * Non-modal and in flow, so it never covers the composer; 「나중에」 puts off exactly that version.
 */
export function UpdatePrompt({ monitor, navigate }: { monitor: UpdateMonitor; navigate: (path: string) => void }) {
  const { status, shell } = useSyncExternalStore(monitor.subscribe, monitor.get, monitor.get);
  const [dismissed, setDismissed] = useState(loadDismissedVersions);
  const offer = updateOffer(status, shell);
  if (!offer || updatePollingPhase(status?.phase) || isVersionDismissed(offer.version, dismissed)) return null;
  return <Banner variant="info" className="mb-4" action={<>
    <Button size="sm" onClick={() => {
      if (offer.kind === 'host') void monitor.install(offer.version);
      else void monitor.installShell();
      navigate('/settings?tab=update');
    }}>
      <Download aria-hidden="true"/>설치
    </Button>
    <Button variant="ghost" size="sm" onClick={() => {
      dismissVersion(offer.version);
      setDismissed(loadDismissedVersions());
    }}>나중에</Button>
  </>}>{`Ghost ${offer.kind === 'shell' ? '앱 ' : ''}${offer.version} 업데이트`}</Banner>;
}
