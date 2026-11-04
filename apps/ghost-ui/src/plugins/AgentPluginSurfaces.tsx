import { DetailDialog } from '../components/DetailDialog';
import { useState } from 'react';
import { ArrowUpRight, Puzzle } from 'lucide-react';
import type { Snapshot } from '../client/types';
import { approvalKey, approvals, approvalState, approvalTitle, type ApprovalRef } from './approvals';
import { installedPlugins, pluginAvailable, pluginEnabled, usePluginPreferences } from './registry';
import './plugins.css';

export function AgentPluginSurfaces({ snapshot, ghostId, definitionVersion, workspaceKey, onOpenApproval }: {
  snapshot: Snapshot;
  ghostId: string;
  definitionVersion?: string | number;
  workspaceKey: string;
  onOpenApproval: (ref: ApprovalRef) => void;
}) {
  const { bindings, setEnabled } = usePluginPreferences(workspaceKey, ghostId);
  const [error, setError] = useState(false);
  const items = approvals(snapshot).filter(item => item.ghostId === ghostId);
  const available = installedPlugins.filter(plugin => pluginAvailable(plugin, snapshot, ghostId));
  return <section className="ghost-plugin-surfaces" aria-label="검토 플러그인">
    {available.filter(plugin => pluginEnabled(plugin, bindings, definitionVersion)).map(plugin => {
      const rows = items.filter(item => item.kind === plugin.reviewKind);
      return <section key={plugin.id} className="ghost-plugin-panel" aria-label={plugin.agentPanel}>
        <h3>{plugin.agentPanel}</h3>
        {rows.length === 0 ? <p className="muted">검토 기록 없음</p> : <ul className="ghost-plugin-list">
          {rows.map(item => <li key={approvalKey(item)}>
            <button type="button" className="text-button" onClick={() => onOpenApproval({ kind: item.kind, id: item.id })}>
              <span>{approvalTitle(item)}</span><span className="muted">{approvalState(item)}</span><ArrowUpRight size={14}/>
            </button>
          </li>)}
        </ul>}
      </section>;
    })}
    <DetailDialog title="플러그인 관리" label={<><Puzzle size={15}/>플러그인 관리</>} className="ghost-plugin-settings">
      <p className="muted">이 Ghost에 표시할 검토 화면을 선택합니다.</p>
      {installedPlugins.map(plugin => {
        const supported = pluginAvailable(plugin, snapshot, ghostId);
        return <label className="checkbox-row" key={plugin.id}>
          <input type="checkbox" disabled={!supported} checked={supported && pluginEnabled(plugin, bindings, definitionVersion)}
            onChange={event => {
              try { setEnabled(plugin, event.target.checked, definitionVersion); setError(false); }
              catch { setError(true); }
            }}/>
          {plugin.label}
        </label>;
      })}
      {error && <p className="inline-error" role="alert">화면 설정을 저장하지 못했습니다.</p>}
    </DetailDialog>
  </section>;
}
