import { HostError } from '../host/client';

/** Profiles the owner may edit; everything else is a read-only legacy format. */
export const EDITABLE_PROFILES = ['pdc-markdown/1', 'pdc-html/1'] as const;
export type EditableProfile = (typeof EDITABLE_PROFILES)[number];
export const isEditableProfile = (profile: string): profile is EditableProfile => (EDITABLE_PROFILES as readonly string[]).includes(profile);

/** A stale `expectedHash` comes back as the host's `conflict` error, not a generic failure. */
export const isConflict = (error: unknown): boolean => error instanceof HostError && error.code === 'conflict';

/** 새 프로젝트 이름 기본값: 폴더 경로의 마지막 세그먼트. */
export const spaceNameFromPath = (path: string): string => path.split('/').filter(Boolean).pop() ?? '';

/** 경로를 고랑 조각으로; 깊은 경로는 첫 세그먼트와 마지막 둘만 남기고 가운데를 접는다. */
export interface PathCrumb { leading: string | null; trailing: string[] }
export const pathCrumb = (path: string): PathCrumb => {
  const segments = path.split('/').filter(Boolean);
  return segments.length <= 3
    ? { leading: null, trailing: segments }
    : { leading: segments[0]!, trailing: segments.slice(-2) };
};

/** 문서에는 계약상 시각이 없다; 이 세션에서 저장한 순간만 기록해 마지막 편집으로 보여 준다. */
const sessionEdits = new Map<string, number>();
export const noteScopeEdit = (scopeId: string): void => { sessionEdits.set(scopeId, Date.now()); };
export const scopeLastEdit = (scopeId: string): number | null => sessionEdits.get(scopeId) ?? null;
