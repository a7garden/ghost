import { X } from 'lucide-react';
import { Button } from '@garden/ui';
import type { Profile } from '../client/types';
import { DotAvatar } from '../components/DotAvatar';
import { ghostDisplayName } from '../features/profileSummary';

export function FloatingPet({ profile, onOpen, onHide }: { profile?: Profile; onOpen: () => void; onHide: () => void }) {
  if (!profile) return null;
  const name = ghostDisplayName(profile);
  return <aside className="group fixed right-6 bottom-6 z-40 grid justify-items-center" aria-label={`${name} 펫`}>
    <Button variant="outline" size="icon" className="absolute -top-2 -right-2 size-6 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label="펫 숨기기" onClick={onHide}><X className="size-3"/></Button>
    <button type="button" className="grid cursor-pointer justify-items-center gap-1 rounded-card p-1 text-caption text-ink-2" aria-label={`${name} 대화 열기`} onClick={onOpen}>
      <DotAvatar profileId={profile.id} size={80}/><span>{name}</span>
    </button>
  </aside>;
}
