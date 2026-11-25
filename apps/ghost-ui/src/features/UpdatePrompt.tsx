import { useState, useSyncExternalStore } from 'react';
import { Download } from 'lucide-react';
import { Banner, Button } from '../ui';
import { dismissVersion, isVersionDismissed, loadDismissedVersions } from './update/dismissed';
import { supportsIosInstall, updateOffer, updatePollingPhase, type UpdateMonitor } from './update/useUpdate';
import { shell as iosShell } from '../host/shell';

/**
 * 앱 전체 업데이트 안내: a pending host release, or in the desktop shell a pending app.
 * Non-modal and in flow, so it never covers the composer; 「나중에」 puts off exactly that version.
 * Automatic updates install host and desktop releases themselves, so those are only offered while
 * automatic updating is off or has stopped on an error; an iPhone app can only be installed by hand.
 */
export function UpdatePrompt({ monitor, navigate }: { monitor: UpdateMonitor; navigate: (path: string) => void }) {
  const { status, shell: desktopShell } = useSyncExternalStore(monitor.subscribe, monitor.get, monitor.get);
  const [dismissed, setDismissed] = useState(loadDismissedVersions);
  const offer = updateOffer(status, desktopShell);
  const offerKey = offer ? `${offer.version}${offer.kind === 'ios' ? ` (${offer.build})` : ''}` : '';
  const automatic = Boolean(status?.enabled && status.autoCheck && status.phase !== 'error') && offer?.kind !== 'ios';
  if (!offer || automatic || updatePollingPhase(status?.phase) || isVersionDismissed(offerKey, dismissed)) return null;
  return <Banner variant="info" className="mb-4" action={<>
    <Button size="sm" onClick={() => {
      if (offer.kind === 'host') void monitor.install(offer.version);
      else if (offer.kind === 'shell') void monitor.installShell();
      else if (iosShell && supportsIosInstall(iosShell)) void monitor.installIos();
      navigate('/settings?tab=update');
    }}>
      <Download aria-hidden="true"/>{offer.kind === 'ios' && iosShell && !supportsIosInstall(iosShell) ? '업데이트 설정' : '설치'}
    </Button>
    <Button variant="ghost" size="sm" onClick={() => {
      dismissVersion(offerKey);
      setDismissed(loadDismissedVersions());
    }}>나중에</Button>
  </>}>{offer.kind === 'ios' ? `Ghost 앱 ${offer.version} (${offer.build}) 업데이트` : `Ghost ${offer.kind === 'shell' ? '앱 ' : ''}${offer.version} 업데이트`}</Banner>;
}
