import type { Client, Envelope } from './types';

export async function readDashboardLifetime(client: Pick<Client, 'mode' | 'action'> | null, envelope: Envelope): Promise<unknown> {
  const wire = envelope.command.envelope as { body?: { method?: string } } | undefined;
  if (envelope.command.type !== 'lifetime' || (wire?.body?.method !== 'snapshot' && wire?.body?.method !== 'registry.inspect')) {
    throw new Error('대시보드는 상태 조회만 허용합니다.');
  }
  if (client?.mode !== 'live') throw new Error('연결된 Ghost 호스트가 필요합니다.');
  return client.action(envelope);
}
