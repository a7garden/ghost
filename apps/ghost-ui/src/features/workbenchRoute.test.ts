import { expect, it } from 'vitest';
import { workbenchPath, workbenchScope, workbenchSessionPath } from './workbenchRoute';

it('distinguishes the remembered-project entry from an explicit unscoped project', () => {
  expect(workbenchScope(undefined)).toBeUndefined();
  expect(workbenchScope('-')).toBeNull();
  expect(workbenchPath(null, 'launch=1')).toBe('/coding/-?launch=1');
});

it('keeps a project and its agent addressable independently', () => {
  expect(workbenchScope('first%2Fsecond')).toBe('first/second');
  expect(workbenchSessionPath('first/second', 'session?one')).toBe('/coding/first%2Fsecond?session=session%3Fone');
});
