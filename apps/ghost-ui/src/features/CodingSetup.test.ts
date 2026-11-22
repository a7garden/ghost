import { describe, expect, it } from 'vitest';
import type { CodingSetup } from '@ghost/contract';
import { codingChecklist } from './CodingSetup';

const ready: CodingSetup = {
  herdr: { path: '/bin/herdr', version: '1.4.0' }, config: { ok: true, note: null }, session: 'default',
  sessions: [{ name: 'default', running: true }], server: { version: '1.4.0', compatible: true, restartNeeded: false },
  agents: [{ id: 'omp', name: 'omp', path: '/bin/omp', integration: 'current' }], prefs: { session: null, agent: null },
  kinds: ['omp'],
};

describe('herdr setup checklist', () => {
  it('lists connection problems in the order to fix them and only offers other running sessions', () => {
    const checklist = codingChecklist({
      ...ready, herdr: { path: null, version: null }, config: { ok: false, note: 'config.toml: invalid key' }, server: null,
      sessions: [{ name: 'default', running: false }, { name: 'studio', running: true }, { name: 'archive', running: false }],
    });
    expect(checklist.connection).toEqual([
      { id: 'herdr', status: 'missing' }, { id: 'config', status: 'invalid' }, { id: 'server', status: 'stopped' },
    ]);
    expect(checklist.required).toBe(true);
    expect(checklist.alternateSessions.map(session => session.name)).toEqual(['studio']);
  });

  it.each([{ compatible: true, restartNeeded: true }, { compatible: false, restartNeeded: false }])
  ('asks for a restart when the connected server must restart or is incompatible', flags => {
    const checklist = codingChecklist({
      ...ready, server: { version: '1.3.0', ...flags }, sessions: [...ready.sessions, { name: 'studio', running: true }],
    });
    expect(checklist.connection[2].status).toBe('restart');
    expect(checklist.required).toBe(true);
    expect(checklist.alternateSessions).toEqual([]);
  });

  it('distinguishes missing apps from missing or outdated optional integrations', () => {
    const checklist = codingChecklist({ ...ready, agents: [
      { id: 'omp', name: 'omp', path: null, integration: 'current' },
      { id: 'claude', name: 'Claude Code', path: '/bin/claude', integration: 'missing' },
      { id: 'codex', name: 'Codex', path: '/bin/codex', integration: 'outdated' },
    ] });
    expect(checklist.agents.map(agent => agent.status)).toEqual(['missing', 'unlinked', 'outdated']);
    expect(checklist.required).toBe(false);
    expect(checklist.optional).toBe(true);
  });

  it('has no checklist to show on the Coding page once all rows are ready', () => {
    expect(codingChecklist(ready)).toMatchObject({ required: false, optional: false });
  });
});
