import { ArrowUpRight, Check, Cpu, Database, Layers, Pause, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { Snapshot } from '../client/types';
import type { HostStatus } from './hostStatus';
import { observedTime } from './hostStatus';

export function HostView({ snapshot, status, observedAt, workObservedAt, workError, reconnect, navigate }: {
  snapshot: Snapshot; status: HostStatus; observedAt: number | null; workObservedAt: number | null;
  workError: string; reconnect(): void; navigate(path: string): void;
}) {
  const authority = snapshot.lifetime_authority;
  const current = status.state === 'connected';
  const capabilities = [
    { title: '문서', supported: snapshot.capabilities.documents === true, Icon: Layers, path: '/spaces' },
    { title: '기억', supported: snapshot.capabilities.memory === true, Icon: Database, path: '/lifetime' },
    { title: '도구 승인', supported: snapshot.capabilities.integration_approvals === true, Icon: ShieldCheck, path: '/integrations' },
  ];
  return <div className="page-content host-page">
    <div className="page-heading"><h1>호스트</h1><button className="button secondary" disabled={status.state === 'connecting'} onClick={reconnect}><RefreshCw size={15}/>연결 확인</button></div>
    <section className="host-summary"><div className="host-summary-icon"><Server size={30}/></div><div><h2>Ghost Host</h2><p>대화와 작업을 보관하는 실행 호스트</p></div><span className="dashboard-status" data-state={status.state}><i/>{status.label}</span></section>
    {!current && status.state !== 'demo' && <p className="dashboard-read-warning" role="status">마지막으로 확인한 설정입니다. 연결을 확인하면 현재 상태를 다시 읽습니다.</p>}
    <div className="host-grid">
      <section className="host-panel"><h2>실행 상태</h2><dl className="host-facts">
        <div><dt>작업실 연결</dt><dd>{status.label}</dd></div>
        <div><dt>마지막 조회</dt><dd>{observedTime(observedAt)}</dd></div>
        <div><dt>작업 원장 조회</dt><dd>{authority ? workError ? '갱신 실패' : observedTime(workObservedAt) : '기존 작업실'}</dd></div>
        <div><dt>새 작업 접수</dt><dd>{authority ? <><span className="host-inline-icon">{authority.dispatch_enabled ? <Check size={14}/> : <Pause size={14}/>}</span>{authority.dispatch_enabled ? '허용' : '중지'}</> : '상태 제공 안 함'}</dd></div>
        <div><dt>나의 Ghost</dt><dd>{snapshot.profiles.length}</dd></div>
      </dl><p className="field-help">접수 허용은 실행 정책입니다. 모델과 도구의 실제 실행 결과는 작업에서 확인합니다.</p><button className="text-button" onClick={() => navigate(authority ? '/lifetime?panel=work&scope=all' : '/work')}>작업 확인<ArrowUpRight size={14}/></button></section>
      <section className="host-panel"><h2>모델과 확장</h2><button className="host-link-row" onClick={() => navigate('/providers')}><Cpu size={19}/><span><strong>프로바이더 연결</strong><small>사용할 모델과 인증 설정</small></span><ArrowUpRight size={16}/></button><button className="host-link-row" onClick={() => navigate('/integrations')}><Layers size={19}/><span><strong>확장 관리</strong><small>패키지, 도구 권한, 휴대폰 연결</small></span><ArrowUpRight size={16}/></button></section>
    </div>
    <section className="host-capabilities"><div className="section-heading"><h2>호스트 기능</h2><span className="field-help">Host가 보고한 지원 여부</span></div><div>{capabilities.map(({title,supported,Icon,path}) => <button key={title} onClick={() => navigate(path)} disabled={!supported}><Icon size={19}/><strong>{title}</strong><span>{supported ? '지원' : '미지원'}</span><ArrowUpRight size={14}/></button>)}</div><p className="field-help">기능 지원과 Ghost별 실행 권한은 별개입니다.</p></section>
    <details className="host-diagnostics"><summary>연결 정보</summary><dl className="host-facts"><div><dt>작업실 ID</dt><dd><code>{snapshot.workspace_id}</code></dd></div><div><dt>실행 권한 판본</dt><dd>{authority?.authority_epoch ?? '제공 안 함'}</dd></div><div><dt>전송 모드</dt><dd>{status.state === 'demo' ? '브라우저 예시' : '인증된 Host 연결'}</dd></div></dl></details>
  </div>;
}
