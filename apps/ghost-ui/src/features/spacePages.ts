import type { SpaceGrant } from '@ghost/contract';
import { HostError } from '../host/client';

/** Profiles the owner may edit; everything else is a read-only legacy format. */
export const EDITABLE_PROFILES = ['pdc-markdown/1', 'pdc-html/1'] as const;
export type EditableProfile = (typeof EDITABLE_PROFILES)[number];
export const isEditableProfile = (profile: string): profile is EditableProfile => (EDITABLE_PROFILES as readonly string[]).includes(profile);

/** A stale `expectedHash` comes back as the host's `conflict` error, not a generic failure. */
export const isConflict = (error: unknown): boolean => error instanceof HostError && error.code === 'conflict';

export function grantsSummary(grants: SpaceGrant[], ghostName: (id: string) => string): string {
  if (!grants.length) return 'Ghost 권한 없음';
  return grants.map(grant => `${ghostName(grant.ghostId)} ${modeLabel[grant.mode]}`).join(', ');
}

const modeLabel: Record<SpaceGrant['mode'], string> = { read: '읽기', propose: '제안' };
