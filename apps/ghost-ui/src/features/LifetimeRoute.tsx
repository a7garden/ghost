import { useMemo } from 'react';
import { LifetimeView } from '../lifetime/LifetimeView';
import { createLiveLifetimeClient } from '../lifetime/client';
import type { AuthenticatedControlAction } from '../lifetime/controlTransport';
import type { ApprovalRef } from '../plugins/approvals';
import type { Command, LifetimeHostAuthority, Review, Snapshot } from '../client/types';

export function LifetimeRoute({ action, memoryAction, workspaceId, authority, mode, connected = true, active = true, documentReviews, documentAuthorityEpoch, onOpenDocumentReview, route = '/lifetime', onOpenHistory, snapshot, onOpenApproval, onOpenTarget, onDefaultGhostChange, onTargetChange, authorizedRegistration, onRegistrationConsumed, navigate, handoff, onHandoffConsumed }: {
  action: AuthenticatedControlAction;
  /** Workspace Owner action (CSRF + envelope journal) for the Owner memory source review surface. */
  memoryAction?: (command: Command) => Promise<Record<string, any>>;
  workspaceId: string;
  authority?: LifetimeHostAuthority;
  mode: 'demo' | 'live';
  connected?: boolean;
  active?: boolean;
  documentReviews?: Review[];
  documentAuthorityEpoch?: number;
  onOpenDocumentReview?: (review: Review) => void;
  route?: string;
  snapshot?: Snapshot;
  onOpenApproval?: (ref: ApprovalRef) => void;
  onOpenTarget?: (ghostID: string, conversationID: string, preserveWorkRoute?: boolean) => void;
  onDefaultGhostChange?: (ghostID: string | null) => void;
  onTargetChange?: (ghostID: string | null) => void;
  authorizedRegistration?: { ghostID: string; conversationID: string };
  onRegistrationConsumed?: (ghostID: string, conversationID: string) => void;
  navigate?: (path: string) => void;
  onOpenHistory?: (ghostID: string) => void;
  handoff?: { id: string; text: string };
  onHandoffConsumed?: (id: string) => void;
}) {
  const session = useMemo(() => {
    if (mode !== 'live') return { error: 'Ghost 대화는 연결된 호스트에서 사용할 수 있습니다.' };
    if (!authority) return { error: '호스트의 현재 실행 권한을 확인하지 못했습니다. 저장된 요청은 다시 전송하지 않습니다.' };
    try {
      const client = createLiveLifetimeClient(action, {
        workspace_id: workspaceId, actor_ref: 'owner',
        authority_epoch: authority.authority_epoch, dispatch_enabled: authority.dispatch_enabled,
      });
      return { client };
    } catch (error) {
      // 저장 권한 외에도 workspace/owner 검증 실패가 있다. 원인을 덧붙여 운영자가
      // 구분할 수 있게 한다.
      const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
      return { error: `접수 ID와 재시도 큐를 준비하지 못했습니다. 브라우저 저장 권한을 확인하세요.${detail}` };
    }
  }, [action, workspaceId, authority?.authority_epoch, authority?.dispatch_enabled, mode]);
  if ('error' in session) return <div className="page-content" role="alert">{session.error}</div>;
  const params = new URLSearchParams(route.split('?')[1] ?? '');
  const panel = params.get('panel');
  return <LifetimeView mode="live" client={session.client} connected={connected} active={active} memoryAction={memoryAction}
    onOpenHistory={onOpenHistory} handoff={handoff} onHandoffConsumed={onHandoffConsumed}
    initialGhostID={params.get('ghost') ?? undefined}
    initialConversationID={params.get('conversation') ?? undefined}
    initialRegisterConversationID={params.get('register') ?? undefined}
    initialGoalID={params.get('goal') ?? undefined}
    initialWorkID={params.get('work') ?? undefined}
    workScope={params.get('scope') === 'all' ? 'all' : 'conversation'}
    initialPanel={panel === 'work' || panel === 'ghosts' ? panel : 'conversation'}
    onPanelChange={navigate ? next => {
      params.delete('create');
      if (next === 'conversation') params.delete('panel');
      else params.set('panel', next);
      if (next !== 'work') { params.delete('scope'); params.delete('goal'); params.delete('work'); }
      navigate(params.size ? `/lifetime?${params}` : '/lifetime');
    } : undefined}
    onOpenTarget={onOpenTarget}
    onDefaultGhostChange={onDefaultGhostChange}
    onTargetChange={onTargetChange}
    authorizedRegistration={authorizedRegistration}
    onRegistrationConsumed={onRegistrationConsumed}
    onClearWorkLink={navigate ? () => {
      const next = new URLSearchParams(route.split('?')[1] ?? '');
      next.delete('goal'); next.delete('work');
      navigate(next.size ? `/lifetime?${next}` : '/lifetime');
    } : undefined}
    createRequested={params.get('create') === '1'}
    workspaceSnapshot={snapshot} onOpenApproval={onOpenApproval}
    documentReviews={documentReviews}
    documentAuthorityEpoch={documentAuthorityEpoch ?? authority?.authority_epoch}
    onOpenDocumentReview={onOpenDocumentReview}/>;
}
