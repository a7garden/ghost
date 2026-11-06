import { DetailDialog } from '../components/DetailDialog';
import { useState } from 'react';
import { ArrowUpRight, Puzzle } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, InlineError } from '@garden/ui';
import type { Snapshot } from '../client/types';
import { approvalKey, approvals, approvalState, approvalTitle, type ApprovalRef } from './approvals';
import { installedPlugins, pluginAvailable, pluginEnabled, usePluginPreferences } from './registry';

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
  return <section className="grid min-w-0 gap-4" aria-label="검토 플러그인">
    {available.filter(plugin => pluginEnabled(plugin, bindings, definitionVersion)).map(plugin => {
      const rows = items.filter(item => item.kind === plugin.reviewKind);
      return <Card key={plugin.id} className="gap-2">
        <CardHeader>
          <CardTitle className="text-ui font-semibold text-ink">{plugin.agentPanel}</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? <p className="text-ui text-ink-2">검토 기록 없음</p> : <ul className="m-0 grid list-none gap-2 p-0">
            {rows.map(item => <li key={approvalKey(item)}>
              <Button variant="ghost" type="button" className="h-auto w-full max-w-full justify-start whitespace-normal text-left"
                onClick={() => onOpenApproval({ kind: item.kind, id: item.id })}>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{approvalTitle(item)}</span>
                <span className="text-caption text-ink-2">{approvalState(item)}</span>
                <ArrowUpRight size={14} aria-hidden="true"/>
              </Button>
            </li>)}
          </ul>}
        </CardContent>
      </Card>;
    })}
    <DetailDialog title="플러그인 관리" label={<><Puzzle size={15} aria-hidden="true"/>플러그인 관리</>}>
      <p>이 Ghost에 표시할 검토 화면을 선택합니다.</p>
      {installedPlugins.map(plugin => {
        const supported = pluginAvailable(plugin, snapshot, ghostId);
        const controlId = `plugin-surface-${plugin.id}`;
        return <div key={plugin.id} className="flex items-center gap-2">
          <Checkbox id={controlId} disabled={!supported} aria-labelledby={`${controlId}-label`}
            checked={supported && pluginEnabled(plugin, bindings, definitionVersion)}
            onCheckedChange={value => {
              try { setEnabled(plugin, value === true, definitionVersion); setError(false); }
              catch { setError(true); }
            }}/>
          <label id={`${controlId}-label`} htmlFor={controlId} className="text-ink">{plugin.label}</label>
        </div>;
      })}
      {error && <InlineError>화면 설정을 저장하지 못했습니다.</InlineError>}
    </DetailDialog>
  </section>;
}
