import { expect, it } from 'vitest';
import { HostError } from '../host/client';
import { defaultSpaceGrants, isConflict, isEditableProfile, spaceNameFromPath, accessLevelOf, withAccess, pathCrumb } from './spacePages';
import type { SpaceGrant } from '@ghost/contract';

it('derives the project name from the folder path', () => {
  expect(spaceNameFromPath('/tmp/ghost-r2-docs/notes')).toBe('notes');
  expect(spaceNameFromPath('/tmp/notes/')).toBe('notes');
  expect(spaceNameFromPath('//tmp//docs')).toBe('docs');
  expect(spaceNameFromPath('/')).toBe('');
  expect(spaceNameFromPath('')).toBe('');
});

it('starts a new project readable by the default Ghost', () => {
  expect(defaultSpaceGrants([{ id: 'wind', isDefault: false }, { id: 'main', isDefault: true }]))
    .toEqual([{ ghostId: 'main', mode: 'read' }]);
  expect(defaultSpaceGrants([{ id: 'sage', isDefault: false }])).toEqual([]);
});

it('reads a Ghost access level from the grants', () => {
  const grants: SpaceGrant[] = [{ ghostId: 'sage', mode: 'read' }];
  expect(accessLevelOf(grants, 'sage')).toBe('read');
  expect(accessLevelOf(grants, 'milo')).toBe('none');
});

it('moves a Ghost across 없음 → 읽기 → 제안 without touching the others', () => {
  const start: SpaceGrant[] = [{ ghostId: 'sage', mode: 'read' }, { ghostId: 'milo', mode: 'propose' }];
  expect(withAccess(start, 'sage', 'propose')).toEqual([{ ghostId: 'sage', mode: 'propose' }, { ghostId: 'milo', mode: 'propose' }]);
  expect(withAccess(start, 'new', 'read')).toEqual([...start, { ghostId: 'new', mode: 'read' }]);
  expect(withAccess(start, 'sage', 'none')).toEqual([{ ghostId: 'milo', mode: 'propose' }]);
  expect(withAccess(start, 'milo', 'none')).toEqual([{ ghostId: 'sage', mode: 'read' }]);
});

it('folds long folder paths into a crumb', () => {
  expect(pathCrumb('/tmp/notes')).toEqual({ leading: null, trailing: ['tmp', 'notes'] });
  expect(pathCrumb('/a/b/c')).toEqual({ leading: null, trailing: ['a', 'b', 'c'] });
  expect(pathCrumb('/Users/garden/Workspace/Projects/ghost')).toEqual({ leading: 'Users', trailing: ['Projects', 'ghost'] });
  expect(pathCrumb('/')).toEqual({ leading: null, trailing: [] });
});

it('marks only the current PDC profiles editable', () => {
  expect(isEditableProfile('pdc-markdown/1')).toBe(true);
  expect(isEditableProfile('pdc-html/1')).toBe(true);
  expect(isEditableProfile('pdc-markdown/0')).toBe(false);
  expect(isEditableProfile('text/plain')).toBe(false);
});

it('surfaces a stale content hash as a conflict', () => {
  const stale = new HostError('conflict', '문서가 이미 바뀌었습니다.');
  const gone = new HostError('not_found', '문서를 찾을 수 없습니다.');
  expect(isConflict(stale)).toBe(true);
  expect(isConflict(gone)).toBe(false);
  expect(isConflict(new Error('network down'))).toBe(false);
});

it('keeps page grants typed against the contract', () => {
  const grants: SpaceGrant[] = [{ ghostId: 'sage', mode: 'read' }];
  expect(grants[0].mode).toBe('read');
});
