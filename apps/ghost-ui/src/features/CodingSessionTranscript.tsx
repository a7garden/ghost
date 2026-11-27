import { memo, useMemo, type ReactNode } from 'react';
import { CircleAlert, GitFork } from 'lucide-react';
import type { CodingDialog, CodingImage, CodingItem, CodingSession, CodingToolStatus } from '@ghost/contract';
import { StateGlyph, type GlyphState } from '../components/agent/StateGlyph';
import { MessageBody } from '../components/MessageBody';
import { codingApprovalToolId, codingToolSummary, groupCodingItems, type CodingActivity, type CodingToolItem } from './CodingSessionModel';
import { CodingSessionPreview } from './CodingSessionPreview';
import { DiffText } from './DiffText';

const states: Record<CodingSession['state'], [GlyphState, string]> = {
  idle: ['queued', '대기'], working: ['running', '작업 중'], waiting: ['attention', '응답 필요'],
  failed: ['failed', '실패'], closed: ['cancelled', '닫힘'],
};

export function EmbeddedSessionState({ state, label = true }: { state: CodingSession['state']; label?: boolean }) {
  const [glyph, description] = states[state];
  return <StateGlyph size={15} state={glyph} mark="ring" label={label} accessibleLabel={description}/>;
}

type StepStatus = CodingToolStatus | 'approval';
const toolGlyph: Record<StepStatus, GlyphState> = { running: 'running', done: 'done', error: 'failed', approval: 'attention' };
const toolLabel: Record<StepStatus, string> = { running: '실행 중', done: '완료', error: '실패', approval: '승인 대기' };

function StepState({ status }: { status: StepStatus }) {
  return <StateGlyph size={15} state={toolGlyph[status]} accessibleLabel={toolLabel[status]}/>;
}

function Step({ summary, children, status }: { summary: ReactNode; children?: ReactNode; status: StepStatus }) {
  return children ? <details className="embedded-step" data-status={status}>
    <summary className="embedded-step__row">{summary}</summary>
    <div className="embedded-step__body">{children}</div>
  </details> : <div className="embedded-step embedded-step__row" data-status={status}>{summary}</div>;
}

function Images({ id, images }: { id: string; images: CodingImage[] }) {
  if (!images.length) return null;
  return <div className="embedded-images">
    {images.map((image, index) => <CodingSessionPreview key={`${image.path}:${index}`} id={id} path={image.path} label={image.label ?? image.path.split('/').at(-1) ?? '이미지'} kind="image"/>) }
  </div>;
}

const ToolRow = memo(function ToolRow({ id, item, approval }: { id: string; item: CodingToolItem; approval: boolean }) {
  const diff = item.diff ?? ((item.tool === 'edit' || item.tool === 'write') && /^(?:diff --git |--- |@@ )/m.test(item.output) ? item.output : '');
  const output = diff === item.output ? '' : item.output;
  const status = approval ? 'approval' : item.status;
  const summary = item.summary || item.tool;
  return <Step status={status} summary={<>
    <StepState status={status}/>
    <code className="embedded-step__title" title={summary}>{summary}</code>
    {status !== 'done' && <span className="embedded-step__state" aria-hidden="true">{toolLabel[status]}</span>}
  </>}>
    {(diff || output || item.images.length > 0) ? <>
      {diff && <DiffText value={diff}/>}
      {output && <pre className="embedded-tool-output" tabIndex={0} aria-label="도구 출력">{output}</pre>}
      <Images id={id} images={item.images}/>
    </> : null}
  </Step>;
});

function ToolRun({ id, tools, approvalId }: { id: string; tools: CodingToolItem[]; approvalId?: string }) {
  let running = 0;
  let failed = 0;
  let approval = false;
  for (const tool of tools) {
    if (tool.id === approvalId) approval = true;
    else if (tool.status === 'running') running++;
    else if (tool.status === 'error') failed++;
  }
  return <details className="embedded-tool-run">
    <summary>
      <span className="embedded-tool-run__summary">{codingToolSummary(tools)}</span>
      {(approval || failed > 0 || running > 0) && <span className="embedded-tool-run__states">
        {approval && <StateGlyph size={14} state="attention" label accessibleLabel={toolLabel.approval}/>}
        {failed > 0 && <StateGlyph size={14} state="failed" label accessibleLabel={`실패 ${failed}`}/>}
        {running > 0 && <StateGlyph size={14} state="running" label accessibleLabel={`실행 중 ${running}`}/>}
      </span>}
    </summary>
    <ol className="embedded-tool-rows">
      {tools.map(tool => <li key={tool.id}><ToolRow id={id} item={tool} approval={tool.id === approvalId}/></li>)}
    </ol>
  </details>;
}

function Thinking({ item }: { item: Extract<CodingActivity, { kind: 'thinking' }> }) {
  return <details className="embedded-thinking" data-kind="thinking">
    <summary>{item.streaming ? '생각 중' : '생각 과정'}</summary>
    <p className="embedded-literal">{item.text}</p>
  </details>;
}

function ActivityTrail({ id, entries, subagentTools, approvalId }: {
  id: string; entries: CodingActivity[]; subagentTools: Map<string, CodingToolItem[]>; approvalId?: string;
}) {
  return <div data-kind="trail" className="embedded-activity">
    {entries.map(entry => {
      if (entry.kind === 'thinking') return <Thinking key={entry.id} item={entry}/>;
      if (entry.kind === 'tools') return <ToolRun key={entry.id} id={id} tools={entry.tools} approvalId={approvalId}/>;
      const tools = subagentTools.get(entry.id);
      return <Step key={entry.id} status={entry.status} summary={<>
        <GitFork size={15} aria-hidden="true"/>
        <span className="embedded-step__copy">
          <strong className="embedded-step__title">{entry.role}</strong>
          <span className="embedded-step__task">{entry.task}</span>
        </span>
        {entry.status === 'done' ? <StepState status="done"/>
          : <StateGlyph size={14} state={toolGlyph[entry.status]} label accessibleLabel={toolLabel[entry.status]}/>}
      </>}>
        {(entry.summary || tools?.length) ? <>
          {entry.summary && <p className="embedded-literal">{entry.summary}</p>}
          {tools && <ol className="embedded-tool-rows embedded-agent-branch">
            {tools.map(tool => <li key={tool.id}><ToolRow id={id} item={tool} approval={tool.id === approvalId}/></li>)}
          </ol>}
        </> : null}
      </Step>;
    })}
  </div>;
}

export function CodingSessionTranscript({ id, items, approval }: {
  id: string; items: readonly CodingItem[]; approval?: CodingDialog['tool'];
}) {
  const { rows, subagentTools } = useMemo(() => groupCodingItems(items), [items]);
  const approvalId = codingApprovalToolId(items, approval);
  return <>{rows.map(item => {
    switch (item.kind) {
      case 'user': return <article key={item.id} data-role="user" aria-label="내 지시" className="embedded-user" data-rail="muted" data-rail-label={item.text || '이미지'}>
        {item.text && <p>{item.text}</p>}<Images id={id} images={item.images}/>
      </article>;
      case 'assistant': return <article key={item.id} data-role="assistant" aria-label="에이전트 응답" className="embedded-reply ghost-conversation-message__content">
        <MessageBody text={item.text} streaming={item.streaming}/>
      </article>;
      case 'thinking': return <Thinking key={item.id} item={item}/>;
      case 'activity': return <ActivityTrail key={`activity:${item.id}`} id={id} entries={item.entries} subagentTools={subagentTools} approvalId={approvalId}/>;
      case 'notice': return <p key={item.id} className="embedded-notice" role={item.level === 'error' ? 'alert' : 'status'} data-level={item.level}>
        <CircleAlert size={16} aria-hidden="true"/>{item.text}
      </p>;
    }
  })}</>;
}
