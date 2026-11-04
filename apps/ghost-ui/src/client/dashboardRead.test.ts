import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '../lifetime/protocol';
import { readDashboardLifetime } from './dashboardRead';
import type { Envelope } from './types';

async function lifetimeCommand(body: Record<string, unknown>, type = 'lifetime'): Promise<Envelope> {
  const wire = await createEnvelope(body, { actor_ref: 'owner', authority_epoch: 2 });
  return { request_id: 'dashboard-request', command: { type, envelope: wire } };
}

describe('dashboard Host read boundary', () => {
  it('rejects Lifetime mutations and non-Lifetime commands before sending anything to the client', async () => {
    const action = vi.fn();
    const live = { mode: 'live' as const, action };
    const submit = await lifetimeCommand({
      method: 'goal.submit', ghost_id: 'primary', conversation_id: 'chat',
      prompt: 'Run an operation', privacy: 'local_only', acceptance_spec: {},
    });
    const cancel = await lifetimeCommand({ method: 'work.cancel', work_id: 'work-1' });
    const other = await lifetimeCommand({ method: 'snapshot' }, 'workspace');

    const unrelatedRead = await lifetimeCommand({ method: 'command.inspect' });

    for (const command of [submit, cancel, other, unrelatedRead]) {
      await expect(readDashboardLifetime(live, command)).rejects.toThrow('대시보드는 상태 조회만 허용합니다.');
    }
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['snapshot', 'registry.inspect'])('passes the original %s envelope to the live client', async method => {
    const command = await lifetimeCommand({ method });
    const response = { data: { work: [] } };
    const action = vi.fn().mockResolvedValue(response);

    await expect(readDashboardLifetime({ mode: 'live', action }, command)).resolves.toBe(response);
    expect(action).toHaveBeenCalledExactlyOnceWith(command);
  });

  it('requires a live client even for snapshot reads', async () => {
    const command = await lifetimeCommand({ method: 'snapshot' });
    const action = vi.fn();

    await expect(readDashboardLifetime(null, command)).rejects.toThrow('연결된 Ghost 호스트가 필요합니다.');
    await expect(readDashboardLifetime({ mode: 'demo', action }, command)).rejects.toThrow('연결된 Ghost 호스트가 필요합니다.');
    expect(action).not.toHaveBeenCalled();
  });
});
