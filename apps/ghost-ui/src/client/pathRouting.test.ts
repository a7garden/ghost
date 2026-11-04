import { describe, expect, it } from 'vitest';
import { pathToHash } from './pathRouting';

describe('pathToHash', () => {
  it('maps known section paths to hash routes', () => {
    expect(pathToHash('/spaces/space-ghost')).toBe('/spaces/space-ghost');
    expect(pathToHash('/ghosts/sage')).toBe('/ghosts/sage');
    expect(pathToHash('/work')).toBe('/work');
    expect(pathToHash('/integrations')).toBe('/integrations');
    expect(pathToHash('/settings')).toBe('/settings');
    expect(pathToHash('/host')).toBe('/host');
    expect(pathToHash('/providers')).toBe('/providers');
  });

  it('passes legacy planner URLs to the app for Work redirection', () => {
    expect(pathToHash('/planner')).toBe('/planner');
    expect(pathToHash('/planner/?date=2026-11-04')).toBe('/planner');
  });

  it('preserves nested ids and query strings', () => {
    expect(pathToHash('/ghosts/sage?conversation=c1')).toBe('/ghosts/sage?conversation=c1');
    expect(pathToHash('/settings?tab=appearance&ghost=sage')).toBe('/settings?tab=appearance&ghost=sage');
  });

  it('collapses trailing slashes and repeated separators', () => {
    expect(pathToHash('/work/')).toBe('/work');
    expect(pathToHash('/spaces/space-notes///')).toBe('/spaces/space-notes');
  });

  it('returns null for root and unknown sections so default boot stays intact', () => {
    expect(pathToHash('/')).toBeNull();
    expect(pathToHash('')).toBeNull();
    expect(pathToHash('/src/main.tsx')).toBeNull();
    expect(pathToHash('/bogus')).toBeNull();
  });

  it('does not invent a section when the id is missing', () => {
    expect(pathToHash('/spaces')).toBe('/spaces');
  });
});
