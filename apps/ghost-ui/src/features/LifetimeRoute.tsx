import { useMemo } from 'react';
import { LifetimeView } from '../lifetime/LifetimeView';
import { createLiveLifetimeClient } from '../lifetime/client';
import type { AuthenticatedControlAction } from '../lifetime/controlTransport';
import type { Command, LifetimeHostAuthority, Review } from '../client/types';

export function LifetimeRoute({ action, memoryAction, workspaceId, authority, mode, documentReviews, documentAuthorityEpoch, onOpenDocumentReview, route = '/lifetime', legacyGhostIDs, onOpenHistory }: {
  action: AuthenticatedControlAction;
  /** Workspace Owner action (CSRF + envelope journal) for the Owner memory source review surface. */
  memoryAction?: (command: Command) => Promise<Record<string, any>>;
  workspaceId: string;
  authority?: LifetimeHostAuthority;
  mode: 'demo' | 'live';
  documentReviews?: Review[];
  documentAuthorityEpoch?: number;
  onOpenDocumentReview?: (review: Review) => void;
  route?: string;
  legacyGhostIDs?: string[];
  onOpenHistory?: (ghostID: string) => void;
}) {
  const session = useMemo(() => {
    if (mode !== 'live') return { error: '주 Ghost 대화는 연결된 호스트에서 사용할 수 있습니다.' };
    if (!authority) return { error: '호스트의 현재 실행 권한을 확인하지 못했습니다. 저장된 요청은 다시 전송하지 않습니다.' };
    try {
      const client = createLiveLifetimeClient(action, {
        workspace_id: workspaceId, actor_ref: 'owner',
        authority_epoch: authority.authority_epoch, dispatch_enabled: authority.dispatch_enabled,
      });
      return { client };
    } catch {
      return { error: '접수 ID와 재시도 큐를 저장하지 못했습니다. 브라우저 저장 권한을 확인하세요.' };
    }
  }, [action, workspaceId, authority?.authority_epoch, authority?.dispatch_enabled, mode]);
  if ('error' in session) return <div className="page-content" role="alert">{session.error}</div>;
  return <LifetimeView mode="live" client={session.client} memoryAction={memoryAction}
    legacyGhostIDs={legacyGhostIDs} onOpenHistory={onOpenHistory}
    initialGhostID={new URLSearchParams(route.split('?')[1] ?? '').get('ghost') ?? undefined}
    createRequested={new URLSearchParams(route.split('?')[1] ?? '').get('create') === '1'}
    documentReviews={documentReviews}
    documentAuthorityEpoch={documentAuthorityEpoch ?? authority?.authority_epoch}
    onOpenDocumentReview={onOpenDocumentReview}/>;
}
