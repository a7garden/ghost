import { expect, it } from 'vitest';
import { HostError } from '../host/client';
import { grantsSummary, defaultSpaceGrants, isConflict, isEditableProfile, spaceNameFromPath } from './spacePages';
import type { SpaceGrant } from '@ghost/contract';

const name = (id: string) => (id === 'sage' ? '세이지' : id);

it('summarises ghost grants per project', () => {
  expect(grantsSummary([], name)).toBe('Ghost 권한 없음');
  expect(grantsSummary([{ ghostId: 'sage', mode: 'read' }], name)).toBe('세이지 읽기');
  expect(grantsSummary([{ ghostId: 'sage', mode: 'read' }, { ghostId: 'milo', mode: 'propose' }], name)).toBe('세이지 읽기, milo 제안');
});

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
