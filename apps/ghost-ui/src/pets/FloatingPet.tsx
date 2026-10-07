import { X } from 'lucide-react';
import type { Profile } from '../client/types';
import { DotAvatar } from '../components/DotAvatar';
export function FloatingPet({ profile, onOpen, onHide }: { profile?: Profile; onOpen: () => void; onHide: () => void }) {
  if (!profile) return null;
  return <aside className="floating-pet" aria-label={`${profile.name} 펫`}><button className="floating-pet-hide icon-button" aria-label="펫 숨기기" onClick={onHide}><X size={13}/></button><button className="floating-pet-open" aria-label={`${profile.name} 대화 열기`} onClick={onOpen}><DotAvatar profileId={profile.id} size={80}/><span>{profile.name}</span></button></aside>;
}
