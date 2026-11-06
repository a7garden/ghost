import { useId } from 'react';
import { DetailDialog } from '../components/DetailDialog';
import { Badge, Banner, Button, GSettingsGroup, GSettingsRow } from '@garden/ui';
import { ArrowUpRight, Check, Cpu, Database, Layers, Pause, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { Snapshot } from '../client/types';
import type { HostStatus } from './hostStatus';
import { observedTime } from './hostStatus';

const stateBadge: Record<HostStatus['state'], 'default' | 'success' | 'warning' | 'danger' | 'outline'> = {
  demo: 'default', connecting: 'default', connected: 'success', stale: 'warning', offline: 'danger',
};

export function HostView({ snapshot, status, observedAt, workObservedAt, workError, reconnect, navigate }: {
  snapshot: Snapshot; status: HostStatus; observedAt: number | null; workObservedAt: number | null;
  workError: string; reconnect(): void; navigate(path: string): void;
}) {
  const authority = snapshot.lifetime_authority;
  const current = status.state === 'connected';
  const workId = useId(), modelsId = useId(), extensionsId = useId(), capabilityId = useId();
  const capabilities = [
    { title: '문서', supported: snapshot.capabilities.documents === true, Icon: Layers, path: '/spaces' },
    { title: '기억', supported: snapshot.capabilities.memory === true, Icon: Database, path: '/lifetime' },
    { title: '도구 승인', supported: snapshot.capabilities.integration_approvals === true, Icon: ShieldCheck, path: '/settings?tab=extensions' },
  ];
  return <div className="flex min-w-0 flex-col gap-6">
    <GSettingsGroup title="호스트" description={status.state === 'demo' ? '브라우저에 저장되는 예시 데이터로 화면을 둘러볼 수 있습니다.' : '대화와 작업을 보관하는 실행 호스트'}>
      <GSettingsRow label={<span className="inline-flex items-center gap-2"><Server size={16} aria-hidden="true"/>Ghost Host</span>}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Badge variant={stateBadge[status.state]}>{status.label}</Badge>
          <Button type="button" variant="outline" disabled={status.state === 'connecting'} onClick={reconnect}><RefreshCw size={14}/>연결 확인</Button>
        </div>
      </GSettingsRow>
    </GSettingsGroup>
    {!current && status.state !== 'demo' && <Banner variant="warning">마지막으로 확인한 설정입니다. 연결을 확인하면 현재 상태를 다시 읽습니다.</Banner>}
    <GSettingsGroup title="실행 상태" description="접수 허용은 실행 정책입니다. 모델과 도구의 실제 실행 결과는 작업에서 확인합니다.">
      <GSettingsRow label="작업실 연결">{status.label}</GSettingsRow>
      <GSettingsRow label="마지막 조회">{observedTime(observedAt)}</GSettingsRow>
      <GSettingsRow label="작업 원장 조회">{authority ? (workError ? '갱신 실패' : observedTime(workObservedAt)) : '기존 작업실'}</GSettingsRow>
      <GSettingsRow label="새 작업 접수">{authority
        ? <span className="inline-flex items-center gap-1.5">{authority.dispatch_enabled ? <Check size={14} aria-hidden="true"/> : <Pause size={14} aria-hidden="true"/>}{authority.dispatch_enabled ? '허용' : '중지'}</span>
        : '상태 제공 안 함'}</GSettingsRow>
      <GSettingsRow label="나의 Ghost">{snapshot.profiles.length}</GSettingsRow>
      <GSettingsRow label="작업 확인" htmlFor={workId}>
        <Button id={workId} type="button" variant="ghost" onClick={() => navigate(authority ? '/lifetime?panel=work&scope=all' : '/work')}><ArrowUpRight size={14} aria-hidden="true"/></Button>
      </GSettingsRow>
    </GSettingsGroup>
    <GSettingsGroup title="모델과 확장">
      <GSettingsRow label={<span className="inline-flex items-center gap-2"><Cpu size={16} aria-hidden="true"/>프로바이더 연결</span>} description="사용할 모델과 인증 설정" htmlFor={modelsId}>
        <Button id={modelsId} type="button" variant="ghost" onClick={() => navigate('/settings?tab=models')}><ArrowUpRight size={14} aria-hidden="true"/></Button>
      </GSettingsRow>
      <GSettingsRow label={<span className="inline-flex items-center gap-2"><Layers size={16} aria-hidden="true"/>확장 관리</span>} description="패키지, 도구 권한, 휴대폰 연결" htmlFor={extensionsId}>
        <Button id={extensionsId} type="button" variant="ghost" onClick={() => navigate('/settings?tab=extensions')}><ArrowUpRight size={14} aria-hidden="true"/></Button>
      </GSettingsRow>
    </GSettingsGroup>
    <GSettingsGroup title="호스트 기능" description="Host가 보고한 지원 여부">
      {capabilities.map(({ title, supported, Icon, path }) => <GSettingsRow key={title}
        label={<span className="inline-flex items-center gap-2"><Icon size={16} aria-hidden="true"/>{title}</span>} htmlFor={`${capabilityId}-${title}`}>
        <div className="flex items-center gap-2">
          <Badge variant={supported ? 'default' : 'outline'}>{supported ? '지원' : '미지원'}</Badge>
          <Button id={`${capabilityId}-${title}`} type="button" variant="ghost" disabled={!supported} onClick={() => navigate(path)}><ArrowUpRight size={14} aria-hidden="true"/></Button>
        </div>
      </GSettingsRow>)}
      <p className="px-4 pb-3 text-caption text-ink-2">기능 지원과 Ghost별 실행 권한은 별개입니다.</p>
    </GSettingsGroup>
    <DetailDialog title="연결 정보">
      <dl className="m-0 flex min-w-0 flex-col gap-2 text-ui">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <dt className="text-ink-2">작업실 ID</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]"><code>{snapshot.workspace_id}</code></dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <dt className="text-ink-2">실행 권한 판본</dt>
          <dd className="min-w-0">{authority?.authority_epoch ?? '제공 안 함'}</dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <dt className="text-ink-2">전송 모드</dt>
          <dd className="min-w-0">{status.state === 'demo' ? '브라우저 예시' : '인증된 Host 연결'}</dd>
        </div>
      </dl>
    </DetailDialog>
  </div>;
}
